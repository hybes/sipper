import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { rows, transaction, type Database } from './db'
import { getConfig } from './config'
import { sealSecret, openSecret } from './crypto'
import { ServiceError } from './errors'
import type { SipSettings } from '../../shared/contracts'
import { z } from 'zod'

// One controller owns the configured gateway at a time. A restarted controller
// waits for the old lease rather than creating competing upstream registrations.
export async function gatewayHeartbeat(gatewayId: string, input: unknown) {
  const value = z.object({ instanceId: z.uuid(), ready: z.boolean() }).strict().parse(input)
  const config = getConfig()
  if (!config.SIPPER_GATEWAY_PUBLIC_HOST) throw new ServiceError(503, 'gateway_not_configured', 'Configure the public SIP gateway address first.')
  const node = (await rows(`INSERT INTO gateway_nodes (id,host,port,ready_until,controller_instance,controller_expires_at,last_heartbeat_at)
    VALUES ($1,$2,$3,now()+($5*interval '30 seconds'),$4,now()+interval '30 seconds',now())
    ON CONFLICT (id) DO UPDATE SET host=$2,port=$3,ready_until=now()+($5*interval '30 seconds'),
      controller_instance=$4,controller_expires_at=now()+interval '30 seconds',last_heartbeat_at=now(),
      registration_generation=CASE WHEN $5=0 OR gateway_nodes.controller_instance IS DISTINCT FROM $4::uuid
        OR gateway_nodes.ready_until<=now() OR gateway_nodes.controller_expires_at<=now()
        THEN gen_random_uuid() ELSE gateway_nodes.registration_generation END
    WHERE gateway_nodes.controller_instance=$4 OR gateway_nodes.controller_expires_at IS NULL OR gateway_nodes.controller_expires_at<=now()
    RETURNING ready_until,controller_expires_at,registration_generation`, [gatewayId,config.SIPPER_GATEWAY_PUBLIC_HOST,config.SIPPER_GATEWAY_PUBLIC_PORT,value.instanceId,value.ready ? 1 : 0]))[0]
  if (!node) throw new ServiceError(409, 'gateway_already_owned', 'Another controller holds this gateway lease.')
  return { gatewayId, readyUntil: node.ready_until, leaseUntil: node.controller_expires_at, registrationGeneration: node.registration_generation }
}

export async function requireGatewayController(gatewayId: string, instanceId: string | undefined) {
  if (!instanceId || !z.uuid().safeParse(instanceId).success || !(await rows(`SELECT 1 FROM gateway_nodes
    WHERE id=$1 AND controller_instance=$2 AND controller_expires_at>now()`, [gatewayId,instanceId])).length) {
    throw new ServiceError(409, 'gateway_lease_lost', 'This controller does not own the gateway lease.')
  }
}

export async function releaseGatewayController(gatewayId: string, instanceId: string) {
  // Conditional release: an expired process must never withdraw its replacement.
  await rows(`UPDATE gateway_nodes SET ready_until=now(),controller_instance=NULL,controller_expires_at=NULL
    WHERE id=$1 AND controller_instance=$2 RETURNING id`, [gatewayId,instanceId])
  return { released: true }
}

export async function gatewayUpstreams(gatewayId: string) {
  if (gatewayId !== getConfig().SIPPER_GATEWAY_ID) throw new ServiceError(403, 'invalid_gateway', 'Gateway unavailable.')
  const configurations = await rows(`SELECT c.* FROM sip_configurations c WHERE c.mode='gateway'
    AND EXISTS (SELECT 1 FROM eligible_gateway_devices e WHERE e.configuration_id=c.id) ORDER BY c.id`)
  const endpoints = await rows('SELECT username FROM active_gateway_credentials WHERE gateway_id=$1 ORDER BY username', [gatewayId])
  return { endpoints: endpoints.map(row => row.username as string), accounts: configurations.map(c => ({ id: c.id, revision: c.revision, settings: c.settings,
    password: openSecret(c.secret_envelope, `sip:${c.organisation_id}:${c.id}`) })) }
}

async function lockRegistrationObserver(db: Database, gatewayId: string, instanceId: string, generation: string) {
  // Keep ownership locked until observation writes commit, including when a
  // replaced controller passed the earlier HTTP-level lease check.
  const node = (await rows(`SELECT ready_until>now() AS ready,registration_generation FROM gateway_nodes WHERE id=$1 AND controller_instance=$2
    AND controller_expires_at>now() FOR UPDATE`, [gatewayId,instanceId], db))[0]
  if (!node) throw new ServiceError(409, 'gateway_lease_lost', 'This controller does not own the gateway lease.')
  if (!node.ready) throw new ServiceError(503, 'gateway_not_ready', 'The calling gateway is not ready.')
  if (node.registration_generation !== generation) throw new ServiceError(409, 'registration_generation_changed', 'Collect a fresh registration snapshot after gateway recovery.')
}

