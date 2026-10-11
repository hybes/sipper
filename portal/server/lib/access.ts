import { rows, getPool, type Database } from './db'
import { ServiceError, requireValue } from './errors'
import { getConfig } from './config'

export interface Principal { userId: string; email: string; verified: boolean; mfa: boolean; sessionCreatedAt?: Date | string; sessionId?: string }

export function requireVerified(actor: Principal) {
  if (!actor.verified) throw new ServiceError(403, 'email_verification_required', 'Verify your email before continuing.')
}
export function requireAdminMfa(actor: Principal) {
  requireVerified(actor)
  if (getConfig().SIPPER_REQUIRE_ADMIN_MFA === 'true' && !actor.mfa) {
    throw new ServiceError(403, 'mfa_required', 'Set up two-factor authentication before administering Sipper.')
  }
}
export async function isPlatformOwner(actor: Principal, db: Database = getPool()) {
  return (await rows('SELECT user_id FROM platform_owners WHERE user_id = $1', [actor.userId], db)).length > 0
}
export async function requireWorkspace(actor: Principal, id: string, action: 'manage' | 'billing' | 'read' = 'manage', db: Database = getPool()) {
  requireAdminMfa(actor)
  const workspace = requireValue((await rows('SELECT * FROM workspaces WHERE id = $1', [id], db))[0])
  if (await isPlatformOwner(actor, db)) return workspace
  const member = (await rows('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [id, actor.userId], db))[0]
  const roles = action === 'manage' ? ['owner', 'admin'] : action === 'billing' ? ['owner', 'admin', 'billing'] : ['owner', 'admin', 'billing', 'support']
  if (!member || !roles.includes(member.role)) throw new ServiceError(404, 'not_found', 'Workspace not found.')
  return workspace
}
// 'inspect' is an MFA-protected management read; false remains end-user access.
export async function requireOrganisation(actor: Principal, id: string, manage: boolean | 'inspect' = true, db: Database = getPool()) {
  requireVerified(actor)
  const organisation = requireValue((await rows('SELECT * FROM organisations WHERE id = $1', [id], db))[0])
  const owner = await isPlatformOwner(actor, db)
  const workspaceAdmin = (await rows("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND (role IN ('owner', 'admin') OR ($3 AND role='support'))", [organisation.workspace_id, actor.userId, manage === 'inspect'], db)).length > 0
  const member = (await rows("SELECT role, status FROM organisation_members WHERE organisation_id = $1 AND user_id = $2", [id, actor.userId], db))[0]
  if (!(owner || workspaceAdmin || (member?.status === 'active' && (!manage || member.role === 'admin')))) {
    throw new ServiceError(404, 'not_found', 'Organisation not found.')
  }
  if (manage) requireAdminMfa(actor)
  return organisation
}

export async function lockManagedOrganisation(actor: Principal, id: string, db: Database) {
  // Compatible with the KEY SHARE locks taken by audit/device foreign keys.
  // A full UPDATE lock can deadlock with an enrolment already holding its member row.
  requireValue((await rows('SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE', [id], db))[0])
  // Membership, invitation and role writes recheck access after the same lock.
  return requireOrganisation(actor, id, true, db)
}

export async function canAdministerOrganisation(userId: string, organisationId: string, db: Database = getPool()) {
  return (await rows(`SELECT 1 FROM organisations o WHERE o.id=$1 AND (
    EXISTS (SELECT 1 FROM platform_owners p WHERE p.user_id=$2)
    OR EXISTS (SELECT 1 FROM workspace_members w WHERE w.workspace_id=o.workspace_id AND w.user_id=$2 AND w.role IN ('owner','admin'))
    OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=o.id AND m.user_id=$2 AND m.role='admin' AND m.status='active'))`, [organisationId, userId], db)).length > 0
}

export async function audit(db: Database, actor: Principal, workspaceId: string, action: string, targetId?: string, organisationId?: string, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO audit_events (workspace_id, organisation_id, actor_id, action, target_id, details) VALUES ($1, $2, $3, $4, $5, $6)', [workspaceId, organisationId ?? null, actor.userId, action, targetId ?? null, JSON.stringify(details)])
}
