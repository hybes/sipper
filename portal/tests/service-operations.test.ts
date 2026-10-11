import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import { serviceOverview, customerCallActivity, requestCallEnd } from '../server/lib/service-operations'
import { admitGatewayOutgoing, gatewayHeartbeat, releaseGatewayController } from '../server/lib/gateway'
import { savePushToken, incomingGatewayCall, gatewayCall, deviceCall, cleanUpCalls } from '../server/lib/mobile-calls'
import { runOnePushJob } from '../server/lib/push-jobs'
import { saveMessagePushToken } from '../server/lib/messages'
import { gatewayFixture } from './gateway-fixture'
import { gatewayStatus, gatewayCallStatus, gatewayCallSummary, pushEndpointLabel, pushOutcomeLabel } from '../shared/service-status'
import * as platform from '../server/lib/platform'
import { trackWorkerProgress } from '../server/lib/worker-progress'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SIPPER_GATEWAY_ID = `operations-${randomUUID()}`
process.env.SIPPER_GATEWAY_PUBLIC_HOST = 'localhost'
after(async () => getPool().end())
const denied = (code: string) => (error: any) => error.code === code

test('explicit call end is scoped, MFA-protected, idempotent and pending until the gateway confirms hangup', async t => {
  const f=await gatewayFixture(), adminId=randomUUID(), email=`${adminId}@example.invalid`
  t.after(async ()=>{ await f.cleanup(); await getPool().query('DELETE FROM auth_user WHERE id=$1',[adminId]) })
  await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())',[adminId,'Call test administrator',email])
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'admin')",[f.workspace,f.organisation,adminId])
  const admin={userId:adminId,email,verified:true,mfa:true}, device=f.devices[0]!, callId=randomUUID(), instanceId=randomUUID()
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:true})
  await platform.provisionDevice(f.actor,device.id)
  await savePushToken(f.actor,device.id,{token:'ab'.repeat(32)})
  await incomingGatewayCall(f.nodeId,{callId,configurationId:f.configuration.id,caller:{name:'Private caller',number:'123'}})
  const other=await platform.createOrganisation(f.actor,f.workspace,{name:'Other customer'})
  await assert.rejects(requestCallEnd({...admin,mfa:false},f.organisation,callId),denied('mfa_required'))
  await assert.rejects(requestCallEnd({...admin,verified:false},f.organisation,callId),denied('email_verification_required'))
  await assert.rejects(requestCallEnd(admin,other.id,callId),denied('not_found'))
  await assert.rejects(requestCallEnd(f.actor,other.id,callId),denied('call_unavailable'))
  await assert.rejects(requestCallEnd(admin,f.organisation,randomUUID()),denied('call_unavailable'))
  await getPool().query("UPDATE organisation_members SET role='user' WHERE organisation_id=$1 AND user_id=$2",[f.organisation,adminId])
  await assert.rejects(requestCallEnd(admin,f.organisation,callId),denied('not_found'))
  await getPool().query("UPDATE organisation_members SET role='admin' WHERE organisation_id=$1 AND user_id=$2",[f.organisation,adminId])
  await assert.rejects(gatewayCall(f.nodeId,callId,{event:'ended',reason:'admin_ended'}),denied('end_not_requested'))
  const requests=await Promise.all(Array.from({length:5},()=>requestCallEnd(admin,f.organisation,callId)))
  assert.equal(new Set(requests.map(result=>result.requestedAt.toISOString())).size,1)
  let stored=(await rows('SELECT * FROM gateway_calls WHERE id=$1',[callId]))[0]!
  assert.equal(stored.state,'ringing'); assert.equal(stored.end_reason,null); assert.equal(stored.caller_envelope,null,'Do not retain caller identity indefinitely while waiting for an offline gateway')
  assert.equal(stored.version,2)
  const events=await rows("SELECT * FROM audit_events WHERE action='gateway_call.end_requested' AND target_id=$1",[callId])
  assert.equal(events.length,1); assert.equal(events[0]!.actor_id,adminId); assert.equal(events[0]!.organisation_id,f.organisation)
  assert.deepEqual(events[0]!.details,{})
  for(const event of ['answer','connected'] as const) {
    const result=await gatewayCall(f.nodeId,callId,{event,deviceId:device.id})
    assert.equal(result.endRequested,true); assert.equal(result.state,'ringing'); assert.deepEqual(result.targets,[])
  }
  await assert.rejects(deviceCall(f.actor,device.id,callId,'answer'),denied('call_taken'))
  assert.equal((await deviceCall(f.actor,device.id,callId,'decline')).state,'ringing')
  assert.equal((await incomingGatewayCall(f.nodeId,{callId,configurationId:f.configuration.id,caller:{name:'Private',number:'123'}})).endRequested,true)
  let deliveries=0
  assert.equal(await runOnePushJob(async ()=>{deliveries++;return 'accepted'}),true)
  assert.equal(deliveries,0,'Queued pushes are skipped after the request')
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:false})
  await platform.setMemberStatus(f.actor,f.organisation,f.actor.userId,'suspended')
  await getPool().query("UPDATE gateway_calls SET expires_at=now()-interval '1 second' WHERE id=$1",[callId])
  await cleanUpCalls()
  const snapshot=await gatewayCall(f.nodeId,callId)
  assert.equal(snapshot.state,'ringing'); assert.equal(snapshot.endRequested,true)
  assert.equal((await requestCallEnd(admin,f.organisation,callId)).requestedAt.toISOString(),requests[0]!.requestedAt.toISOString())
  assert.equal(gatewayCallSummary((await platform.organisationDetails(admin,f.organisation)).activeCalls as any).label,'End requested')
  const history=await customerCallActivity(admin,f.organisation)
  assert.ok(history.calls[0]!.end_requested_at); assert.ok(!JSON.stringify(history).includes('Private caller'))
  const ended=await gatewayCall(f.nodeId,callId,{event:'ended',reason:'admin_ended'})
  assert.equal(ended.state,'ended'); assert.equal(ended.reason,'admin_ended')
  assert.equal((await gatewayCall(f.nodeId,callId,{event:'ended',reason:'completed'})).reason,'admin_ended')
  stored=(await rows('SELECT * FROM gateway_calls WHERE id=$1',[callId]))[0]!
  assert.equal(stored.caller_envelope,null)
  assert.equal(gatewayCallStatus(stored as any).label,'Ended')
  assert.deepEqual((await platform.organisationDetails(admin,f.organisation)).activeCalls,[])
  await assert.rejects(requestCallEnd(admin,f.organisation,callId),denied('call_not_active'))
})

