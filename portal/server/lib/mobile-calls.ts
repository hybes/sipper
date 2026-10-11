import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { rows, transaction, type Database } from './db'
import { getConfig } from './config'
import { openSecret, sealSecret } from './crypto'
import { ServiceError } from './errors'
import { requireVerified, type Principal } from './access'
import { requireLicensedMember } from './platform'

type GatewayCall = { id: string; gateway_id: string; organisation_id: string; configuration_id: string;
  direction: 'incoming' | 'outgoing'; origin_device_id: string | null; configuration_revision: number | null;
  state: 'ringing' | 'answering' | 'answered' | 'ended'; end_reason: string | null; end_requested_at: Date | null;
  caller_envelope: ReturnType<typeof sealSecret> | null; winner_device_id: string | null;
  claim_until: Date | null; version: number; expires_at: Date }

export function gatewayPrincipal(authorization: string | undefined) {
  const config = getConfig(), expected = config.SIPPER_GATEWAY_API_KEY
  if (!expected) throw new ServiceError(503, 'gateway_not_configured', 'The calling gateway is not configured.')
  const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!timingSafeEqual(createHash('sha256').update(presented).digest(), createHash('sha256').update(expected).digest())) {
    throw new ServiceError(401, 'invalid_gateway', 'Gateway authentication required.')
  }
  return config.SIPPER_GATEWAY_ID
}

async function ownedDevice(actor: Principal, deviceId: string, db: Database, allowRevoked = false) {
  requireVerified(actor)
  const device = (await rows('SELECT * FROM devices WHERE id=$1 AND user_id=$2 AND (revoked_at IS NULL OR $3) FOR UPDATE', [deviceId, actor.userId, allowRevoked], db))[0]
  if (!device) throw new ServiceError(404, 'device_unavailable', 'This device is unavailable.')
  return device
}
export async function savePushToken(actor: Principal, deviceId: string, input: unknown) {
  const value = z.object({ token: z.string().min(20).max(4096).regex(/^[a-zA-Z0-9_:-]+$/) }).strict().parse(input)
  return transaction(async db => {
    const device = await ownedDevice(actor, deviceId, db)
    await requireLicensedMember(actor, device.organisation_id, db)
    if (!['ios', 'android'].includes(device.platform)) throw new ServiceError(400, 'unsupported_push_platform', 'Push is available for iOS and Android devices.')
    const provider = device.platform === 'ios' ? 'apns' : 'fcm'
    if (provider === 'apns' && (!/^[a-fA-F0-9]+$/.test(value.token) || value.token.length % 2 !== 0 || value.token.length > 512)) {
      throw new ServiceError(400, 'invalid_push_token', 'The push token is invalid.')
    }
    const token = provider === 'apns' ? value.token.toLowerCase() : value.token
    await db.query(`INSERT INTO push_endpoints (device_id,provider,token_envelope,token_revision) VALUES ($1,$2,$3,$4)
      ON CONFLICT (device_id) DO UPDATE SET provider=$2,token_envelope=$3,token_revision=$4,updated_at=now(),disabled_at=NULL,last_push_status=NULL`,
    [deviceId, provider, sealSecret(token, `push:${device.organisation_id}:${deviceId}`), randomUUID()])
    return { registered: true, provider }
  })
}
export async function removePushToken(actor: Principal, deviceId: string) {
  return transaction(async db => {
    await ownedDevice(actor, deviceId, db)
    await db.query('DELETE FROM push_endpoints WHERE device_id=$1', [deviceId])
    return { removed: true }
  })
}

const callerText = z.string().max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const incomingSchema = z.object({ callId: z.uuid(), configurationId: z.uuid(), configurationRevision: z.number().int().positive().optional(),
  caller: z.object({ name: callerText, number: callerText }).strict(), ringSeconds: z.number().int().min(5).max(90).default(45) }).strict()