export async function recordUpstreamRegistrations(gatewayId: string, instanceId: string, input: unknown) {
  const value = z.object({ registrationGeneration: z.uuid().transform(value => value.toLowerCase()), reports: z.array(z.object({ configurationId: z.uuid().transform(value => value.toLowerCase()),
    revision: z.number().int().positive().max(2147483647), state: z.enum(['registered', 'unregistered', 'failed']), observedAt: z.iso.datetime(),
  }).strict()).min(1).max(20) }).strict().parse(input)
  if (new Set(value.reports.map(report => report.configurationId)).size !== value.reports.length
    || value.reports.some(report => Date.parse(report.observedAt) > Date.now() + 5000 || Date.parse(report.observedAt) < Date.now() - 30_000)) {
    throw new ServiceError(400, 'invalid_registration_observation', 'Send a recent registration snapshot.')
  }
  return transaction(async db => {
    await lockRegistrationObserver(db, gatewayId, instanceId, value.registrationGeneration)
    await db.query(`INSERT INTO gateway_upstream_registrations (gateway_id,configuration_id,revision,state,observed_at,controller_instance,registration_generation)
      SELECT $1,c.id,r.revision,r.state,r."observedAt"::timestamptz,$2,$4
      FROM jsonb_to_recordset($3::jsonb) AS r("configurationId" uuid,revision integer,state text,"observedAt" text)
      JOIN sip_configurations c ON c.id=r."configurationId" AND c.mode='gateway' AND c.revision=r.revision
      ON CONFLICT (gateway_id,configuration_id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,
        observed_at=EXCLUDED.observed_at,controller_instance=EXCLUDED.controller_instance,registration_generation=EXCLUDED.registration_generation
      WHERE gateway_upstream_registrations.controller_instance IS DISTINCT FROM EXCLUDED.controller_instance
        OR gateway_upstream_registrations.registration_generation IS DISTINCT FROM EXCLUDED.registration_generation
        OR gateway_upstream_registrations.revision<>EXCLUDED.revision
        OR gateway_upstream_registrations.observed_at<EXCLUDED.observed_at`, [gatewayId,instanceId,JSON.stringify(value.reports),value.registrationGeneration])
    return { recorded: true }
  })
}

export async function recordGatewayRegistrations(gatewayId: string, instanceId: string, input: unknown) {
  const value = z.object({ registrationGeneration: z.uuid().transform(value => value.toLowerCase()), reports: z.array(z.object({ endpoint: z.string().regex(/^d[a-f0-9]{32}$/),
    state: z.enum(['registered', 'unregistered']), ip: z.union([z.ipv4(), z.ipv6()]).nullable(), observedAt: z.iso.datetime(),
  }).strict()).min(1).max(20) }).strict().parse(input)
  if (new Set(value.reports.map(report => report.endpoint)).size !== value.reports.length
    || value.reports.some(report => (report.state === 'unregistered' && report.ip !== null)
      || Date.parse(report.observedAt) > Date.now() + 5000 || Date.parse(report.observedAt) < Date.now() - 30_000)) {
    throw new ServiceError(400, 'invalid_registration_observation', 'Send a recent registration snapshot.')
  }
  return transaction(async db => {
    await lockRegistrationObserver(db, gatewayId, instanceId, value.registrationGeneration)
    await db.query(`UPDATE gateway_credentials g SET registration_state=r.state,registration_ip=r.ip::inet,
      registration_observed_at=r."observedAt"::timestamptz,registration_controller=$2,registration_generation=$4
      FROM jsonb_to_recordset($3::jsonb) AS r(endpoint text,state text,ip text,"observedAt" text),gateway_nodes n
      WHERE g.username=r.endpoint AND g.gateway_id=$1 AND n.id=g.gateway_id AND n.host=g.realm
        AND (g.registration_controller IS DISTINCT FROM $2::uuid OR g.registration_generation IS DISTINCT FROM $4::uuid
          OR g.registration_observed_at IS NULL OR g.registration_observed_at<r."observedAt"::timestamptz)`,
    [gatewayId,instanceId,JSON.stringify(value.reports),value.registrationGeneration])
    return { recorded: true }
  })
}