test('connected calls accept explicit termination after withdrawal without rewriting natural hangups', async t => {
  const f=await gatewayFixture(); t.after(f.cleanup)
  const device=f.devices[0]!, instanceId=randomUUID()
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:true})
  const config=await platform.provisionDevice(f.actor,device.id)
  for(const direction of ['incoming','outgoing']) {
    await platform.setMemberStatus(f.actor,f.organisation,f.actor.userId,'active')
    const id=randomUUID(), input={callId:id,endpoint:config.accounts[0]!.settings.username,destination:'2000'}
    if(direction==='incoming') {
      await incomingGatewayCall(f.nodeId,{callId:id,configurationId:f.configuration.id,caller:{name:'Private',number:'123'}})
      await gatewayCall(f.nodeId,id,{event:'answer',deviceId:device.id})
    } else await admitGatewayOutgoing(f.nodeId,input)
    await gatewayCall(f.nodeId,id,{event:'connected',deviceId:device.id})
    await requestCallEnd(f.actor,f.organisation,id)
    if(direction==='outgoing') assert.equal((await admitGatewayOutgoing(f.nodeId,input)).endRequested,true)
    await platform.setMemberStatus(f.actor,f.organisation,f.actor.userId,'suspended')
    const snapshot=await gatewayCall(f.nodeId,id,{event:'connected',deviceId:device.id})
    assert.equal(snapshot.state,'answered'); assert.equal(snapshot.endRequested,true)
    const reason=direction==='incoming'?'completed':'admin_ended'
    assert.equal((await gatewayCall(f.nodeId,id,{event:'ended',reason})).reason,reason)
    assert.equal((await gatewayCall(f.nodeId,id,{event:'ended',reason:'admin_ended'})).reason,reason)
  }
  await platform.setMemberStatus(f.actor,f.organisation,f.actor.userId,'active')
  const id=randomUUID()
  await incomingGatewayCall(f.nodeId,{callId:id,configurationId:f.configuration.id,caller:{name:'Private',number:'123'}})
  await getPool().query("UPDATE gateway_calls SET expires_at=now()-interval '1 second' WHERE id=$1",[id])
  await assert.rejects(requestCallEnd(f.actor,f.organisation,id),denied('call_not_active'))
  assert.equal((await rows('SELECT end_requested_at FROM gateway_calls WHERE id=$1',[id]))[0]!.end_requested_at,null)
})

