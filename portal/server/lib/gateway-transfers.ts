import { z } from 'zod'
import { rows, transaction, type Database } from './db'
import { openSecret, sealSecret } from './crypto'
import { ServiceError } from './errors'

const id = z.uuid().transform(value => value.toLowerCase())
const admit = z.object({ transferId: id, callId: id, deviceId: id,
  destination: z.string().regex(/^[+0-9*#]{1,128}$/).optional(), consultationCallId: id.optional(),
}).strict().refine(value => (value.destination === undefined) !== (value.consultationCallId === undefined))
const unavailable = () => new ServiceError(409, 'transfer_unavailable', 'These calls are no longer available to transfer.')

async function controller(db: Database, gatewayId: string, instanceId: string) {
  const node = (await rows(`SELECT ready_until>now() AS ready FROM gateway_nodes WHERE id=$1
    AND controller_instance=$2 AND controller_expires_at>now() FOR SHARE`, [gatewayId,instanceId], db))[0]
  if (!node) throw new ServiceError(409, 'gateway_lease_lost', 'This controller does not own the gateway lease.')
  return node
}
async function lockCalls(db: Database, callId: string, consultationCallId?: string | null) {
  // Both admission and completion use this order, including opposite-direction attempts.
  return rows(`SELECT * FROM gateway_calls WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[callId,consultationCallId].filter(Boolean)], db)
}
function snapshot(attempt: Record<string, any>) {
  return { id: attempt.id, state: attempt.state, callId: attempt.call_id, consultationCallId: attempt.consultation_call_id,
    deviceId: attempt.device_id, configurationId: attempt.configuration_id, revision: attempt.configuration_revision,
    expiresAt: attempt.expires_at }
}

/** Reconcile an admission whose HTTP response or local outcome was lost. */
export async function pendingGatewayTransfers(gatewayId: string, instanceId: string) {
  return transaction(async db => {
    await controller(db, gatewayId, instanceId)
    return { transfers: (await rows(`SELECT id,call_id,consultation_call_id FROM gateway_transfers
      WHERE gateway_id=$1 AND state='pending' ORDER BY created_at`, [gatewayId], db)).map(attempt => ({
      id: attempt.id, callId: attempt.call_id, consultationCallId: attempt.consultation_call_id,
    })) }
  })
}

/** Called only by the owning controller after identifying the actual SIP channel. */
export async function admitGatewayTransfer(gatewayId: string, instanceId: string, input: unknown) {
  const value = admit.parse(input)
  if (value.callId === value.consultationCallId) throw unavailable()
  return transaction(async db => {
    const node = await controller(db, gatewayId, instanceId)
    const calls = await lockCalls(db, value.callId, value.consultationCallId)
    const call = calls.find(call => call.id === value.callId)
    const existing = (await rows('SELECT * FROM gateway_transfers WHERE id=$1 FOR UPDATE', [value.transferId], db))[0]
    if (existing) {
      if (existing.gateway_id !== gatewayId || existing.call_id !== value.callId || existing.device_id !== value.deviceId
        || existing.consultation_call_id !== (value.consultationCallId ?? null)
        || (existing.destination_envelope && openSecret(existing.destination_envelope, `transfer:${existing.id}`) !== value.destination)) {
        throw new ServiceError(409, 'transfer_id_conflict', 'This transfer identifier is already in use.')
      }
      // A completed request is a result, never permission to repeat bridge changes.
      if (existing.state !== 'pending') return snapshot(existing)
      if (existing.expires_at.getTime() <= Date.now()) throw unavailable()
    }
    if (!node.ready) throw new ServiceError(503, 'gateway_not_ready', 'The calling gateway is not ready.')
    if (!call || calls.length !== (value.consultationCallId ? 2 : 1)
      || calls.some(item => item.gateway_id !== gatewayId || item.organisation_id !== call.organisation_id
        || item.configuration_id !== call.configuration_id || item.state !== 'answered' || item.end_requested_at || item.transferred_at
        || (item.direction === 'incoming' ? item.winner_device_id : item.origin_device_id) !== value.deviceId)) throw unavailable()
    const configuration = (await rows(`SELECT c.revision FROM active_gateway_credentials g
      JOIN sip_configurations c ON c.id=g.configuration_id
      WHERE g.gateway_id=$1 AND g.device_id=$2 AND g.configuration_id=$3`, [gatewayId,value.deviceId,call.configuration_id], db))[0]
    if (!configuration || calls.some(item => item.configuration_revision !== configuration.revision)
      || (existing && existing.configuration_revision !== configuration.revision)) throw unavailable()
    const occupied = await rows(`SELECT id FROM gateway_transfers WHERE state='pending' AND id<>$2
      AND (call_id=ANY($1::uuid[]) OR consultation_call_id=ANY($1::uuid[]))`, [calls.map(call => call.id),value.transferId], db)
    if (occupied.length) throw new ServiceError(409, 'transfer_pending', 'A transfer is already in progress.')
    if (existing) return snapshot(existing)
    const created = (await rows(`INSERT INTO gateway_transfers
      (id,gateway_id,organisation_id,call_id,consultation_call_id,device_id,configuration_id,configuration_revision,destination_envelope)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [value.transferId,gatewayId,call.organisation_id,call.id,value.consultationCallId ?? null,value.deviceId,
      call.configuration_id,configuration.revision,value.destination ? sealSecret(value.destination, `transfer:${value.transferId}`) : null], db))[0]!
    return snapshot(created)
  })
}

/** Reports observed bridge completion/failure, including replay after recovery. */
export async function gatewayTransfer(gatewayId: string, instanceId: string, transferId: string, input?: unknown) {
  const change = input === undefined ? undefined : z.object({ state: z.enum(['completed','failed']) }).strict().parse(input)
  return transaction(async db => {
    await controller(db, gatewayId, instanceId)
    const prior = (await rows('SELECT * FROM gateway_transfers WHERE id=$1 AND gateway_id=$2', [transferId,gatewayId], db))[0]
    if (!prior) throw new ServiceError(404, 'transfer_unavailable', 'This transfer is unavailable.')
    const calls = await lockCalls(db, prior.call_id, prior.consultation_call_id)
    let attempt = (await rows('SELECT * FROM gateway_transfers WHERE id=$1 FOR UPDATE', [transferId], db))[0]
    if (!attempt) throw new ServiceError(404, 'transfer_unavailable', 'This transfer is unavailable.')
    if (change && attempt.state !== 'pending' && attempt.state !== change.state) {
      throw new ServiceError(409, 'transfer_finished', 'This transfer already has a final result.')
    }
    if (change && attempt.state === 'pending') {
      attempt = (await rows('UPDATE gateway_transfers SET state=$2,completed_at=now() WHERE id=$1 RETURNING *', [transferId,change.state], db))[0]!
      if (change.state === 'completed') {
        await db.query(`UPDATE gateway_calls SET transferred_at=now(),version=version+1,updated_at=now()
          WHERE id=$1`, [attempt.call_id])
        if (attempt.consultation_call_id) {
          // Media continues under call_id. Do not revive a call already ended by its controller.
          await db.query(`UPDATE gateway_calls SET transferred_at=now(),transferred_into=$2,state='ended',
            end_reason=COALESCE(end_reason,'completed'),caller_envelope=NULL,claim_until=NULL,version=version+1,updated_at=now()
            WHERE id=$1`, [attempt.consultation_call_id,attempt.call_id])
        }
      }
    }
    return { ...snapshot(attempt), endRequested: calls.some(call => Boolean(call.end_requested_at)) }
  })
}