// Only the authenticated SIP gateway may create a call. Native apps cannot fabricate a wakeup.
export async function incomingGatewayCall(gatewayId: string, input: unknown) {
  const value = incomingSchema.parse(input)
  return transaction(async db => {
    const config = (await rows("SELECT id,organisation_id,revision FROM sip_configurations WHERE id=$1 AND mode='gateway'", [value.configurationId], db))[0]
    if (!config) throw new ServiceError(404, 'gateway_account_unavailable', 'The gateway account is unavailable.')
    if (value.configurationRevision !== undefined && value.configurationRevision !== config.revision) throw new ServiceError(409, 'gateway_account_changed', 'Refresh the gateway account before accepting calls.')
    const inserted = await rows<GatewayCall>(`INSERT INTO gateway_calls (id,gateway_id,organisation_id,configuration_id,caller_envelope,expires_at,configuration_revision)
      VALUES ($1,$2,$3,$4,$5,now()+($6*interval '1 second'),$7) ON CONFLICT DO NOTHING RETURNING *`,
    [value.callId, gatewayId, config.organisation_id, config.id, sealSecret(JSON.stringify(value.caller), `call:${value.callId}`), value.ringSeconds,config.revision], db)
    const call = inserted[0] ?? (await rows<GatewayCall>('SELECT * FROM gateway_calls WHERE id=$1 FOR UPDATE', [value.callId], db))[0]
    if (!call || call.direction !== 'incoming' || call.gateway_id !== gatewayId || call.configuration_id !== config.id) throw new ServiceError(409, 'call_id_conflict', 'This call identifier is already in use.')
    if (inserted.length) {
      // DND applies at admission only. Keep existing recipients, registration and
      // outgoing eligibility intact when the person changes this preference.
      const recipients = await rows(`INSERT INTO call_recipients (organisation_id,call_id,device_id)
        SELECT e.organisation_id,$1,e.device_id FROM eligible_gateway_devices e
        JOIN organisation_members m ON m.organisation_id=e.organisation_id AND m.user_id=e.user_id
        WHERE e.configuration_id=$2 AND NOT m.do_not_disturb RETURNING device_id`, [call.id, config.id], db)
      for (const recipient of recipients) {
        // The queue stores references only, never a push token, SIP secret or caller identity.
        await db.query(`INSERT INTO jobs (kind,deduplication_key,payload)
          SELECT 'call_push',$1,$2 WHERE EXISTS (SELECT 1 FROM push_endpoints WHERE device_id=$3 AND disabled_at IS NULL)
          ON CONFLICT (deduplication_key) DO NOTHING`, [`call_push:${call.id}:${recipient.device_id}`, { callId: call.id, deviceId: recipient.device_id }, recipient.device_id])
      }
      if (!recipients.length) await endCall(db, call.id, 'rejected')
    }
    const current = await currentCall(db, call.id)
    return { id: current.id, state: current.state, version: current.version, expiresAt: current.expires_at, endRequested:Boolean(current.end_requested_at) }
  })
}

async function endCall(db: Database, id: string, reason: string): Promise<GatewayCall> {
  const call = (await rows<GatewayCall>(`UPDATE gateway_calls SET state='ended',end_reason=$2,claim_until=NULL,caller_envelope=NULL,
    version=version+1,updated_at=now() WHERE id=$1 AND state<>'ended' RETURNING *`, [id, reason], db))[0]
  await db.query(`UPDATE jobs SET completed_at=now(),payload='{}',last_error='call_ended'
    WHERE kind='call_push' AND payload->>'callId'=$1 AND completed_at IS NULL AND locked_until IS NULL`, [id])
  const current = call ?? (await rows<GatewayCall>('SELECT * FROM gateway_calls WHERE id=$1', [id], db))[0]
  if (!current) throw new ServiceError(404, 'call_unavailable', 'This call is unavailable.')
  return current
}

async function currentCall(db: Database, id: string): Promise<GatewayCall> {
  let call = (await rows<GatewayCall>('SELECT * FROM gateway_calls WHERE id=$1 FOR UPDATE', [id], db))[0]
  if (!call) throw new ServiceError(404, 'call_unavailable', 'This call is unavailable.')
  if (!call.end_requested_at && ['ringing', 'answering'].includes(call.state) && new Date(call.expires_at).getTime() <= Date.now()) call = await endCall(db, id, 'timed_out')
  else if (!call.end_requested_at && call.state === 'answering' && (call.claim_until?.getTime() ?? 0) <= Date.now()) {
    call = (await rows<GatewayCall>(`UPDATE gateway_calls SET state='ringing',winner_device_id=NULL,claim_until=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [id], db))[0]!
  }
  return call
}
function clientSnapshot(call: GatewayCall, deviceId: string) {
  return { id: call.id, configurationId: call.configuration_id, state: call.state, reason: call.end_reason,
    version: call.version, expiresAt: new Date(call.expires_at).toISOString(),
    claimedByThisDevice: call.winner_device_id === deviceId,
    ...(call.caller_envelope ? { caller: JSON.parse(openSecret(call.caller_envelope, `call:${call.id}`)) } : {}) }
}
async function eligible(db: Database, deviceId: string, configurationId: string) {
  return Boolean((await rows('SELECT 1 FROM eligible_gateway_devices WHERE device_id=$1 AND configuration_id=$2', [deviceId, configurationId], db))[0])
}

async function declineCall(db: Database, call: GatewayCall, deviceId: string) {
  if (!(await rows('SELECT 1 FROM call_recipients WHERE call_id=$1 AND device_id=$2', [call.id,deviceId], db))[0]) throw new ServiceError(404, 'call_unavailable', 'This device is not a call recipient.')
  if (!call.end_requested_at && ['ringing', 'answering'].includes(call.state)) {
    await db.query('UPDATE call_recipients SET declined_at=COALESCE(declined_at,now()) WHERE call_id=$1 AND device_id=$2', [call.id, deviceId])
    if (call.winner_device_id === deviceId) call = (await rows<GatewayCall>(`UPDATE gateway_calls SET state='ringing',winner_device_id=NULL,
      claim_until=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [call.id], db))[0]!
    const remaining = await rows(`SELECT 1 FROM call_recipients r JOIN eligible_gateway_devices e ON e.device_id=r.device_id AND e.configuration_id=$2
      WHERE r.call_id=$1 AND r.declined_at IS NULL LIMIT 1`, [call.id, call.configuration_id], db)
    if (!remaining.length) call = await endCall(db, call.id, 'rejected')
  }
  return call
}

