import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { rows, transaction, type Database } from './db'
import { requireOrganisation, requireWorkspace, lockManagedOrganisation, audit, type Principal } from './access'
import { requireValue, ServiceError } from './errors'
import { sealSecret } from './crypto'
import { configurationInput } from '../../shared/contracts'

export async function updateConfiguration(actor: Principal, organisationId: string, configurationId: string, input: unknown) {
  const value = configurationInput.extend({ password: z.string().min(1).max(1024).optional(), revision: z.number().int().positive().max(2147483647) }).parse(input)
  return transaction(async db => {
    const org = await requireOrganisation(actor, organisationId, true, db)
    const existing = requireValue((await rows('SELECT id,revision FROM sip_configurations WHERE organisation_id=$1 AND id=$2 FOR UPDATE', [organisationId, configurationId], db))[0])
    if (existing.revision !== value.revision) throw new ServiceError(409, 'configuration_changed', 'This calling account changed while you were editing. Reload it before saving.')
    const envelope = value.password ? JSON.stringify(sealSecret(value.password, `sip:${organisationId}:${existing.id}`)) : null
    await db.query(`UPDATE sip_configurations SET label=$1, mode=$2, settings=$3, secret_envelope=COALESCE($4::jsonb,secret_envelope), revision=revision+1, updated_at=now() WHERE id=$5`, [value.label, value.mode, JSON.stringify(value.settings), envelope, existing.id])
    await audit(db, actor, org.workspace_id, 'sip_configuration.updated', existing.id, organisationId)
    return { updated: true, revision: existing.revision + 1 }
  })
}
export async function deleteConfiguration(actor: Principal, organisationId: string, configurationId: string) {
  return transaction(async db => {
    const org = await requireOrganisation(actor, organisationId, true, db)
    requireValue((await rows('DELETE FROM sip_configurations WHERE organisation_id=$1 AND id=$2 RETURNING id', [organisationId, configurationId], db))[0])
    await audit(db, actor, org.workspace_id, 'sip_configuration.deleted', configurationId, organisationId)
    return { deleted: true }
  })
}
export async function unassignConfiguration(actor: Principal, organisationId: string, configurationId: string, userId: string) {
  return transaction(async db => {
    const org = await requireOrganisation(actor, organisationId, true, db)
    await db.query('DELETE FROM sip_assignments WHERE organisation_id=$1 AND configuration_id=$2 AND user_id=$3', [organisationId, configurationId, userId])
    await audit(db, actor, org.workspace_id, 'sip_configuration.unassigned', configurationId, organisationId, { userId })
    return { assigned: false }
  })
}
export async function revokeInvitation(actor: Principal, organisationId: string, invitationId: string) {
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor, organisationId, db)
    requireValue((await rows('UPDATE invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE organisation_id=$1 AND id=$2 AND accepted_at IS NULL RETURNING id', [organisationId, invitationId], db))[0])
    await audit(db, actor, org.workspace_id, 'invitation.revoked', invitationId, organisationId)
    return { revoked: true }
  })
}
const groupFields = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  userIds: z.array(z.string().min(1).max(128)).max(1000).optional(),
  configurationIds: z.array(z.uuid().transform(id => id.toLowerCase())).max(100).optional(),
}).strict()

export function groupRevision(group: Record<string, any>) {
  // Content revisions also detect changes made by SCIM and membership removal.
  return createHash('sha256').update(JSON.stringify([group.id, group.name, group.scim_managed,
    [...group.user_ids].sort(), [...group.configuration_ids].sort()])).digest('hex')
}

async function groupState(db: Database, organisationId: string, groupId: string) {
  return (await rows(`SELECT g.id,g.name,EXISTS(SELECT 1 FROM scim_groups s WHERE s.id=g.id) AS scim_managed,
    ARRAY(SELECT user_id FROM group_members m WHERE m.group_id=g.id) AS user_ids,
    ARRAY(SELECT configuration_id FROM group_configurations c WHERE c.group_id=g.id) AS configuration_ids
    FROM groups g WHERE g.organisation_id=$1 AND g.id=$2 FOR UPDATE OF g`, [organisationId, groupId], db))[0]
}

