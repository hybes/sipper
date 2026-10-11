import { isPlatformOwner, requireAdminMfa, requireOrganisation, canAdministerOrganisation, lockManagedOrganisation, audit, type Principal } from './access'
import { rows, transaction } from './db'
import { ServiceError } from './errors'
import { getConfig } from './config'
import { z } from 'zod'
import { queuedInvitation } from './jobs'

async function requireServiceOwner(actor: Principal) {
  requireAdminMfa(actor)
  if (!await isPlatformOwner(actor)) throw new ServiceError(404, 'not_found', 'Service operations are unavailable.')
}

export async function failedInvitationEmails(actor: Principal, before?: string) {
  await requireServiceOwner(actor)
  if (before !== undefined) {
    z.uuid().parse(before)
    if (!(await rows("SELECT 1 FROM jobs WHERE id=$1 AND kind='email'", [before])).length) throw new ServiceError(404, 'not_found', 'This delivery page is unavailable. Reload the latest failures.')
  }
  const jobs = await rows(`SELECT id,deduplication_key,attempts,created_at,last_attempt_at FROM jobs
    WHERE kind='email' AND completed_at IS NULL AND attempts>=10 AND (locked_until IS NULL OR locked_until<=now())
    AND ($1::uuid IS NULL OR (coalesce(created_at,'-infinity'::timestamptz),id)<(SELECT coalesce(created_at,'-infinity'::timestamptz),id FROM jobs WHERE id=$1))
    ORDER BY created_at DESC NULLS LAST,id DESC LIMIT 51`, [before ?? null])
  const failures = await Promise.all(jobs.slice(0,50).map(async job => {
    const invitation = await queuedInvitation(job.deduplication_key)
    return { id: job.id, attempts: job.attempts, createdAt: job.created_at, lastAttemptAt: job.last_attempt_at,
      invitation: invitation && { kind: invitation.kind, email: invitation.email, workspaceName: invitation.workspaceName, customerName: invitation.customerName, expiresAt: invitation.expiresAt },
      canRetry: invitation?.available === true }
  }))
  return { failures, nextCursor: jobs.length > 50 ? jobs[49]!.id as string : null }
}

export async function retryInvitationEmail(actor: Principal, jobId: string) {
  await requireServiceOwner(actor)
  return transaction(async db => {
    if (!await isPlatformOwner(actor,db)) throw new ServiceError(404,'not_found','Service operations are unavailable.')
    const job = (await rows("SELECT kind,deduplication_key,attempts,completed_at,locked_until FROM jobs WHERE id=$1 FOR UPDATE", [jobId], db))[0]
    if (!job || job.kind !== 'email') throw new ServiceError(404, 'not_found', 'This invitation delivery is unavailable.')
    if (job.completed_at) throw new ServiceError(409, 'delivery_changed', 'This delivery has already finished. Reload the latest failures.')
    const invitation = await queuedInvitation(job.deduplication_key,db)
    if (!invitation?.available) throw new ServiceError(409, 'invitation_unavailable', 'This invitation is no longer available. Create a new invitation from its workspace or customer.')
    if (job.attempts < 10) return { queued: true }
    if (job.locked_until && job.locked_until > new Date()) throw new ServiceError(409, 'delivery_processing', 'This delivery is already being processed. Reload the latest failures.')
    await db.query('UPDATE jobs SET attempts=0,available_at=now(),locked_until=NULL,lease_id=NULL WHERE id=$1',[jobId])
    await audit(db,actor,invitation.workspaceId,'email.retry_queued',jobId,invitation.organisationId ?? undefined,{ kind:invitation.kind })
    return { queued: true }
  })
}

export async function serviceOverview(actor: Principal) {
  await requireServiceOwner(actor)
  const config = getConfig()
  // Explicit projections: never read provider keys, job payloads, caller data or SIP credentials.
  const workers = await rows(`SELECT id,kind,started_at,progressed_at,stopped_at FROM worker_progress
    WHERE coalesce(progressed_at,started_at)>now()-interval '24 hours' ORDER BY kind,started_at DESC LIMIT 100`)
  const gateways = await rows(`SELECT n.id,n.host,n.port,n.ready_until,n.controller_expires_at,n.last_heartbeat_at,
    (SELECT count(*)::integer FROM active_gateway_credentials g WHERE g.gateway_id=n.id) AS eligible_accounts
    FROM gateway_nodes n ORDER BY n.id`)
  const queues = await rows(`SELECT kind,
    count(*) FILTER (WHERE completed_at IS NULL AND locked_until>now())::integer AS processing,
    count(*) FILTER (WHERE completed_at IS NULL AND (locked_until IS NULL OR locked_until<=now()) AND (kind<>'email' OR attempts<10) AND available_at<=now())::integer AS ready,
    count(*) FILTER (WHERE completed_at IS NULL AND (locked_until IS NULL OR locked_until<=now()) AND (kind<>'email' OR attempts<10) AND available_at>now())::integer AS scheduled,
    count(*) FILTER (WHERE completed_at IS NULL AND (locked_until IS NULL OR locked_until<=now()) AND kind='email' AND attempts>=10)::integer AS exhausted,
    min(available_at) FILTER (WHERE completed_at IS NULL AND (locked_until IS NULL OR locked_until<=now()) AND (kind<>'email' OR attempts<10) AND available_at<=now()) AS oldest_ready_at,
    count(*) FILTER (WHERE completed_at>now()-interval '24 hours' AND last_error IS NULL)::integer AS completed_24h,
    count(*) FILTER (WHERE completed_at>now()-interval '24 hours' AND last_error IS NOT NULL AND last_error NOT IN ('call_unavailable','message_unavailable','invitation_unavailable'))::integer AS failed_24h,
    count(*) FILTER (WHERE completed_at>now()-interval '24 hours' AND last_error IN ('call_unavailable','message_unavailable','invitation_unavailable'))::integer AS skipped_24h
    FROM jobs WHERE kind IN ('email','call_push','message_push','meeting_control') GROUP BY kind ORDER BY kind`)
  const push = await rows(`SELECT 'call' AS kind,provider,count(*) FILTER (WHERE disabled_at IS NULL)::integer AS registered,
    count(*) FILTER (WHERE disabled_at IS NOT NULL)::integer AS disabled,max(last_push_at) AS last_push_at,max(last_wake_at) AS last_wake_at
    FROM push_endpoints GROUP BY provider
    UNION ALL SELECT 'message' AS kind,provider,count(*) FILTER (WHERE disabled_at IS NULL)::integer AS registered,
      count(*) FILTER (WHERE disabled_at IS NOT NULL)::integer AS disabled,max(last_push_at) AS last_push_at,NULL::timestamptz AS last_wake_at
    FROM message_push_endpoints GROUP BY provider ORDER BY kind,provider`)
  return { sampledAt: new Date().toISOString(), gateways, workers, queues, push, configuration: {
    gateway: Boolean(config.SIPPER_GATEWAY_API_KEY && config.SIPPER_GATEWAY_PUBLIC_HOST),
    apns: Boolean(config.SIPPER_APNS_KEY_ID && config.SIPPER_APNS_TEAM_ID && config.SIPPER_APNS_PRIVATE_KEY && config.SIPPER_APNS_TOPIC),
    messageApns: Boolean(config.SIPPER_APNS_KEY_ID && config.SIPPER_APNS_TEAM_ID && config.SIPPER_APNS_PRIVATE_KEY && config.SIPPER_APNS_MESSAGE_TOPIC),
    fcm: Boolean(config.SIPPER_FCM_SERVICE_ACCOUNT),
    billing: Boolean(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET && (config.STRIPE_PRICE_MONTHLY || config.STRIPE_PRICE_ANNUAL)),
    meetings: Boolean(config.SIPPER_MEETING_PUBLIC_URL),
  } }
}