export async function admitGatewayOutgoing(gatewayId: string, input: unknown) {
  const value = z.object({ callId: z.uuid(), endpoint: z.string().regex(/^d[a-f0-9]{32}$/), destination: z.string().regex(/^[a-zA-Z0-9_.+*#-]{1,128}$/) }).strict().parse(input)
  return transaction(async db => {
    const credential = (await rows(`SELECT g.device_id,g.configuration_id,c.organisation_id,c.revision FROM active_gateway_credentials g
      JOIN sip_configurations c ON c.id=g.configuration_id WHERE g.username=$1 AND g.gateway_id=$2`, [value.endpoint,gatewayId],db))[0]
    if (!credential) throw new ServiceError(403, 'managed_access_unavailable', 'Managed calling access is unavailable.')
    await db.query(`INSERT INTO gateway_calls (id,gateway_id,organisation_id,configuration_id,direction,origin_device_id,configuration_revision,expires_at)
      VALUES ($1,$2,$3,$4,'outgoing',$5,$6,now()+interval '45 seconds') ON CONFLICT DO NOTHING`,
    [value.callId,gatewayId,credential.organisation_id,credential.configuration_id,credential.device_id,credential.revision])
    const call = (await rows('SELECT * FROM gateway_calls WHERE id=$1 FOR UPDATE',[value.callId],db))[0]!
    if (call.gateway_id!==gatewayId || call.direction!=='outgoing' || call.origin_device_id!==credential.device_id
      || call.configuration_id!==credential.configuration_id || call.configuration_revision!==credential.revision) {
      throw new ServiceError(409,'call_id_conflict','This call identifier is already in use or its account has changed.')
    }
    if (call.state==='ended' || (call.state!=='answered' && call.expires_at.getTime()<=Date.now())) throw new ServiceError(409,'call_unavailable','This call is no longer available.')
    return { deviceId: credential.device_id, configurationId: credential.configuration_id, revision: credential.revision, destination: value.destination, endRequested:Boolean(call.end_requested_at) }
  })
}

/** Called only inside authenticated device provisioning's transaction. */
export async function gatewayAccount(db: Database, deviceId: string, configuration: {
  id: string; organisation_id: string; label: string; revision: number; settings: SipSettings
}) {
  const node = (await rows('SELECT * FROM gateway_nodes WHERE id=$1 AND ready_until>now()', [getConfig().SIPPER_GATEWAY_ID], db))[0]
  if (!node) throw new ServiceError(503, 'gateway_not_ready', 'The calling gateway is not ready. Try again shortly.')
  if (!(await rows('SELECT device_id FROM eligible_gateway_devices WHERE device_id=$1 AND configuration_id=$2', [deviceId, configuration.id], db)).length) {
    throw new ServiceError(403, 'managed_access_unavailable', 'Managed calling access is unavailable.')
  }
  // Serialise refreshes from the same device; never return a secret that lost an upsert race.
  await db.query('SELECT id FROM devices WHERE id=$1 FOR UPDATE', [deviceId])
  let credential = (await rows('SELECT * FROM gateway_credentials WHERE device_id=$1 AND configuration_id=$2', [deviceId, configuration.id], db))[0]
  if (!credential || credential.gateway_id !== node.id || credential.realm !== node.host) {
    const id = randomUUID(), username = `d${id.replaceAll('-', '')}`, password = randomBytes(32).toString('base64url')
    const context = `gateway:${configuration.organisation_id}:${deviceId}:${configuration.id}:${id}`
    const digest = `SHA-256:${createHash('sha256').update(`${username}:${node.host}:${password}`).digest('hex')}`
    credential = (await rows(`INSERT INTO gateway_credentials
      (id,gateway_id,organisation_id,device_id,configuration_id,username,realm,secret_envelope,password_digest)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (device_id,configuration_id) DO UPDATE
      SET id=EXCLUDED.id,gateway_id=EXCLUDED.gateway_id,username=EXCLUDED.username,realm=EXCLUDED.realm,
          secret_envelope=EXCLUDED.secret_envelope,password_digest=EXCLUDED.password_digest,
          registration_state=NULL,registration_ip=NULL,registration_observed_at=NULL,registration_controller=NULL RETURNING *`,
    [id,node.id,configuration.organisation_id,deviceId,configuration.id,username,node.host,JSON.stringify(sealSecret(password, context)),digest], db))[0]!
  }
  return {
    id: configuration.id, label: configuration.label, mode: 'gateway' as const, revision: configuration.revision,
    settings: {
      username: credential.username, authUsername: credential.username, server: node.host, domain: node.host,
      port: node.port, transport: 'tls' as const, srtp: 'required' as const, displayName: configuration.settings.displayName,
      voicemailNumber: configuration.settings.voicemailNumber, useICE: true, stunServer: '',
    },
    password: openSecret(credential.secret_envelope, `gateway:${configuration.organisation_id}:${deviceId}:${configuration.id}:${credential.id}`),
  }
}