async function writeGroupAssignments(db: Database, organisationId: string, groupId: string, value: Pick<z.infer<typeof groupFields>, 'userIds' | 'configurationIds'>) {
  if (value.userIds !== undefined) {
    const ids = [...new Set(value.userIds)]
    const members = await rows("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND user_id=ANY($2::text[]) AND status<>'removed' FOR SHARE", [organisationId, ids], db)
    if (members.length !== ids.length) throw new ServiceError(400, 'invalid_members', 'Every group member must belong to this customer.')
    await db.query('DELETE FROM group_members WHERE group_id=$1', [groupId])
    await db.query('INSERT INTO group_members (organisation_id,group_id,user_id) SELECT $1,$2,unnest($3::text[])', [organisationId, groupId, ids])
  }
  if (value.configurationIds !== undefined) {
    const ids = [...new Set(value.configurationIds)]
    const configs = await rows('SELECT id FROM sip_configurations WHERE organisation_id=$1 AND id=ANY($2::uuid[]) FOR KEY SHARE', [organisationId, ids], db)
    if (configs.length !== ids.length) throw new ServiceError(400, 'invalid_configurations', 'Every calling account must belong to this customer.')
    await db.query('DELETE FROM group_configurations WHERE group_id=$1', [groupId])
    await db.query('INSERT INTO group_configurations (organisation_id,group_id,configuration_id) SELECT $1,$2,unnest($3::uuid[])', [organisationId, groupId, ids])
  }
}

export async function createGroup(actor: Principal, organisationId: string, input: unknown) {
  const value = groupFields.extend({ id: z.uuid().transform(id => id.toLowerCase()).optional(), name: groupFields.shape.name.unwrap(), userIds: groupFields.shape.userIds.default([]), configurationIds: groupFields.shape.configurationIds.default([]) }).parse(input)
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor, organisationId, db)
    const id = value.id ?? randomUUID()
    const inserted = await rows('INSERT INTO groups (id,organisation_id,name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id', [id, organisationId, value.name], db)
    if (!inserted.length) {
      const existing = await groupState(db, organisationId, id)
      const intended = { id, name: value.name, scim_managed: false, user_ids: [...new Set(value.userIds)], configuration_ids: [...new Set(value.configurationIds)] }
      if (!existing || groupRevision(existing) !== groupRevision(intended)) throw new ServiceError(409, 'group_changed', 'This group could not be created with these details. Reload it to review any saved changes.')
      return { ...existing, revision: groupRevision(existing) }
    }
    await writeGroupAssignments(db, organisationId, id, value)
    const group = (await groupState(db, organisationId, id))!
    await audit(db, actor, org.workspace_id, 'group.created', group.id, organisationId)
    return { ...group, revision: groupRevision(group) }
  })
}

export async function updateGroup(actor: Principal, organisationId: string, groupId: string, input: unknown) {
  const value = groupFields.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
    .refine(value => value.name !== undefined || value.userIds !== undefined || value.configurationIds !== undefined, 'Choose group details to update.').parse(input)
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor, organisationId, db)
    const group = requireValue(await groupState(db, organisationId, groupId))
    if (group.scim_managed && (value.name !== undefined || value.userIds !== undefined)) throw new ServiceError(409, 'scim_managed_group', 'Manage this group’s name and members in your identity provider.')
    if (groupRevision(group) !== value.revision) throw new ServiceError(409, 'group_changed', 'This group changed while you were editing. Reload it before saving.')
    const intended = { ...group, name: value.name ?? group.name, user_ids: value.userIds === undefined ? group.user_ids : [...new Set(value.userIds)], configuration_ids: value.configurationIds === undefined ? group.configuration_ids : [...new Set(value.configurationIds)] }
    if (groupRevision(intended) === value.revision) return { ...group, revision: value.revision }
    if (value.name !== undefined) await db.query('UPDATE groups SET name=$2 WHERE id=$1', [groupId, value.name])
    await writeGroupAssignments(db, organisationId, groupId, value)
    await audit(db, actor, org.workspace_id, 'group.updated', groupId, organisationId, { people: intended.user_ids.length, accounts: intended.configuration_ids.length })
    return { ...intended, revision: groupRevision(intended) }
  })
}

