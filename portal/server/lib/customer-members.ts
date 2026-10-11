import { z } from 'zod'
import { audit, canAdministerOrganisation, lockManagedOrganisation, type Principal } from './access'
import { rows, transaction, type Database } from './db'
import { ServiceError, requireValue } from './errors'

export async function revokeMemberInvitations(db: Database, organisationId: string, userId: string, email: string, includeRecipient = true) {
  const stillAdmin = await canAdministerOrganisation(userId, organisationId, db)
  await db.query(`UPDATE invitations SET revoked_at=now() WHERE organisation_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL
    AND ((lower(email)=lower($2) AND $5) OR (created_by=$3 AND NOT $4))`, [organisationId, email, userId, stillAdmin, includeRecipient])
}

export async function changeMemberRole(actor: Principal, organisationId: string, userId: string, input: unknown) {
  const { role } = z.object({ role: z.enum(['user', 'admin']) }).strict().parse(input)
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor, organisationId, db)
    const member = requireValue((await rows('SELECT m.*,u.email FROM organisation_members m JOIN auth_user u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.user_id=$2 FOR UPDATE OF m', [organisationId, userId], db))[0])
    if (member.status === 'removed') throw new ServiceError(409, 'member_removed', 'Send a new invitation before changing this person’s access.')
    if (member.role === role) return { changed: false }
    await db.query('UPDATE organisation_members SET role=$3 WHERE organisation_id=$1 AND user_id=$2', [organisationId, userId, role])
    await revokeMemberInvitations(db, organisationId, userId, member.email)
    await audit(db, actor, org.workspace_id, 'member.role_changed', userId, organisationId, { previousRole: member.role, role })
    return { changed: true }
  })
}

export async function removeMember(actor: Principal, organisationId: string, userId: string) {
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor, organisationId, db)
    const member = requireValue((await rows('SELECT m.*,u.email FROM organisation_members m JOIN auth_user u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.user_id=$2 FOR UPDATE OF m', [organisationId, userId], db))[0])
    if (member.status === 'removed') return { removed: true }
    await removeCustomerAccess(db,organisationId,userId,member.email)
    await audit(db, actor, org.workspace_id, 'member.removed', userId, organisationId, { previousRole: member.role })
    return { removed: true }
  })
}

// Both administrator and scoped SCIM removal hold the organisation/member locks
// and authorise their caller before using this same access-withdrawal operation.
export async function removeCustomerAccess(db: Database, organisationId: string, userId: string, email: string) {
    await db.query("UPDATE organisation_members SET status='removed',removed_at=now(),share_status=false,share_activity=false WHERE organisation_id=$1 AND user_id=$2", [organisationId, userId])
    // Updating devices also erases push tokens through the database revocation trigger.
    // Keep device/call rows: normal access removal must not end an established call.
    await db.query('UPDATE devices SET revoked_at=COALESCE(revoked_at,now()) WHERE organisation_id=$1 AND user_id=$2', [organisationId, userId])
    await db.query('DELETE FROM sip_assignments WHERE organisation_id=$1 AND user_id=$2', [organisationId, userId])
    await db.query('DELETE FROM group_members WHERE organisation_id=$1 AND user_id=$2', [organisationId, userId])
    await db.query('UPDATE setup_links SET revoked_at=now() WHERE organisation_id=$1 AND user_id=$2 AND used_at IS NULL AND revoked_at IS NULL', [organisationId, userId])
    await revokeMemberInvitations(db, organisationId, userId, email)
}
