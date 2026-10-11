import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { rows, transaction } from './db'
import { openSecret } from './crypto'
import { getPushSender, type IncomingPush, type MessagePush, type PushOutcome } from './push-providers'
import { getConfig } from './config'

type Deliver = (push: IncomingPush) => Promise<PushOutcome>
type DeliverMessage = (push: MessagePush) => Promise<PushOutcome>
export async function runOnePushJob(deliver: Deliver = push => getPushSender().send(push), deliverMessage: DeliverMessage = push => getPushSender().send(push)) {
  const lease = randomUUID()
  const job = (await rows(`UPDATE jobs SET locked_until=now()+interval '30 seconds',attempts=attempts+1,lease_id=$1 WHERE id=(
    SELECT id FROM jobs WHERE kind IN ('call_push','message_push') AND completed_at IS NULL AND available_at<=now()
    AND (locked_until IS NULL OR locked_until<now()) ORDER BY (kind='call_push') DESC,available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [lease]))[0]
  if (!job) return false
  try {
    if(job.kind==='message_push') {
      const value=z.object({messageId:z.uuid(),deviceId:z.uuid()}).strict().parse(job.payload)
      const target=(await rows(`SELECT t.conversation_id,t.organisation_id,t.created_at+interval '5 minutes' AS expires_at,e.provider,e.token_envelope,e.token_revision
        FROM text_messages t JOIN conversation_members m ON m.conversation_id=t.conversation_id
        JOIN eligible_message_devices d ON d.device_id=$2 AND d.user_id=m.user_id AND d.organisation_id=t.organisation_id
        JOIN message_push_endpoints e ON e.device_id=d.device_id AND e.disabled_at IS NULL
        WHERE t.id=$1 AND t.sender_id IS DISTINCT FROM d.user_id AND t.sequence>GREATEST(m.last_read_sequence,m.joined_sequence)
        AND t.created_at>now()-interval '5 minutes' AND t.created_at>now()-($3*interval '1 day')
        AND NOT EXISTS(SELECT 1 FROM text_messages later WHERE later.conversation_id=t.conversation_id
          AND later.sequence>t.sequence AND later.sender_id IS DISTINCT FROM d.user_id)`,[value.messageId,value.deviceId,getConfig().SIPPER_MESSAGE_RETENTION_DAYS]))[0]
      if(!target) {await finish(job.id,lease,'message_unavailable');return true}
      const token=openSecret(target.token_envelope,`message-push:${target.organisation_id}:${value.deviceId}`)
      const outcome=await deliverMessage({provider:target.provider,token,deviceId:value.deviceId,conversationId:target.conversation_id,notificationId:job.id,expiresAt:target.expires_at.toISOString()})
      await recordOutcome(job,lease,value.deviceId,target,outcome,'message_push_endpoints')
      return true
    }
    const value = z.object({ callId: z.uuid(), deviceId: z.uuid() }).parse(job.payload)
    const target = (await rows(`SELECT c.expires_at,e.provider,e.token_envelope,e.token_revision,r.organisation_id
      FROM gateway_calls c JOIN call_recipients r ON r.call_id=c.id
      JOIN eligible_gateway_devices d ON d.device_id=r.device_id AND d.configuration_id=c.configuration_id
      JOIN push_endpoints e ON e.device_id=r.device_id AND e.disabled_at IS NULL
      WHERE c.id=$1 AND r.device_id=$2 AND c.state IN ('ringing','answering') AND c.end_requested_at IS NULL AND c.expires_at>now() AND r.declined_at IS NULL`, [value.callId, value.deviceId]))[0]
    if (!target) {
      await finish(job.id, lease, 'call_unavailable')
      return true
    }
    const token = openSecret(target.token_envelope, `push:${target.organisation_id}:${value.deviceId}`)
    const outcome = await deliver({ provider: target.provider, token, callId: value.callId, deviceId: value.deviceId, notificationId: job.id, expiresAt: new Date(target.expires_at).toISOString() })
    await recordOutcome(job,lease,value.deviceId,target,outcome,'push_endpoints')
  } catch {
    // No exception text: provider and decryption errors may contain tokens or sensitive payloads.
    await finish(job.id, lease, 'push_failed')
  }
  return true
}
async function recordOutcome(job: any, lease: string, deviceId: string, target: any, outcome: PushOutcome, table: 'push_endpoints' | 'message_push_endpoints') {
  await transaction(async db=>{
    // Old leases and token revisions cannot overwrite a replacement's health.
    if(!(await rows('SELECT 1 FROM jobs WHERE id=$1 AND lease_id=$2 AND completed_at IS NULL FOR UPDATE',[job.id,lease],db))[0]) return
    await db.query(`UPDATE ${table} SET last_push_at=now(),last_push_status=$3,
      disabled_at=CASE WHEN $3='invalid_token' THEN now() ELSE disabled_at END,
      token_envelope=CASE WHEN $3='invalid_token' THEN '{}'::jsonb ELSE token_envelope END
      WHERE device_id=$1 AND token_revision=$2`,[deviceId,target.token_revision,outcome])
    if(outcome==='retry' && job.attempts<4 && new Date(target.expires_at).getTime()>Date.now()+2000)
      await db.query("UPDATE jobs SET locked_until=NULL,available_at=now()+interval '2 seconds',last_error='provider_retry' WHERE id=$1 AND lease_id=$2",[job.id,lease])
    else await db.query("UPDATE jobs SET completed_at=now(),locked_until=NULL,payload='{}',last_error=$3 WHERE id=$1 AND lease_id=$2",[job.id,lease,outcome==='accepted' ? null : outcome])
  })
}
async function finish(id: string, lease: string, reason: string) {
  await rows("UPDATE jobs SET completed_at=now(),locked_until=NULL,payload='{}',last_error=$3 WHERE id=$1 AND lease_id=$2", [id, lease, reason])
}