export async function setGroupMembers(actor: Principal, organisationId: string, groupId: string, input: unknown) {
  const value = z.object({ userIds: groupFields.shape.userIds.unwrap() }).strict().parse(input)
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor, organisationId, db)
    requireValue((await rows('SELECT id FROM groups WHERE organisation_id=$1 AND id=$2 FOR UPDATE', [organisationId, groupId], db))[0])
    if((await rows('SELECT id FROM scim_groups WHERE organisation_id=$1 AND id=$2',[organisationId,groupId],db)).length) throw new ServiceError(409,'scim_managed_group','Manage this group’s members in your identity provider.')
    await writeGroupAssignments(db, organisationId, groupId, value)
    await audit(db, actor, org.workspace_id, 'group.members_updated', groupId, organisationId, { count: new Set(value.userIds).size })
    return { updated: true }
  })
}
export async function setGroupConfigurations(actor: Principal, organisationId: string, groupId: string, input: unknown) {
  const value = z.object({ configurationIds: groupFields.shape.configurationIds.unwrap() }).strict().parse(input)
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor, organisationId, db)
    requireValue((await rows('SELECT id FROM groups WHERE organisation_id=$1 AND id=$2 FOR UPDATE', [organisationId, groupId], db))[0])
    await writeGroupAssignments(db, organisationId, groupId, value)
    await audit(db, actor, org.workspace_id, 'group.configurations_updated', groupId, organisationId, { count: new Set(value.configurationIds).size })
    return { updated: true }
  })
}
export async function deleteGroup(actor: Principal, organisationId: string, groupId: string) {
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor, organisationId, db)
    if((await rows('SELECT id FROM scim_groups WHERE organisation_id=$1 AND id=$2',[organisationId,groupId],db)).length) throw new ServiceError(409,'scim_managed_group','Delete this group in your identity provider.')
    requireValue((await rows('DELETE FROM groups WHERE organisation_id=$1 AND id=$2 RETURNING id', [organisationId, groupId], db))[0])
    await audit(db, actor, org.workspace_id, 'group.deleted', groupId, organisationId)
    return { deleted: true }
  })
}
export async function auditHistory(actor: Principal, workspaceId: string, before?: string) {
  await requireWorkspace(actor, workspaceId, 'read')
  if (before && !/^\d{1,19}$/.test(before)) throw new ServiceError(400, 'invalid_cursor', 'Invalid audit cursor.')
  return rows(`SELECT a.id,a.organisation_id,a.action,a.target_id,a.details,a.created_at,COALESCE(u.name,CASE WHEN a.details->>'source'='scim' THEN 'SCIM provisioning' END) AS actor_name,
      o.name AS organisation_name,COALESCE(t.name,wi.email,i.email) AS target_name
    FROM audit_events a LEFT JOIN auth_user u ON u.id=a.actor_id
    LEFT JOIN organisations o ON o.id=a.organisation_id AND o.workspace_id=a.workspace_id
    LEFT JOIN auth_user t ON t.id=a.target_id AND (a.action LIKE 'workspace_member.%' OR a.action LIKE 'member.%' OR a.action LIKE 'seat.%')
    LEFT JOIN workspace_invitations wi ON wi.id::text=a.target_id AND wi.workspace_id=a.workspace_id AND a.action LIKE 'workspace_invitation.%'
    LEFT JOIN invitations i ON i.id::text=a.target_id AND i.workspace_id=a.workspace_id AND a.action LIKE 'invitation.%'
    WHERE a.workspace_id=$1 AND ($2::bigint IS NULL OR a.id<$2)
    ORDER BY a.id DESC LIMIT 100`, [workspaceId, before ?? null])
}