test('outgoing call observations are idempotent, device-bound, private and retained across withdrawal until the gateway ends them', async t => {
  const f = await gatewayFixture(); t.after(f.cleanup)
  const instanceId = randomUUID(), callId = randomUUID(), [first, second] = f.devices
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:true})
  const configs = await Promise.all(f.devices.map(d=>platform.provisionDevice(f.actor,d.id)))
  const input = {callId,endpoint:configs[0]!.accounts[0]!.settings.username,destination:'private-dialled-number'}
  const admit = (value = input) => admitGatewayOutgoing(f.nodeId,value)
  await Promise.all([admit(),admit()])
  let stored = (await rows('SELECT * FROM gateway_calls WHERE id=$1',[callId]))[0]!
  assert.equal(stored.direction,'outgoing'); assert.equal(stored.origin_device_id,first!.id)
  assert.equal(stored.version,1); assert.equal(stored.caller_envelope,null)
  assert.ok(!JSON.stringify(stored).includes(input.destination))
  assert.equal((await rows('SELECT * FROM call_recipients WHERE call_id=$1',[callId])).length,0)
  assert.equal((await rows("SELECT * FROM jobs WHERE payload->>'callId'=$1",[callId])).length,0)
  const summary = async () => (await platform.organisationDetails(f.actor,f.organisation)).activeCalls
  assert.deepEqual(gatewayCallSummary(await summary() as any),{label:'Dialling',color:'primary',count:1})
  assert.equal((await summary())[0]!.device_id,first!.id)
  const other = await platform.createOrganisation(f.actor,f.workspace,{name:'Unrelated customer'})
  assert.deepEqual((await platform.organisationDetails(f.actor,other.id)).activeCalls,[])
  await assert.rejects(admit({...input,endpoint:configs[1]!.accounts[0]!.settings.username}),denied('call_id_conflict'))
  await assert.rejects(incomingGatewayCall(f.nodeId,{callId,configurationId:f.configuration.id,caller:{name:'Caller',number:'123'}}),denied('call_id_conflict'))
  await assert.rejects(gatewayCall('unrelated-gateway',callId),denied('call_unavailable'))
  for (const action of ['answer','decline'] as const) {
    await assert.rejects(gatewayCall(f.nodeId,callId,{event:action,deviceId:first!.id}),denied('outgoing_call'))
    await assert.rejects(deviceCall(f.actor,first!.id,callId,action),denied('call_unavailable'))
  }
  await assert.rejects(gatewayCall(f.nodeId,callId,{event:'connected',deviceId:second!.id}),denied('call_unavailable'))
  const connected = await gatewayCall(f.nodeId,callId,{event:'connected',deviceId:first!.id})
  assert.equal(connected.state,'answered'); assert.deepEqual(connected.targets,[])
  assert.equal((await gatewayCall(f.nodeId,callId,{event:'connected',deviceId:first!.id})).version,connected.version)
  await platform.revokeDevice(f.actor,f.organisation,first!.id)
  await assert.rejects(admit(),denied('managed_access_unavailable'))
  assert.equal((await gatewayCall(f.nodeId,callId,{event:'connected',deviceId:first!.id})).state,'answered','Recovery preserves an established call after withdrawal')
  assert.equal(gatewayCallSummary(await summary() as any).label,'In a call')
  const history = await customerCallActivity(f.actor,f.organisation)
  assert.equal(history.calls[0]!.direction,'outgoing'); assert.equal(history.calls[0]!.device_name,first!.name)
  assert.equal(history.calls[0]!.recipient_count,0); assert.ok(!JSON.stringify(history).includes(input.destination))
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:false})
  assert.equal(gatewayCallSummary(await summary() as any).label,'Unconfirmed')
  const ended = await gatewayCall(f.nodeId,callId,{event:'ended',reason:'completed'})
  assert.equal((await gatewayCall(f.nodeId,callId,{event:'ended',reason:'failed'})).version,ended.version)
  assert.deepEqual(await summary(),[])

  await gatewayHeartbeat(f.nodeId,{instanceId,ready:true})
  const next = {...input,callId:randomUUID(),endpoint:configs[1]!.accounts[0]!.settings.username}
  await admit(next)
  await getPool().query('UPDATE sip_configurations SET revision=revision+1 WHERE id=$1',[f.configuration.id])
  await assert.rejects(admit(next),denied('call_id_conflict'))
  await assert.rejects(gatewayCall(f.nodeId,next.callId,{event:'connected',deviceId:second!.id}),denied('call_unavailable'))
  await getPool().query("UPDATE gateway_calls SET expires_at=now()-interval '1 second' WHERE id=$1",[next.callId])
  assert.deepEqual(await summary(),[])
  assert.equal((await gatewayCall(f.nodeId,next.callId)).state,'ended')
  const expired = {...next,callId:randomUUID()}; await admit(expired)
  await getPool().query("UPDATE gateway_calls SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.callId])
  await assert.rejects(admit(expired),denied('call_unavailable'))
  const incomingId = randomUUID()
  await incomingGatewayCall(f.nodeId,{callId:incomingId,configurationId:f.configuration.id,caller:{name:'Caller',number:'123'}})
  await assert.rejects(admit({...next,callId:incomingId}),denied('call_id_conflict'))
})

