import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { audit, isPlatformOwner, requireAdminMfa, requireVerified, requireWorkspace, type Principal } from './access'
import { rows, transaction, type Database } from './db'
import { requireValue, ServiceError } from './errors'
import { sealSecret } from './crypto'
import { getConfig } from './config'

const roleInput = z.enum(['owner', 'admin', 'billing', 'support'])
const inviteInput = z.object({ email: z.string().trim().toLowerCase().email().max(320), role: roleInput }).strict()
const tokenInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const unavailable = () => new ServiceError(404, 'invalid_invitation', 'This workspace invitation is unavailable. Check your email or ask the owner for a new invitation.')

async function ownsWorkspace(actor: Principal, workspaceId: string, db?: Database) {
  return await isPlatformOwner(actor, db) || (await rows("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'", [workspaceId, actor.userId], db)).length > 0
}
async function lockWorkspace(workspaceId: string, db: Database) {
  return requireValue((await rows('SELECT * FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId], db))[0])
}
async function requireOwner(actor: Principal, workspaceId: string, db: Database) {
  // Serialise owner changes before checking permission, including the acting owner's role.
  const workspace = await lockWorkspace(workspaceId, db)
  await requireWorkspace(actor, workspaceId, 'manage', db)
  if (!await ownsWorkspace(actor, workspaceId, db)) throw new ServiceError(403, 'owner_required', 'Only a workspace owner can manage staff access.')
  return workspace
}
export async function workspaceStaff(actor: Principal, workspaceId: string) {
  await requireWorkspace(actor, workspaceId, 'manage')
  const members = await rows(`SELECT m.user_id,m.role,m.joined_at,u.name,u.email FROM workspace_members m
    JOIN auth_user u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name,u.email`, [workspaceId])
  const invitations = await rows(`SELECT id,email,role,created_at,expires_at,accepted_at,revoked_at FROM workspace_invitations
    WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 200`, [workspaceId])
  return { members, invitations, canManage: await ownsWorkspace(actor, workspaceId) }
}
export async function inviteWorkspaceStaff(actor: Principal, workspaceId: string, input: unknown) {
  const value = inviteInput.parse(input)
  return transaction(async db => {
    const workspace = await requireOwner(actor, workspaceId, db)
    if ((await rows('SELECT 1 FROM workspace_members m JOIN auth_user u ON u.id=m.user_id WHERE m.workspace_id=$1 AND lower(u.email)=$2', [workspaceId, value.email], db)).length) {
      throw new ServiceError(409, 'already_member', 'This person is already on the workspace team. Change their role instead.')
    }
    await db.query('UPDATE workspace_invitations SET revoked_at=now() WHERE workspace_id=$1 AND lower(email)=$2 AND accepted_at IS NULL AND revoked_at IS NULL', [workspaceId, value.email])
    const token = randomBytes(32).toString('base64url')
    const invitation = (await rows(`INSERT INTO workspace_invitations (workspace_id,email,role,token_hash,expires_at,created_by)
      VALUES ($1,$2,$3,$4,now()+interval '7 days',$5) RETURNING id,email,role,expires_at`, [workspaceId, value.email, value.role, hash(token), actor.userId], db))[0]!
    const link = new URL('/portal/workspace-invitation', getConfig().SIPPER_BASE_URL)
    link.hash = `token=${token}`
    const descriptions = { owner: 'manage customers, billing and workspace staff', admin: 'manage customers, calling settings and billing', billing: 'manage subscriptions, invoices and licence capacity', support: 'view customers, registration and device activity, and audit history without changing settings or billing' }
    const jobId = randomUUID()
    const payload = sealSecret(JSON.stringify({ to: value.email, subject: `Join the ${workspace.name} team on Sipper`,
      text: `You've been invited to ${workspace.name} with ${value.role} access. This allows you to ${descriptions[value.role]}.\n\nSign in with this email address, verify it and enable two-factor authentication before accepting:\n\n${link}\n\nThis invitation expires in seven days. If unexpected, ignore it.` }), `mail:${jobId}`)
    await db.query("INSERT INTO jobs (id,kind,deduplication_key,payload) VALUES ($1,'email',$2,$3)", [jobId, `workspace-invitation:${invitation.id}`, JSON.stringify(payload)])
    await audit(db, actor, workspaceId, 'workspace_invitation.created', invitation.id, undefined, { role: value.role })
    return invitation
  })
}
export async function revokeWorkspaceInvitation(actor: Principal, workspaceId: string, invitationId: string) {
  return transaction(async db => {
    await requireOwner(actor, workspaceId, db)
    requireValue((await rows('UPDATE workspace_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND id=$2 AND accepted_at IS NULL RETURNING id', [workspaceId, invitationId], db))[0])
    await audit(db, actor, workspaceId, 'workspace_invitation.revoked', invitationId)
    return { revoked: true }
  })
}
async function validInvitation(actor: Principal, token: unknown, db?: Database) {
  requireVerified(actor)
  const parsed = tokenInput.safeParse(token)
  if (!parsed.success) throw unavailable()
  const invitation = (await rows(`SELECT i.*,w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id
    WHERE i.token_hash=$1 AND lower(i.email)=$2 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()`, [hash(parsed.data), actor.email.toLowerCase()], db))[0]
  if (!invitation?.created_by || !await ownsWorkspace({ ...actor, userId: invitation.created_by }, invitation.workspace_id, db)) throw unavailable()
  return invitation
}
export async function inspectWorkspaceInvitation(actor: Principal, token: unknown) {
  const invitation = await validInvitation(actor, token)
  return { workspaceName: invitation.workspace_name, role: invitation.role, expiresAt: invitation.expires_at }
}
export async function acceptWorkspaceInvitation(actor: Principal, token: unknown) {
  requireAdminMfa(actor)
  return transaction(async db => {
    const hint = await validInvitation(actor, token, db)
    await lockWorkspace(hint.workspace_id, db)
    // Recheck after the workspace lock: replacement, revocation and acceptance share that lock.
    const invitation = await validInvitation(actor, token, db)
    const result = await rows('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id', [invitation.workspace_id, actor.userId, invitation.role], db)
    if (!result.length) throw new ServiceError(409, 'already_member', 'You already have access to this workspace. Ask its owner to change your role if needed.')
    await db.query('UPDATE workspace_invitations SET accepted_at=now() WHERE id=$1', [invitation.id])
    await audit(db, actor, invitation.workspace_id, 'workspace_member.joined', actor.userId, undefined, { role: invitation.role })
    return { workspaceId: invitation.workspace_id }
  })
}
export async function changeWorkspaceMember(actor: Principal, workspaceId: string, userId: string, input: unknown | null) {
  const role = input === null ? null : z.object({ role: roleInput }).strict().parse(input).role
  return transaction(async db => {
    await requireOwner(actor, workspaceId, db)
    const member = requireValue((await rows('SELECT m.role,u.email FROM workspace_members m JOIN auth_user u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2', [workspaceId, userId], db))[0])
    if (member.role === 'owner' && role !== 'owner' && Number((await rows("SELECT count(*) AS count FROM workspace_members WHERE workspace_id=$1 AND role='owner'", [workspaceId], db))[0]!.count) <= 1) {
      throw new ServiceError(409, 'last_owner', 'Add another workspace owner before removing or changing the last owner.')
    }
    if (member.role === role) return { changed: false }
    if (role) await db.query('UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId, role])
    else await db.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])
    // Old invitations must not restore removed privileges or outlive their owner's authority.
    await db.query(`UPDATE workspace_invitations SET revoked_at=now() WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL
      AND (lower(email)=lower($2) OR (created_by=$3 AND $4))`, [workspaceId, member.email, userId, member.role === 'owner' && role !== 'owner'])
    await audit(db, actor, workspaceId, role ? 'workspace_member.role_changed' : 'workspace_member.removed', userId, undefined, { previousRole: member.role, ...(role ? { role } : {}) })
    return { changed: true }
  })
}
