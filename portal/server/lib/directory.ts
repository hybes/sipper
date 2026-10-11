import { z } from 'zod'
import { rows, transaction, getPool, type Database } from './db'
import { audit, lockManagedOrganisation, requireOrganisation, type Principal } from './access'
import { requireLicensedMember } from './platform'
import { requireValue, ServiceError } from './errors'
import { getConfig } from './config'
import { directoryContactInput, type DirectoryContactInput, type DirectoryImportResult, type DirectoryPage, type ManagedDirectoryPage, type DirectoryStatus } from '../../shared/directory'
import { CSV_ROW_LIMIT } from '../../shared/csv'

const revisionInput = z.number().int().min(1).max(2147483647)
const pageInput = z.object({ after: z.uuid().optional(), revision: z.uuid().optional(), q: z.string().trim().max(160).default('') }).strict()
  .refine(value => !value.after || value.revision, 'Continue with the directory revision from the first page')
const changed = () => new ServiceError(409, 'directory_changed', 'The directory changed. Refresh it and try again.')

async function insertContact(db: Database, organisationId: string, value: DirectoryContactInput) {
  return (await rows('INSERT INTO directory_contacts (organisation_id,name,company,numbers,member_user_id) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id,revision',
    [organisationId,value.name,value.company,JSON.stringify(value.numbers),value.memberUserId ?? null],db))[0]!
}

export async function importDirectoryContacts(actor: Principal, organisationId: string, input: unknown): Promise<DirectoryImportResult> {
  const value = z.object({ entries: z.array(z.unknown()).min(1).max(CSV_ROW_LIMIT) }).strict().parse(input)
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor,organisationId,db), results: DirectoryImportResult['results'] = []
    for (const [index, entry] of value.entries.entries()) {
      const parsed = directoryContactInput.omit({ memberUserId: true }).safeParse(entry)
      if (!parsed.success) {
        results.push({ index,status:'invalid',message:'Check the name, company and labelled phone numbers.' })
        continue
      }
      const contact = parsed.data
      const existing = await rows(`SELECT id FROM directory_contacts WHERE organisation_id=$1 AND name=$2 AND company=$3
        AND numbers @> $4::jsonb AND numbers <@ $4::jsonb LIMIT 1`,[organisationId,contact.name,contact.company,JSON.stringify(contact.numbers)],db)
      if (existing.length) { results.push({ index,status:'skipped',message:'Already in this directory' }); continue }
      await insertContact(db,organisationId,contact)
      results.push({ index,status:'imported',message:'Imported' })
    }
    const imported = results.filter(result => result.status === 'imported').length
    if (imported) {
      await db.query('UPDATE organisations SET directory_revision=gen_random_uuid() WHERE id=$1',[organisationId])
      await audit(db,actor,org.workspace_id,'directory.imported',organisationId,organisationId,{ imported,
        skipped:results.filter(result => result.status === 'skipped').length, invalid:results.filter(result => result.status === 'invalid').length })
    }
    return { results }
  })
}