test('service operations are restricted to a verified platform owner with MFA and expose only safe projections', async t => {
  const f = await gatewayFixture(); t.after(f.cleanup)
  await assert.rejects(serviceOverview(f.actor), denied('not_found'))
  await getPool().query('INSERT INTO platform_owners (user_id) VALUES ($1)', [f.actor.userId])
  await assert.rejects(serviceOverview({ ...f.actor, mfa: false }), denied('mfa_required'))
  await assert.rejects(serviceOverview({ ...f.actor, verified: false }), denied('email_verification_required'))
  const directory = await mkdtemp(join(tmpdir(),'sipper-owner-worker-test-'))
  const worker = await trackWorkerProgress('email',directory)
  t.after(async () => { await getPool().query('DELETE FROM worker_progress WHERE id=$1',[worker.id]); await rm(directory,{recursive:true,force:true}) })
  await worker.progressed()
  await platform.provisionDevice(f.actor, f.devices[0]!.id)
  await savePushToken(f.actor, f.devices[0]!.id, { token: 'ab'.repeat(32) })
  await saveMessagePushToken(f.actor, f.devices[0]!.id, { token: 'cd'.repeat(32) })
  const result = await serviceOverview(f.actor), serialised = JSON.stringify(result)
  assert.equal(result.gateways[0]!.eligible_accounts, 1)
  assert.deepEqual(Object.keys(result.gateways[0]!).sort(), ['controller_expires_at','eligible_accounts','host','id','last_heartbeat_at','port','ready_until'])
  assert.equal(result.push.find(row=>row.kind==='call' && row.provider==='apns')!.registered, 1)
  assert.equal(result.push.find(row=>row.kind==='message' && row.provider==='apns')!.registered, 1)
  assert.equal(result.push.find(row=>row.kind==='message')!.last_wake_at, null)
  assert.deepEqual(Object.keys(result.workers.find(item=>item.id===worker.id)!).sort(),['id','kind','progressed_at','started_at','stopped_at'])
  assert.ok(Object.values(result.configuration).every(value => typeof value === 'boolean'))
  for (const secret of ['secret_envelope','token_envelope','password_digest','never-send-upstream-secret-to-device','upstream-auth','ab'.repeat(32),'cd'.repeat(32),'controller_instance']) assert.ok(!serialised.includes(secret))
  await getPool().query('DELETE FROM platform_owners WHERE user_id=$1', [f.actor.userId])
  await assert.rejects(serviceOverview(f.actor), denied('not_found'))
})

