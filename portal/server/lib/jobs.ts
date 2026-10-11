import { randomUUID } from 'node:crypto'
import { rows, type Database, getPool } from './db'
import { openSecret } from './crypto'
import { sendMail } from './mail'
import { canAdministerOrganisation } from './access'
import { z } from 'zod'

export async function queuedInvitation(key: string | null, db: Database = getPool()) {
  const [kind, reference, extra] = (key ?? '').split(':')
  if (extra !== undefined || !['invitation', 'workspace-invitation'].includes(kind!) || !z.uuid().safeParse(reference).success) return null
  const customer = kind === 'invitation'
  const invitation = (await rows(customer
    ? `SELECT i.id,i.email,i.expires_at,i.accepted_at,i.revoked_at,i.created_by,i.workspace_id,i.organisation_id,w.name AS workspace_name,o.name AS customer_name,
        EXISTS(SELECT 1 FROM auth_user u JOIN organisation_members m ON m.user_id=u.id AND m.organisation_id=i.organisation_id WHERE lower(u.email)=lower(i.email) AND m.status='suspended') AS suspended
      FROM invitations i JOIN workspaces w ON w.id=i.workspace_id JOIN organisations o ON o.id=i.organisation_id WHERE i.id=$1`
    : `SELECT i.id,i.email,i.expires_at,i.accepted_at,i.revoked_at,i.created_by,i.workspace_id,w.name AS workspace_name,NULL::text AS customer_name,NULL::uuid AS organisation_id,
        EXISTS(SELECT 1 FROM auth_user u JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=i.workspace_id WHERE lower(u.email)=lower(i.email)) AS suspended
      FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.id=$1`, [reference], db))[0]
  if (!invitation) return null
  const authority = invitation.created_by && (customer
    ? await canAdministerOrganisation(invitation.created_by, invitation.organisation_id, db)
    : (await rows(`SELECT 1 WHERE EXISTS(SELECT 1 FROM platform_owners WHERE user_id=$1)
        OR EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$2 AND user_id=$1 AND role='owner')`, [invitation.created_by, invitation.workspace_id], db)).length > 0)
  return { kind: customer ? 'customer' : 'workspace', email: invitation.email as string, workspaceId: invitation.workspace_id as string,
    organisationId: invitation.organisation_id as string | null, workspaceName: invitation.workspace_name as string, customerName: invitation.customer_name as string | null,
    expiresAt: invitation.expires_at as Date,
    available: Boolean(authority && !invitation.suspended && !invitation.accepted_at && !invitation.revoked_at && invitation.expires_at > new Date()) }
}

export async function pruneInvitationEmails() {
  // Do not retain unusable invitation tokens in exhausted jobs indefinitely.
  await rows(`UPDATE jobs j SET completed_at=now(),locked_until=NULL,lease_id=NULL,payload='{}',last_error='invitation_unavailable'
    WHERE j.kind='email' AND j.completed_at IS NULL AND (j.locked_until IS NULL OR j.locked_until<=now()) AND (
      (j.deduplication_key LIKE 'invitation:%' AND NOT EXISTS(SELECT 1 FROM invitations i
        WHERE j.deduplication_key='invitation:'||i.id::text AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()))
      OR (j.deduplication_key LIKE 'workspace-invitation:%' AND NOT EXISTS(SELECT 1 FROM workspace_invitations i
        WHERE j.deduplication_key='workspace-invitation:'||i.id::text AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now())))`)
}

export async function runOneJob(deliver: typeof sendMail = sendMail) {
  const lease = randomUUID()
  const job = (await rows(`UPDATE jobs SET locked_until=now()+interval '2 minutes', attempts=attempts+1, last_attempt_at=now(), lease_id=$1 WHERE id=(
    SELECT id FROM jobs WHERE kind='email' AND completed_at IS NULL AND available_at<=now() AND (locked_until IS NULL OR locked_until<now()) AND attempts<10
    ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [lease]))[0]
  if (!job) return false
  try {
    const invitation = await queuedInvitation(job.deduplication_key)
    if (!invitation?.available) {
      await rows("UPDATE jobs SET completed_at=now(),locked_until=NULL,payload='{}',last_error='invitation_unavailable' WHERE id=$1 AND lease_id=$2", [job.id, lease])
      return true
    }
    const message = JSON.parse(openSecret(job.payload, `mail:${job.id}`))
    if (typeof message.to !== 'string' || message.to.toLowerCase() !== invitation.email.toLowerCase()
      || typeof message.subject !== 'string' || typeof message.text !== 'string') throw new Error('Invalid invitation email')
    await deliver(message.to, message.subject, message.text)
    // Erase the secret-bearing payload when the mail has been accepted by SMTP.
    await rows("UPDATE jobs SET completed_at=now(), locked_until=NULL, payload='{}', last_error=NULL WHERE id=$1 AND lease_id=$2", [job.id, lease])
  } catch {
    // Provider errors can echo message contents or credentials: store only a safe category.
    const delaySeconds = Math.min(3600, 2 ** job.attempts * 5)
    await rows("UPDATE jobs SET locked_until=NULL, available_at=now()+($3 * interval '1 second'), last_error='delivery_failed' WHERE id=$1 AND lease_id=$2", [job.id, lease, delaySeconds])
  }
  return true
}