async function page(organisationId: string, query: unknown, db: Database = getPool(), admin = false): Promise<DirectoryPage> {
  const value = pageInput.parse(query), search = `%${value.q.replace(/[\\%_]/g, '\\$&')}%`
  const phoneSearch = /^[+0-9*#(). -]+$/.test(value.q) ? `%${value.q.replace(/[(). -]/g,'')}%` : search
  // One statement gives the revision and records the same database snapshot.
  const result = requireValue((await rows(`SELECT o.id,o.name,o.directory_revision,
    ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM directory_contacts WHERE organisation_id=o.id AND id=$2)) AS cursor_exists,
    coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY lower(c.name),c.id) FROM (
      SELECT c.id,c.name,c.company,c.numbers,c.revision,c.updated_at AS "updatedAt"${admin ? ',c.member_user_id AS "memberUserId"' : ''} FROM directory_contacts c
      WHERE c.organisation_id=o.id AND ($2::uuid IS NULL OR (lower(c.name),c.id)>(SELECT lower(name),id FROM directory_contacts WHERE organisation_id=o.id AND id=$2))
      AND (c.name ILIKE $3 OR c.company ILIKE $3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.numbers) n WHERE n->>'number' ILIKE $4))
      ORDER BY lower(c.name),c.id LIMIT 101
    ) c),'[]'::jsonb) AS contacts
    FROM organisations o WHERE o.id=$1`, [organisationId,value.after ?? null,search,phoneSearch], db))[0])
  if (value.revision && value.revision.toLowerCase() !== result.directory_revision) throw changed()
  if (!result.cursor_exists) throw new ServiceError(404,'not_found','Directory page unavailable. Refresh the first page.')
  return { organisation: { id: result.id, name: result.name }, revision: result.directory_revision,
    contacts: result.contacts.slice(0,100), nextCursor: result.contacts.length>100 ? result.contacts[99].id : null }
}

export async function organisationDirectory(actor: Principal, organisationId: string, query: unknown = {}) {
  await requireOrganisation(actor,organisationId)
  return page(organisationId,query,getPool(),true)
}

async function directoryDevice(actor: Principal, deviceId: string, db: Database) {
  const device = (await rows(`SELECT d.organisation_id,o.directory_revision FROM devices d JOIN organisations o ON o.id=d.organisation_id
    WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL`,[deviceId,actor.userId],db))[0]
  if (!device) throw new ServiceError(403,'device_unavailable','This device is not enrolled or has been revoked.')
  await requireLicensedMember(actor,device.organisation_id,db)
  return device
}

export async function deviceDirectory(actor: Principal, deviceId: string, query: unknown = {}): Promise<ManagedDirectoryPage> {
  return transaction(async db => {
    const device = await directoryDevice(actor,deviceId,db)
    return { ...await page(device.organisation_id,query,db), deviceId,
      expiresAt: new Date(Date.now()+getConfig().SIPPER_CONFIG_TTL_SECONDS*1000).toISOString() }
  })
}

// Short-lived observations are separate from the offline directory cache. No device,
// IP, login, email, SIP identity, caller or destination details are disclosed to colleagues.
export async function deviceDirectoryStatus(actor: Principal, deviceId: string, input: unknown): Promise<DirectoryStatus> {
  const { contactIds, revision } = z.object({ revision: z.uuid().transform(id=>id.toLowerCase()), contactIds: z.array(z.uuid().transform(id=>id.toLowerCase())).min(1).max(100)
    .refine(ids=>new Set(ids).size===ids.length,'Use each contact once.') }).strict().parse(input)
  return transaction(async db => {
    const device = await directoryDevice(actor,deviceId,db)
    if (device.directory_revision !== revision) throw changed()
    const contacts = await rows(`WITH contacts AS (SELECT c.id,c.organisation_id,m.user_id,m.share_activity,
        CASE WHEN m.share_status THEN m.availability END AS availability,
        CASE WHEN m.share_status THEN m.do_not_disturb END AS do_not_disturb
      FROM directory_contacts c JOIN organisations o ON o.id=c.organisation_id AND o.directory_revision=$3
      LEFT JOIN organisation_members m ON m.organisation_id=c.organisation_id AND m.user_id=c.member_user_id
        AND m.status='active'
        AND EXISTS (SELECT 1 FROM seat_assignments s WHERE s.workspace_id=m.workspace_id AND s.user_id=m.user_id)
        AND EXISTS (SELECT 1 FROM auth_user u WHERE u.id=m.user_id AND u."emailVerified")
      WHERE c.organisation_id=$1 AND c.id=ANY($2::uuid[])),
      assigned AS (SELECT c.id AS contact_id,d.id AS device_id,d.status,s.id AS configuration_id,s.mode
        FROM contacts c JOIN devices d ON d.organisation_id=c.organisation_id AND d.user_id=c.user_id AND d.revoked_at IS NULL
        JOIN sip_configurations s ON s.organisation_id=c.organisation_id
        WHERE c.share_activity AND (EXISTS(SELECT 1 FROM sip_assignments a WHERE a.configuration_id=s.id AND a.user_id=c.user_id)
          OR EXISTS(SELECT 1 FROM group_configurations g JOIN group_members m ON m.group_id=g.group_id WHERE g.configuration_id=s.id AND m.user_id=c.user_id))),
      observations AS (
        SELECT a.contact_id,'device' AS source,(a.status->'directCalls'->>'observedAt')::timestamptz AS observed_at,
          CASE WHEN (r->>'connected')::int>0 THEN 'in_call' WHEN (r->>'held')::int>0 THEN 'on_hold'
            WHEN (r->>'ringing')::int>0 THEN 'ringing' WHEN (r->>'dialling')::int>0 THEN 'dialling' END AS state
        FROM assigned a CROSS JOIN LATERAL jsonb_array_elements(a.status->'directCalls'->'accounts') r
        WHERE a.mode='direct' AND r->>'accountId'=a.configuration_id::text
          AND a.status->'directCalls'->>'source'='device' AND a.status->'directCalls'->'confirmed'='true'::jsonb
          AND (a.status->'directCalls'->>'observedAt')::timestamptz BETWEEN now()-interval '3 minutes' AND now()
        UNION ALL
        SELECT a.contact_id,'gateway',n.last_heartbeat_at,
          CASE WHEN c.state='answered' THEN 'in_call' WHEN c.direction='outgoing' THEN 'dialling' ELSE 'ringing' END
        FROM assigned a JOIN gateway_calls c ON c.organisation_id=$1 AND c.configuration_id=a.configuration_id
        JOIN gateway_nodes n ON n.id=c.gateway_id
        WHERE a.mode='gateway' AND c.transferred_at IS NULL AND c.end_requested_at IS NULL
          AND n.ready_until>now() AND n.controller_expires_at>now() AND n.last_heartbeat_at<=now()
          AND n.last_heartbeat_at>now()-interval '3 minutes'
          AND ((c.direction='outgoing' AND c.origin_device_id=a.device_id)
            OR (c.direction='incoming' AND ((c.state='answered' AND c.winner_device_id=a.device_id)
              OR (c.state IN ('ringing','answering') AND EXISTS(SELECT 1 FROM call_recipients r
                WHERE r.call_id=c.id AND r.device_id=a.device_id AND r.declined_at IS NULL)))))
          AND (c.state='answered' OR (c.state IN ('ringing','answering') AND c.expires_at>now()))
      ) SELECT c.id AS "contactId",c.availability,c.do_not_disturb AS "doNotDisturb",
        (SELECT jsonb_build_object('state',v.state,'source',v.source,'observedAt',v.observed_at) FROM observations v
          WHERE v.contact_id=c.id AND v.state IS NOT NULL
          ORDER BY CASE v.state WHEN 'in_call' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'ringing' THEN 2 ELSE 3 END,v.observed_at DESC,v.source LIMIT 1) AS activity
      FROM contacts c ORDER BY c.id`,[device.organisation_id,contactIds,revision],db)
    if (contacts.length!==contactIds.length) throw new ServiceError(404,'not_found','Shared contact unavailable. Refresh the directory.')
    const now=Date.now()
    // A snapshot cannot extend an app report past its original three-minute validity.
    const expiresAt=contacts.reduce((expiry,c)=>c.activity ? Math.min(expiry,Date.parse(c.activity.observedAt)+180_000) : expiry,now+30_000)
    return { deviceId,organisationId:device.organisation_id,revision,expiresAt:new Date(expiresAt).toISOString(),contacts } as DirectoryStatus
  })
}

export async function saveDirectoryContact(actor: Principal, organisationId: string, contactId: string | null, input: unknown) {
  const edit = contactId ? directoryContactInput.extend({ revision: revisionInput }).parse(input) : null
  const value = edit ?? directoryContactInput.parse(input)
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor,organisationId,db)
    const existing = contactId ? requireValue((await rows('SELECT revision,member_user_id FROM directory_contacts WHERE organisation_id=$1 AND id=$2',[organisationId,contactId],db))[0]) : null
    if (existing && existing.revision !== edit!.revision) throw changed()
    if (value.memberUserId && value.memberUserId !== existing?.member_user_id && !(await rows("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'",[organisationId,value.memberUserId],db)).length) {
      throw new ServiceError(400,'invalid_directory_member','Choose an active member of this customer.')
    }
    let contact
    if (contactId) {
      contact = (await rows(`UPDATE directory_contacts SET name=$3,company=$4,numbers=$5::jsonb,
        member_user_id=CASE WHEN $6 THEN $7 ELSE member_user_id END,revision=revision+1,updated_at=now()
        WHERE organisation_id=$1 AND id=$2 RETURNING id,revision`,[organisationId,contactId,value.name,value.company,JSON.stringify(value.numbers),value.memberUserId!==undefined,value.memberUserId ?? null],db))[0]!
    } else {
      contact = await insertContact(db,organisationId,value)
    }
    await db.query('UPDATE organisations SET directory_revision=gen_random_uuid() WHERE id=$1',[organisationId])
    await audit(db,actor,org.workspace_id,contactId ? 'directory_contact.updated' : 'directory_contact.created',contact.id,organisationId)
    return contact
  })
}

export async function deleteDirectoryContact(actor: Principal, organisationId: string, contactId: string, revision: unknown) {
  const expected = revisionInput.parse(revision)
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor,organisationId,db)
    const existing = requireValue((await rows('SELECT revision FROM directory_contacts WHERE organisation_id=$1 AND id=$2',[organisationId,contactId],db))[0])
    if (existing.revision !== expected) throw changed()
    await db.query('DELETE FROM directory_contacts WHERE organisation_id=$1 AND id=$2',[organisationId,contactId])
    await db.query('UPDATE organisations SET directory_revision=gen_random_uuid() WHERE id=$1',[organisationId])
    await audit(db,actor,org.workspace_id,'directory_contact.deleted',contactId,organisationId)
    return { deleted: true }
  })
}