test('queue diagnostics separate processing, delayed, exhausted and skipped work without exposing errors or payloads', async t => {
  const f = await gatewayFixture(), jobIds: string[] = []
  t.after(async () => { await getPool().query('DELETE FROM jobs WHERE id=ANY($1::uuid[])',[jobIds]); await f.cleanup() })
  await getPool().query('INSERT INTO platform_owners (user_id) VALUES ($1)', [f.actor.userId])
  const before = await serviceOverview(f.actor)
  const job = async (kind: string, attempts: number, available: number, locked: number | null, complete: boolean, error: string | null) => {
    const id = randomUUID(); jobIds.push(id)
    await getPool().query(`INSERT INTO jobs (id,kind,payload,attempts,available_at,locked_until,completed_at,last_error)
      VALUES ($1,$2,'{"secret":"do-not-expose-job-content"}',$3,now()+($4*interval '1 minute'),CASE WHEN $5::integer IS NULL THEN NULL ELSE now()+($5*interval '1 minute') END,CASE WHEN $6 THEN now() ELSE NULL END,$7)`,[id,kind,attempts,available,locked,complete,error])
  }
  await job('email',0,-1,null,false,null)
  await job('email',10,-1,5,false,null)
  await job('email',3,5,null,false,'do-not-expose-provider-error')
  await job('email',10,-1,-1,false,'do-not-expose-provider-error')
  await job('email',1,-1,null,true,null)
  await job('call_push',1,-1,null,true,'call_unavailable')
  await job('call_push',1,-1,null,true,'not_configured')
  await job('message_push',1,-1,null,true,'message_unavailable')
  await job('message_push',1,-1,null,true,'not_configured')
  const result = await serviceOverview(f.actor)
  function delta(kind: string, key: string) { return result.queues.find(row=>row.kind===kind)?.[key] - (before.queues.find(row=>row.kind===kind)?.[key] ?? 0) }
  for (const key of ['ready','processing','scheduled','exhausted','completed_24h']) assert.equal(delta('email',key),1,key)
  assert.equal(delta('call_push','skipped_24h'),1); assert.equal(delta('call_push','failed_24h'),1)
  assert.equal(delta('message_push','skipped_24h'),1); assert.equal(delta('message_push','failed_24h'),1)
  assert.ok(!JSON.stringify(result).includes('do-not-expose'))
})

test('recorded gateway heartbeats preserve unknown history and reject updates from a competing controller', async t => {
  const f = await gatewayFixture(); t.after(f.cleanup)
  let node = (await rows('SELECT * FROM gateway_nodes WHERE id=$1',[f.nodeId]))[0]!
  assert.equal(node.last_heartbeat_at,null)
  assert.equal(gatewayStatus(node as any).label,'Not reported')
  const instanceId = randomUUID()
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:true})
  node = (await rows('SELECT * FROM gateway_nodes WHERE id=$1',[f.nodeId]))[0]!
  assert.ok(node.last_heartbeat_at instanceof Date)
  assert.equal(gatewayStatus(node as any).label,'Ready')
  const heartbeat = node.last_heartbeat_at.toISOString()
  await assert.rejects(gatewayHeartbeat(f.nodeId,{instanceId:randomUUID(),ready:true}),denied('gateway_already_owned'))
  assert.equal((await rows('SELECT last_heartbeat_at FROM gateway_nodes WHERE id=$1',[f.nodeId]))[0]!.last_heartbeat_at.toISOString(),heartbeat)
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:false})
  node = (await rows('SELECT * FROM gateway_nodes WHERE id=$1',[f.nodeId]))[0]!
  assert.equal(gatewayStatus(node as any).label,'Not ready')
  assert.equal(gatewayStatus(node as any,Date.now()+31_000).label,'Offline')
  await releaseGatewayController(f.nodeId,instanceId)
  node = (await rows('SELECT * FROM gateway_nodes WHERE id=$1',[f.nodeId]))[0]!
  assert.equal(gatewayStatus(node as any).label,'Offline'); assert.ok(node.last_heartbeat_at)
})