export async function deviceCall(actor: Principal, deviceId: string, callId: string, action: 'status' | 'wake' | 'answer' | 'decline') {
  return transaction(async db => {
    await ownedDevice(actor, deviceId, db, true)
    if (!(await rows('SELECT 1 FROM call_recipients WHERE call_id=$1 AND device_id=$2', [callId, deviceId], db))[0]) throw new ServiceError(404, 'call_unavailable', 'This call is unavailable.')
    let call = await currentCall(db, callId)
    if (!await eligible(db, deviceId, call.configuration_id)) {
      if (call.state === 'answered' && call.winner_device_id === deviceId) return clientSnapshot({ ...call, caller_envelope: null }, deviceId)
      // The app can dismiss its CallKit/Telecom alert after suspension, without receiving caller data.
      return { ...clientSnapshot({ ...call, caller_envelope: null, state: 'ended', end_reason: 'access_withdrawn' }, deviceId), claimedByThisDevice: false }
    }
    if (action === 'wake') {
      await db.query('UPDATE call_recipients SET woken_at=COALESCE(woken_at,now()) WHERE call_id=$1 AND device_id=$2', [callId, deviceId])
      await db.query('UPDATE push_endpoints SET last_wake_at=now() WHERE device_id=$1', [deviceId])
    }
    if (action === 'answer' && !['ended', 'answered'].includes(call.state)) {
      if (call.end_requested_at) throw new ServiceError(409,'call_taken','An administrator has requested that this call end.')
      const recipient = (await rows('SELECT declined_at FROM call_recipients WHERE call_id=$1 AND device_id=$2', [callId, deviceId], db))[0]!
      if (!recipient || recipient.declined_at || (call.winner_device_id && call.winner_device_id !== deviceId)) throw new ServiceError(409, 'call_taken', 'This call is no longer available to answer.')
      // Claim only; the gateway confirms actual SIP connection. No second device can win the row lock.
      if (call.state === 'ringing') call = (await rows<GatewayCall>(`UPDATE gateway_calls SET state='answering',winner_device_id=$2,
        claim_until=LEAST(expires_at,now()+interval '8 seconds'),version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [callId, deviceId], db))[0]!
    }
    if (action === 'decline') call = await declineCall(db, call, deviceId)
    return clientSnapshot(call, deviceId)
  })
}

export async function gatewayCall(gatewayId: string, callId: string, input?: unknown) {
  const change = input === undefined ? null : z.discriminatedUnion('event', [
    z.object({ event: z.literal('answer'), deviceId: z.uuid() }).strict(),
    z.object({ event: z.literal('decline'), deviceId: z.uuid() }).strict(),
    z.object({ event: z.literal('connected'), deviceId: z.uuid() }).strict(),
    z.object({ event: z.literal('ended'), reason: z.enum(['caller_cancelled', 'completed', 'rejected', 'timed_out', 'failed', 'admin_ended']) }).strict(),
  ]).parse(input)
  return transaction(async db => {
    if (!(await rows('SELECT 1 FROM gateway_calls WHERE id=$1 AND gateway_id=$2', [callId, gatewayId], db))[0]) throw new ServiceError(404, 'call_unavailable', 'This call is unavailable.')
    let call = await currentCall(db, callId)
    if (change?.event === 'ended' && change.reason === 'admin_ended' && !call.end_requested_at) {
      throw new ServiceError(409,'end_not_requested','No administrator has requested that this call end.')
    }
    // Keep the actual lifecycle unchanged while refusing new answer/connection
    // transitions. The controller reads the request and confirms after hangup.
    if (call.end_requested_at && change && ['answer','connected'].includes(change.event)) {
      return { id:call.id,state:call.state,reason:call.end_reason,version:call.version,winnerDeviceId:call.winner_device_id,
        claimUntil:call.claim_until,expiresAt:call.expires_at,targets:[],endRequested:true }
    }
    if (call.direction === 'outgoing') {
      if (change && !['connected','ended'].includes(change.event)) throw new ServiceError(409,'outgoing_call','An outgoing call cannot be answered or declined by a recipient.')
      if (change?.event === 'connected') {
        const current = await rows('SELECT 1 FROM eligible_gateway_devices e JOIN sip_configurations c ON c.id=e.configuration_id WHERE e.device_id=$1 AND e.configuration_id=$2 AND c.revision=$3', [change.deviceId,call.configuration_id,call.configuration_revision],db)
        if (!['ringing','answered'].includes(call.state) || call.origin_device_id!==change.deviceId || (call.state!=='answered' && !current.length)) {
          throw new ServiceError(409,'call_unavailable','This device cannot connect the outgoing call.')
        }
        if (call.state!=='answered') call = (await rows<GatewayCall>("UPDATE gateway_calls SET state='answered',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[callId],db))[0]!
      } else if (change?.event === 'ended') call = await endCall(db,callId,change.reason)
      return { id:call.id,state:call.state,reason:call.end_reason,version:call.version,winnerDeviceId:null,claimUntil:null,expiresAt:call.expires_at,targets:[],endRequested:Boolean(call.end_requested_at) }
    }
    if (change?.event === 'answer') {
      const recipient = (await rows('SELECT declined_at FROM call_recipients WHERE call_id=$1 AND device_id=$2', [callId,change.deviceId], db))[0]
      if (!recipient || recipient.declined_at || !await eligible(db, change.deviceId, call.configuration_id)
        || call.state === 'ended' || (call.winner_device_id && call.winner_device_id !== change.deviceId)) {
        throw new ServiceError(409, 'call_taken', 'This device cannot answer the call.')
      }
      if (call.state === 'ringing') call = (await rows<GatewayCall>(`UPDATE gateway_calls SET state='answering',winner_device_id=$2,
        claim_until=LEAST(expires_at,now()+interval '8 seconds'),version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [callId,change.deviceId], db))[0]!
    }
    if (change?.event === 'decline') call = await declineCall(db, call, change.deviceId)
    if (change?.event === 'connected') {
      if (!['answering', 'answered'].includes(call.state) || call.winner_device_id !== change.deviceId
        || (call.state !== 'answered' && !await eligible(db, change.deviceId, call.configuration_id))) throw new ServiceError(409, 'call_not_claimed', 'The device has no active claim for this call.')
      if (call.state !== 'answered') call = (await rows<GatewayCall>(`UPDATE gateway_calls SET state='answered',claim_until=NULL,caller_envelope=NULL,
        version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [callId], db))[0]!
    } else if (change?.event === 'ended') call = await endCall(db, callId, change.reason)
    const targets = !call.end_requested_at && ['ringing','answering'].includes(call.state) ? await rows(`SELECT g.device_id AS "deviceId",g.username
      FROM call_recipients r JOIN active_gateway_credentials g ON g.device_id=r.device_id AND g.configuration_id=$2
      WHERE r.call_id=$1 AND g.gateway_id=$3 AND r.declined_at IS NULL`, [callId,call.configuration_id,gatewayId], db) : []
    return { id: call.id, state: call.state, reason: call.end_reason, version: call.version, winnerDeviceId: call.winner_device_id,
      claimUntil: call.claim_until, expiresAt: call.expires_at, targets, endRequested:Boolean(call.end_requested_at) }
  })
}

export async function cleanUpCalls() {
  await transaction(async db => {
    const expired = await rows("SELECT id FROM gateway_calls WHERE state IN ('ringing','answering') AND end_requested_at IS NULL AND expires_at<=now() FOR UPDATE SKIP LOCKED", [], db)
    for (const call of expired) await endCall(db, call.id, 'timed_out')
    await db.query("DELETE FROM gateway_calls WHERE state='ended' AND updated_at<now()-($1*interval '1 hour')", [getConfig().SIPPER_CALL_RETENTION_HOURS])
    await db.query("DELETE FROM jobs WHERE kind IN ('call_push','message_push') AND completed_at<now()-($1*interval '1 hour')", [getConfig().SIPPER_CALL_RETENTION_HOURS])
  })
}
