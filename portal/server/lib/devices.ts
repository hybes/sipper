import { z } from 'zod'
import { rows, transaction } from './db'
import { audit, requireVerified, type Principal } from './access'
import { ServiceError } from './errors'
import { provisionDevice } from './platform'

export async function ownCallingPreferences(actor: Principal) {
  requireVerified(actor)
  const organisations = await rows(`SELECT o.id,o.name,m.status,m.do_not_disturb,m.availability,m.share_status,m.share_activity,m.calling_preference_updated_at
    FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
    WHERE m.user_id=$1 AND m.status<>'removed' ORDER BY o.name,o.id`, [actor.userId])
  return { organisations }
}

export async function setCallingPreference(actor: Principal, organisationId: string, input: unknown) {
  requireVerified(actor)
  const value = z.object({ doNotDisturb: z.boolean().optional(), availability: z.enum(['unset','available','away','busy']).optional(), shareStatus: z.boolean().optional(), shareActivity: z.boolean().optional() })
    .strict().refine(value => value.doNotDisturb !== undefined || value.availability !== undefined || value.shareStatus !== undefined || value.shareActivity !== undefined, 'Choose a preference to update.').parse(input)
  return transaction(async db => {
    // Only the person's own active membership grants this preference. A workspace
    // role, seat or device is neither required nor sufficient to change it.
    const member = (await rows(`SELECT workspace_id,do_not_disturb,availability,share_status,share_activity,calling_preference_updated_at
      FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' FOR UPDATE`, [organisationId, actor.userId], db))[0]
    if (!member) throw new ServiceError(404, 'membership_unavailable', 'Your active customer membership was not found.')
    const doNotDisturb = value.doNotDisturb ?? member.do_not_disturb, availability = value.availability ?? member.availability, shareStatus = value.shareStatus ?? member.share_status, shareActivity = value.shareActivity ?? member.share_activity
    if (member.do_not_disturb === doNotDisturb && member.availability === availability && member.share_status === shareStatus && member.share_activity === shareActivity) return { doNotDisturb, availability, shareStatus, shareActivity, updatedAt: member.calling_preference_updated_at }
    const updated = (await rows(`UPDATE organisation_members SET do_not_disturb=$3,availability=$4,share_status=$5,share_activity=$6,calling_preference_updated_at=now()
      WHERE organisation_id=$1 AND user_id=$2 RETURNING calling_preference_updated_at`, [organisationId, actor.userId, doNotDisturb, availability, shareStatus, shareActivity], db))[0]!
    await audit(db, actor, member.workspace_id, 'member.calling_preference_changed', actor.userId, organisationId, value)
    return { doNotDisturb, availability, shareStatus, shareActivity, updatedAt: updated.calling_preference_updated_at }
  })
}

export async function ownDevices(actor: Principal, input: unknown = {}) {
  requireVerified(actor)
  const value = z.object({ q: z.string().trim().max(160).default(''), state: z.enum(['all', 'enrolled', 'revoked']).default('all'), after: z.uuid().optional() }).strict().parse(input)
  const cursor = value.after ? (await rows('SELECT enrolled_at::text AS enrolled_at,id FROM devices WHERE id=$1 AND user_id=$2', [value.after, actor.userId]))[0] : null
  if (value.after && !cursor) throw new ServiceError(404, 'not_found', 'Device not found.')
  const devices = await rows(`SELECT d.id,d.name,d.platform,d.app_version,d.os_version,d.enrolled_at,d.revoked_at,
    d.last_login_at,d.last_request_at,host(d.last_request_ip) AS last_request_ip,d.last_report_at,
    o.id AS organisation_id,o.name AS organisation_name,m.status AS membership_status
    FROM devices d JOIN organisations o ON o.id=d.organisation_id
    JOIN organisation_members m ON m.organisation_id=d.organisation_id AND m.user_id=d.user_id
    WHERE d.user_id=$1 AND ($2='' OR strpos(lower(d.name||' '||o.name||' '||d.platform||' '||coalesce(host(d.last_request_ip),'')),lower($2))>0)
      AND ($3='all' OR ($3='revoked' AND d.revoked_at IS NOT NULL) OR ($3='enrolled' AND d.revoked_at IS NULL))
      AND ($4::timestamptz IS NULL OR (d.enrolled_at,d.id)<($4::timestamptz,$5::uuid))
    ORDER BY d.enrolled_at DESC,d.id DESC LIMIT 51`, [actor.userId, value.q, value.state, cursor?.enrolled_at ?? null, cursor?.id ?? null])
  return { devices: devices.slice(0,50), nextCursor: devices.length > 50 ? devices[49]!.id as string : null }
}