test('call history uses customer-bound cursors and references, does not mutate calls and omits caller or connection secrets', async t => {
  const f = await gatewayFixture(), adminId = randomUUID(), email = `${adminId}@example.invalid`
  t.after(async () => { await getPool().query('DELETE FROM auth_user WHERE id=$1',[adminId]); await f.cleanup() })
  await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())',[adminId,'Customer administrator',email])
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'admin')",[f.workspace,f.organisation,adminId])
  const admin = {userId:adminId,email,verified:true,mfa:true}
  const other = await platform.createOrganisation(f.actor,f.workspace,{name:'Other customer'})
  const account = await platform.createConfiguration(f.actor,other.id,{label:'Other account',mode:'direct',password:'other-secret',settings:{username:'200',server:'sip.example.invalid',domain:'pbx.example.invalid'}})
  const foreignId = randomUUID()
  await getPool().query("INSERT INTO gateway_calls (id,gateway_id,organisation_id,configuration_id,expires_at) VALUES ($1,$2,$3,$4,now()+interval '30 seconds')",[foreignId,f.nodeId,other.id,account.id])
  const ids = Array.from({length:53},()=>randomUUID())
  // Same timestamp deliberately exercises the UUID tie-break without JS timestamp truncation.
  await getPool().query(`INSERT INTO gateway_calls (id,gateway_id,organisation_id,configuration_id,expires_at,caller_envelope)
    SELECT unnest($1::uuid[]),$2,$3,$4,now()-interval '1 minute','{"private":"caller-data-must-stay-hidden"}'::jsonb`,[ids,f.nodeId,f.organisation,f.configuration.id])
  await assert.rejects(customerCallActivity({...admin,mfa:false},f.organisation),denied('mfa_required'))
  await assert.rejects(customerCallActivity(admin,other.id),denied('not_found'))
  await assert.rejects(customerCallActivity(admin,f.organisation,foreignId),denied('not_found'))
  await assert.rejects(customerCallActivity(admin,f.organisation,''))
  await assert.rejects(customerCallActivity(admin,f.organisation,'not-a-call'))
  const first=await customerCallActivity(admin,f.organisation), second=await customerCallActivity(admin,f.organisation,first.nextCursor!)
  assert.equal(first.calls.length,50); assert.equal(second.calls.length,3); assert.equal(second.nextCursor,null)
  assert.equal(new Set([...first.calls,...second.calls].map(c=>c.id)).size,53)
  const reference = second.calls[2]!.id
  const focused = await customerCallActivity(admin,f.organisation,undefined,reference)
  assert.deepEqual(focused.calls.map(call=>call.id),[reference]); assert.equal(focused.nextCursor,null)
  await assert.rejects(customerCallActivity({...admin,mfa:false},f.organisation,undefined,reference),denied('mfa_required'))
  await assert.rejects(customerCallActivity(admin,other.id,undefined,foreignId),denied('not_found'))
  for (const unavailable of [foreignId,randomUUID()]) await assert.rejects(customerCallActivity(admin,f.organisation,undefined,unavailable),denied('not_found'))
  for (const invalid of ['', 'not-a-call']) await assert.rejects(customerCallActivity(admin,f.organisation,undefined,invalid))
  await assert.rejects(customerCallActivity(admin,f.organisation,first.nextCursor!,reference),denied('invalid_query'))
  const serialised=JSON.stringify([first,focused])
  for(const secret of ['caller_envelope','caller-data-must-stay-hidden','secret_envelope','password','sip.example.invalid',foreignId]) assert.ok(!serialised.includes(secret))
  assert.equal((await rows("SELECT count(*)::integer AS count FROM gateway_calls WHERE organisation_id=$1 AND state='ringing'",[f.organisation]))[0]!.count,53)
})