export async function customerCallActivity(actor: Principal, organisationId: string, before?: string, reference?: string) {
  const organisation = await requireOrganisation(actor, organisationId, 'inspect')
  if (reference !== undefined) {
    z.uuid().parse(reference)
    if (before !== undefined) throw new ServiceError(400, 'invalid_query', 'Choose a call reference or a history page, not both.')
  }
  if (before !== undefined) {
    z.uuid().parse(before)
    if (!(await rows('SELECT 1 FROM gateway_calls WHERE organisation_id=$1 AND id=$2', [organisationId, before])).length) throw new ServiceError(404, 'not_found', 'Call history cursor unavailable. Refresh the first page.')
  }
  const calls = await rows(`SELECT c.id,c.direction,c.state,c.end_reason,c.end_requested_at,c.created_at,c.updated_at,c.expires_at,c.claim_until,c.transferred_at,c.transferred_into,
    s.label AS account_label,d.name AS device_name,u.name AS person_name,n.controller_expires_at,n.ready_until,n.last_heartbeat_at,
    (SELECT count(*)::integer FROM call_recipients r WHERE r.call_id=c.id) AS recipient_count,
    (SELECT count(*)::integer FROM call_recipients r WHERE r.call_id=c.id AND r.woken_at IS NOT NULL) AS wake_count
    FROM gateway_calls c JOIN sip_configurations s ON s.id=c.configuration_id
    LEFT JOIN devices d ON d.id=coalesce(c.origin_device_id,c.winner_device_id) LEFT JOIN auth_user u ON u.id=d.user_id
    LEFT JOIN gateway_nodes n ON n.id=c.gateway_id
    WHERE c.organisation_id=$1 AND ($3::uuid IS NULL OR c.id=$3)
    AND ($2::uuid IS NULL OR (c.created_at,c.id)<(SELECT created_at,id FROM gateway_calls WHERE organisation_id=$1 AND id=$2))
    ORDER BY c.created_at DESC,c.id DESC LIMIT 51`, [organisationId, before ?? null, reference ?? null])
  if (reference !== undefined && !calls.length) throw new ServiceError(404, 'not_found', 'This call is unavailable. It may have been removed by the history retention policy.')
  return { organisationName: organisation.name as string, sampledAt: new Date().toISOString(), calls: calls.slice(0,50), canEndCalls: await canAdministerOrganisation(actor.userId, organisationId),
    nextCursor: calls.length>50 ? calls[49]!.id as string : null }
}

export async function requestCallEnd(actor: Principal, organisationId: string, callId: string) {
  return transaction(async db => {
    const org = await lockManagedOrganisation(actor,organisationId,db)
    const call = (await rows('SELECT state,expires_at,end_requested_at FROM gateway_calls WHERE organisation_id=$1 AND id=$2 FOR UPDATE',[organisationId,callId],db))[0]
    if (!call) throw new ServiceError(404,'call_unavailable','This call is unavailable.')
    if (call.state === 'ended' || (!call.end_requested_at && call.state !== 'answered' && call.expires_at.getTime() <= Date.now())) {
      throw new ServiceError(409,'call_not_active','This call is already ended or expired. Refresh the call history.')
    }
    if (call.end_requested_at) return { requestedAt:call.end_requested_at }
    const updated = (await rows('UPDATE gateway_calls SET end_requested_at=now(),caller_envelope=NULL,updated_at=now(),version=version+1 WHERE id=$1 RETURNING end_requested_at',[callId],db))[0]!
    await audit(db,actor,org.workspace_id,'gateway_call.end_requested',callId,organisationId)
    return { requestedAt:updated.end_requested_at }
  })
}