export async function clientOrganisations(actor: Principal) {
  requireVerified(actor)
  const organisations = await rows(`SELECT o.id,o.name,m.status,m.do_not_disturb AS "doNotDisturb",m.availability,s.user_id IS NOT NULL AS licensed
    FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
    LEFT JOIN seat_assignments s ON s.workspace_id=m.workspace_id AND s.user_id=m.user_id WHERE m.user_id=$1 AND m.status<>'removed' ORDER BY o.name`, [actor.userId])
  return { user: { id: actor.userId, email: actor.email }, organisations }
}
const reportSchema = z.object({
  appliedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  registrations: z.array(z.object({
    // Swift encodes UUIDs in uppercase; compare and store their canonical form.
    accountId: z.uuid().transform(value => value.toLowerCase()),
    state: z.enum(['registered', 'failed', 'unregistered', 'unknown']),
    sipCode: z.number().int().min(100).max(699).optional(),
  }).strict()).max(100).optional(),
  directCalls: z.array(z.object({
    accountId: z.uuid().transform(value => value.toLowerCase()),
    ringing: z.number().int().min(0).max(32),
    dialling: z.number().int().min(0).max(32),
    connected: z.number().int().min(0).max(32),
    held: z.number().int().min(0).max(32),
  }).strict()).max(100).optional(),
  configurationError: z.enum(['storage_unavailable', 'unsupported_schema', 'invalid_settings', 'engine_failed']).nullable().optional(),
}).strict()
export async function reportDevice(actor: Principal, deviceId: string, input: unknown) {
  const value = reportSchema.parse(input)
  const current = await provisionDevice(actor, deviceId)
  if (value.appliedRevision && value.appliedRevision !== current.revision) throw new ServiceError(409, 'configuration_changed', 'Refresh your configuration before acknowledging it.')
  if (value.registrations?.some(r => !current.accounts.some(a => a.id === r.accountId))) throw new ServiceError(400, 'invalid_registration_report', 'Report only calling accounts assigned to this device.')
  if (value.directCalls && (!value.appliedRevision
    || value.directCalls.length !== current.accounts.filter(a => a.mode === 'direct').length
    || new Set(value.directCalls.map(r => r.accountId)).size !== value.directCalls.length
    || value.directCalls.reduce((total, r) => total + r.ringing + r.dialling + r.connected + r.held, 0) > 32
    || value.directCalls.some(r => !current.accounts.some(a => a.id === r.accountId && a.mode === 'direct')))) {
    throw new ServiceError(400, 'invalid_call_report', 'Report direct calls only for the applied configuration and assigned direct accounts.')
  }
  return transaction(async db => {
    // Receipt and freshness use one clock, including when app/database hosts differ.
    const observedAt = (await rows('SELECT now() AS time', [], db))[0]!.time.toISOString()
    const report = { ...(value.registrations ? { registrations: value.registrations.map(r => ({ ...r, observedAt, source: 'device' })) } : {}),
      ...(value.directCalls ? { directCalls: { accounts: value.directCalls, observedAt, source: 'device', confirmed: true } } : {}),
      ...(value.configurationError !== undefined ? { configurationError: value.configurationError } : {}) }
    const updated = await db.query(`UPDATE devices SET last_seen_at=now(),last_report_at=now(),applied_revision=COALESCE($3,applied_revision),
      status=(CASE WHEN $5 AND status ? 'directCalls' THEN jsonb_set(status,'{directCalls,confirmed}','false'::jsonb) ELSE status END) || $4::jsonb
      WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`, [deviceId, actor.userId, value.appliedRevision ?? null, JSON.stringify(report), Boolean(value.registrations && !value.appliedRevision)])
    if (!updated.rowCount) throw new ServiceError(403, 'device_unavailable', 'This device has been revoked.')
    return { accepted: true, serverTime: observedAt }
  })
}
export async function leaveDevice(actor: Principal, deviceId: string) {
  requireVerified(actor)
  return transaction(async db => {
    const device = (await rows('UPDATE devices SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING organisation_id', [deviceId, actor.userId], db))[0]
    if (!device) {
      if (!(await rows('SELECT id FROM devices WHERE id=$1 AND user_id=$2', [deviceId, actor.userId], db)).length) throw new ServiceError(404, 'not_found', 'Device not found.')
      return { signedOut: true }
    }
    await db.query(`INSERT INTO audit_events (workspace_id,organisation_id,actor_id,action,target_id)
      SELECT workspace_id,id,$2,'device.signed_out',$3 FROM organisations WHERE id=$1`, [device.organisation_id, actor.userId, deviceId])
    return { signedOut: true }
  })
}