test('device push diagnostics are scoped, token-free and removed with revocation', async t => {
  const f = await gatewayFixture(); t.after(f.cleanup)
  const device=f.devices[0]!, token='cd'.repeat(32)
  await savePushToken(f.actor,device.id,{token})
  await getPool().query("UPDATE push_endpoints SET last_push_at=now(),last_push_status='accepted',last_wake_at=now() WHERE device_id=$1",[device.id])
  const result=await platform.organisationDetails(f.actor,f.organisation), mobile=result.devices.find(d=>d.id===device.id)!
  assert.equal(pushEndpointLabel(mobile as any),'Token registered'); assert.equal(pushOutcomeLabel(mobile.last_push_status),'Accepted by provider')
  assert.ok(mobile.last_push_at); assert.ok(mobile.last_wake_at)
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes('token_envelope')); assert.ok(!JSON.stringify(result).includes('token_revision'))
  const other=await platform.createOrganisation(f.actor,f.workspace,{name:'Another customer'})
  assert.equal((await platform.organisationDetails(f.actor,other.id)).devices.length,0)
  await platform.revokeDevice(f.actor,f.organisation,device.id)
  const revoked=(await platform.organisationDetails(f.actor,f.organisation)).devices.find(d=>d.id===device.id)!
  assert.equal(revoked.push_provider,null); assert.equal(pushEndpointLabel(revoked as any),'Revoked')
})

test('management call summaries follow eligible recipients, answer ownership, withdrawal and gateway freshness without exposing caller data', async t => {
  const f = await gatewayFixture(); t.after(f.cleanup)
  const instanceId = randomUUID(), callId = randomUUID(), [first, second] = f.devices
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:true})
  await Promise.all(f.devices.map(d=>platform.provisionDevice(f.actor,d.id)))
  await incomingGatewayCall(f.nodeId,{callId,configurationId:f.configuration.id,caller:{name:'private-caller-name',number:'private-caller-number'}})
  const snapshot = async () => (await platform.organisationDetails(f.actor,f.organisation)).activeCalls
  let calls = await snapshot()
  assert.equal(calls.length,2)
  assert.deepEqual(Object.keys(calls[0]!).sort(),['id','device_id','direction','state','expires_at','claim_until','end_requested_at','controller_expires_at','ready_until','last_heartbeat_at'].sort())
  assert.deepEqual(gatewayCallSummary(calls as any),{label:'Ringing',color:'primary',count:1})
  assert.equal(gatewayCallSummary(calls as any,Date.now()+31_000).label,'Unconfirmed')
  for (const secret of ['private-caller','caller_envelope','password','never-send-upstream-secret-to-device','upstream-auth']) assert.ok(!JSON.stringify(calls).includes(secret))
  const other = await platform.createOrganisation(f.actor,f.workspace,{name:'Unrelated customer'})
  assert.deepEqual((await platform.organisationDetails(f.actor,other.id)).activeCalls,[])
  await assert.rejects(platform.organisationDetails({...f.actor,mfa:false},f.organisation),denied('mfa_required'))
  await deviceCall(f.actor,first!.id,callId,'answer')
  calls = await snapshot()
  assert.equal(gatewayCallSummary(calls.filter(c=>c.device_id===first!.id) as any).label,'Answer pending')
  assert.equal(gatewayCallSummary(calls.filter(c=>c.device_id===second!.id) as any).label,'Ringing')
  assert.deepEqual(gatewayCallSummary(calls as any),{label:'Answer pending',color:'primary',count:1})
  await gatewayCall(f.nodeId,callId,{event:'connected',deviceId:first!.id})
  calls = await snapshot()
  assert.equal(calls.length,1); assert.equal(calls[0]!.device_id,first!.id)
  assert.equal(gatewayCallSummary(calls as any).label,'In a call')
  await platform.revokeDevice(f.actor,f.organisation,first!.id)
  assert.equal(gatewayCallSummary(await snapshot() as any).label,'In a call','Revocation must not hide an established call')
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:false})
  assert.equal(gatewayCallSummary(await snapshot() as any).label,'Unconfirmed')
  await gatewayCall(f.nodeId,callId,{event:'ended',reason:'completed'})
  assert.deepEqual(await snapshot(),[])
  assert.equal(gatewayCallSummary([]).label,'None reported')

  await gatewayHeartbeat(f.nodeId,{instanceId,ready:true})
  const nextId = randomUUID()
  await incomingGatewayCall(f.nodeId,{callId:nextId,configurationId:f.configuration.id,caller:{name:'private',number:'private'}})
  assert.equal((await snapshot()).length,1,'A revoked device must not appear as a ringing recipient')
  await deviceCall(f.actor,second!.id,nextId,'decline')
  assert.deepEqual(await snapshot(),[])
  const expiredId = randomUUID()
  await incomingGatewayCall(f.nodeId,{callId:expiredId,configurationId:f.configuration.id,caller:{name:'private',number:'private'}})
  const beforeExpiry = await snapshot()
  assert.equal(gatewayCallSummary(beforeExpiry as any,Date.now()+46_000).label,'None reported')
  await getPool().query("UPDATE gateway_calls SET expires_at=now()-interval '1 second' WHERE id=$1",[expiredId])
  assert.deepEqual(await snapshot(),[])
  assert.equal((await rows('SELECT state FROM gateway_calls WHERE id=$1',[expiredId]))[0]!.state,'ringing','Reading management must not mutate call state')
})

test('service badges distinguish expired calls, answer reservations and unconfirmed state from connected calls',()=>{
  const now=Date.now(), future=new Date(now+60_000).toISOString(), past=new Date(now-1).toISOString()
  const call={state:'answered',expires_at:past,claim_until:null,controller_expires_at:future,ready_until:future}
  const databaseNow=new Date(now+1000).toISOString()
  assert.equal(gatewayStatus({controller_expires_at:future,ready_until:databaseNow,last_heartbeat_at:databaseNow},now).label,'Not ready')
  assert.equal(gatewayCallStatus({...call,ready_until:databaseNow,last_heartbeat_at:databaseNow},now).label,'Unconfirmed')
  assert.equal(gatewayCallStatus(call,now).label,'Connected')
  assert.equal(gatewayCallStatus({...call,controller_expires_at:past},now).label,'Unconfirmed')
  assert.equal(gatewayCallStatus({...call,ready_until:past},now).label,'Unconfirmed')
  assert.equal(gatewayCallStatus({...call,state:'ringing'},now).label,'Expired')
  assert.equal(gatewayCallStatus({...call,state:'answering',expires_at:future,claim_until:future},now).label,'Answer pending')
  assert.equal(gatewayCallStatus({...call,state:'answering',expires_at:future,claim_until:past},now).label,'Ringing')
  assert.equal(gatewayCallStatus({...call,state:'ended',controller_expires_at:past},now).label,'Ended')
  assert.equal(gatewayCallStatus({...call,state:'ringing',end_requested_at:past,controller_expires_at:past},now).label,'End requested')
  assert.equal(gatewayCallStatus({...call,state:'ended',end_requested_at:past},now).label,'Ended')
  assert.equal(pushEndpointLabel({platform:'macos'}),'Not applicable')
  assert.equal(pushEndpointLabel({platform:'ios'}),'No token')
  assert.equal(pushEndpointLabel({platform:'android',push_provider:'fcm',push_disabled_at:past}),'Disabled')
})
