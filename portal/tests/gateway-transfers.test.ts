import { after, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import { openSecret } from '../server/lib/crypto'
import { gatewayFixture } from './gateway-fixture'
import { admitGatewayOutgoing, gatewayHeartbeat } from '../server/lib/gateway'
import { gatewayCall, incomingGatewayCall } from '../server/lib/mobile-calls'
import { admitGatewayTransfer, gatewayTransfer, pendingGatewayTransfers } from '../server/lib/gateway-transfers'
import * as platform from '../server/lib/platform'
import { customerCallActivity } from '../server/lib/service-operations'

process.env.SIPPER_GATEWAY_ID = `transfers-${randomUUID()}`
process.env.SIPPER_GATEWAY_PUBLIC_HOST = 'localhost'
after(async () => getPool().end())
const denied = (code: string) => (error: any) => error.code === code

async function fixture(t: TestContext) {
  const f = await gatewayFixture(); t.after(f.cleanup)
  const instance = randomUUID()
  await gatewayHeartbeat(f.nodeId, { instanceId: instance, ready: true })
  const endpoints = await Promise.all(f.devices.map(async d => (await platform.provisionDevice(f.actor, d.id)).accounts[0]!.settings.username))
  const outgoing = async (index = 0, connect = true) => {
    const callId = randomUUID()
    await admitGatewayOutgoing(f.nodeId, { callId, endpoint: endpoints[index], destination: '2001' })
    if (connect) await gatewayCall(f.nodeId, callId, { event: 'connected', deviceId: f.devices[index]!.id })
    return callId
  }
  const incoming = async () => {
    const callId = randomUUID()
    await incomingGatewayCall(f.nodeId, { callId, configurationId: f.configuration.id, configurationRevision: 1, caller: { name: 'Fixture', number: '2002' } })
    await gatewayCall(f.nodeId, callId, { event: 'answer', deviceId: f.devices[0]!.id })
    await gatewayCall(f.nodeId, callId, { event: 'connected', deviceId: f.devices[0]!.id })
    return callId
  }
  return { ...f, instance, outgoing, incoming,
    admit: (input: unknown, owner = instance) => admitGatewayTransfer(f.nodeId, owner, input),
    report: (id: string, state?: 'completed' | 'failed', owner = instance) => gatewayTransfer(f.nodeId, owner, id, state ? { state } : undefined),
  }
}

test('blind transfers bind encrypted destinations, retain failed calls and report completion without replay', async t => {
  const f = await fixture(t), callId = await f.outgoing()
  const request = { transferId: randomUUID(), callId, deviceId: f.devices[0]!.id, destination: '+441234567890' }
  const admitted = await f.admit(request)
  assert.deepEqual(await pendingGatewayTransfers(f.nodeId, f.instance), { transfers: [{ id: request.transferId, callId, consultationCallId: null }] })
  await assert.rejects(pendingGatewayTransfers(f.nodeId, randomUUID()), denied('gateway_lease_lost'))
  assert.equal(admitted.state, 'pending'); assert.equal(admitted.configurationId, f.configuration.id); assert.equal(admitted.revision, 1)
  assert.equal(JSON.stringify(admitted).includes(request.destination), false)
  assert.deepEqual(await f.admit(request), admitted)
  const record = (await rows('SELECT * FROM gateway_transfers WHERE id=$1', [request.transferId]))[0]!
  assert.equal(JSON.stringify(record).includes(request.destination), false)
  assert.equal(openSecret(record.destination_envelope, `transfer:${request.transferId}`), request.destination)
  await assert.rejects(f.admit({ ...request, destination: '2003' }), denied('transfer_id_conflict'))
  await assert.rejects(f.admit({ ...request, deviceId: f.devices[1]!.id }), denied('transfer_id_conflict'))
  for (const input of [{ ...request, destination: 'sip:2003@external.invalid' }, { ...request, destination: '123\r\nInjected: secret' },
    { ...request, consultationCallId: randomUUID() }, { ...request, destination: undefined }, { ...request, gatewayId: 'other' }]) await assert.rejects(f.admit(input))
  await f.report(request.transferId, 'failed')
  assert.deepEqual(await pendingGatewayTransfers(f.nodeId, f.instance), { transfers: [] })
  assert.equal((await gatewayCall(f.nodeId, callId)).state, 'answered')
  assert.equal((await platform.organisationDetails(f.actor, f.organisation)).activeCalls.length, 1)
  assert.equal((await f.admit(request)).state, 'failed')
  await assert.rejects(f.report(request.transferId, 'completed'), denied('transfer_finished'))
  const retry = { ...request, transferId: randomUUID() }
  await f.admit(retry); await f.report(retry.transferId, 'completed')
  assert.equal((await gatewayCall(f.nodeId, callId)).state, 'answered', 'Remote parties still have a gateway call')
  assert.equal((await platform.organisationDetails(f.actor, f.organisation)).activeCalls.length, 0, 'The original device has left that call')
  const history = await customerCallActivity(f.actor, f.organisation)
  assert.ok(history.calls.find(call => call.id === callId)!.transferred_at)
  const before = (await rows('SELECT version FROM gateway_calls WHERE id=$1', [callId]))[0]!.version
  await f.report(retry.transferId, 'completed')
  assert.equal((await rows('SELECT version FROM gateway_calls WHERE id=$1', [callId]))[0]!.version, before)
  assert.equal((await f.admit(retry)).state, 'completed')
  await assert.rejects(f.admit({ ...retry, transferId: randomUUID() }), denied('transfer_unavailable'))
})

test('attended attempts lock both calls, enforce device ownership and preserve unrelated conversations', async t => {
  const f = await fixture(t), callId = await f.incoming(), consultationCallId = await f.outgoing(), otherDevice = await f.outgoing(1)
  const request = { transferId: randomUUID(), callId, consultationCallId, deviceId: f.devices[0]!.id }
  await assert.rejects(f.admit({ ...request, consultationCallId: callId }), denied('transfer_unavailable'))
  await assert.rejects(f.admit({ ...request, consultationCallId: otherDevice }), denied('transfer_unavailable'))
  await assert.rejects(f.admit({ ...request, deviceId: f.devices[1]!.id }), denied('transfer_unavailable'))
  const opposite = { ...request, transferId: randomUUID(), callId: consultationCallId, consultationCallId: callId }
  const attempts = await Promise.allSettled([f.admit(request), f.admit(opposite)])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  const winner = attempts[0]!.status === 'fulfilled' ? request : opposite
  await assert.rejects(f.admit({ transferId: randomUUID(), callId: winner.consultationCallId, deviceId: request.deviceId, destination: '2004' }), denied('transfer_pending'))
  const completed = await f.report(winner.transferId, 'completed')
  assert.equal(completed.state, 'completed')
  const source = (await rows('SELECT * FROM gateway_calls WHERE id=$1', [winner.callId]))[0]!
  const consultation = (await rows('SELECT * FROM gateway_calls WHERE id=$1', [winner.consultationCallId]))[0]!
  assert.equal(source.state, 'answered'); assert.ok(source.transferred_at)
  assert.equal(consultation.state, 'ended'); assert.equal(consultation.transferred_into, source.id)
  assert.equal(consultation.end_reason, 'completed')
  assert.equal((await gatewayCall(f.nodeId, otherDevice)).state, 'answered')
  assert.deepEqual((await platform.organisationDetails(f.actor, f.organisation)).activeCalls.map(call => call.id), [otherDevice])
  const consultationHistory = await customerCallActivity(f.actor, f.organisation, undefined, consultation.id)
  const sourceHistory = await customerCallActivity(f.actor, f.organisation, undefined, consultationHistory.calls[0]!.transferred_into)
  assert.equal(consultationHistory.calls[0]!.state, 'ended')
  assert.equal(sourceHistory.calls[0]!.id, source.id)
  assert.equal(sourceHistory.calls[0]!.state, 'answered')
  assert.ok(sourceHistory.calls[0]!.transferred_at)
  assert.equal(sourceHistory.canEndCalls, true)
  for (const secret of ['caller_envelope', 'destination_envelope', 'secret_envelope', 'password', 'pbx.example.invalid']) assert.ok(!JSON.stringify([consultationHistory, sourceHistory]).includes(secret))
  await getPool().query('DELETE FROM gateway_calls WHERE id=$1', [source.id])
  const retained = (await customerCallActivity(f.actor, f.organisation, undefined, consultation.id)).calls[0]!
  assert.equal(retained.transferred_into, null); assert.ok(retained.transferred_at)
  await assert.rejects(customerCallActivity(f.actor, f.organisation, undefined, source.id), denied('not_found'))
})

test('transfer admission rechecks policy, revision, expiry and administrator end requests; recovery reports remain idempotent', async t => {
  const f = await fixture(t), callId = await f.outgoing(), ringing = await f.outgoing(0, false)
  const request = { transferId: randomUUID(), callId, deviceId: f.devices[0]!.id, destination: '2003' }
  await assert.rejects(f.admit({ ...request, callId: ringing }), denied('transfer_unavailable'))
  await f.admit(request)
  const mutations: [string,string,unknown[]][] = [
    ["UPDATE organisation_members SET status='suspended' WHERE organisation_id=$1", "UPDATE organisation_members SET status='active' WHERE organisation_id=$1", [f.organisation]],
    ["UPDATE subscriptions SET status='cancelled' WHERE workspace_id=$1", "UPDATE subscriptions SET status='active' WHERE workspace_id=$1", [f.workspace]],
    ['UPDATE subscriptions SET purchased_seats=0 WHERE workspace_id=$1', 'UPDATE subscriptions SET purchased_seats=1 WHERE workspace_id=$1', [f.workspace]],
    ['UPDATE auth_user SET "emailVerified"=false WHERE id=$1', 'UPDATE auth_user SET "emailVerified"=true WHERE id=$1', [f.actor.userId]],
    ['UPDATE devices SET revoked_at=now() WHERE id=$1', 'UPDATE devices SET revoked_at=NULL WHERE id=$1', [f.devices[0]!.id]],
    ['UPDATE sip_configurations SET revision=revision+1 WHERE id=$1', 'UPDATE sip_configurations SET revision=revision-1 WHERE id=$1', [f.configuration.id]],
    ['UPDATE gateway_calls SET end_requested_at=now() WHERE id=$1', 'UPDATE gateway_calls SET end_requested_at=NULL WHERE id=$1', [callId]],
  ]
  for (const [change, restore, args] of mutations) {
    await getPool().query(change, args)
    try { await assert.rejects(f.admit(request), denied('transfer_unavailable')) }
    finally { await getPool().query(restore, args) }
  }
  await getPool().query('DELETE FROM sip_assignments WHERE configuration_id=$1 AND user_id=$2', [f.configuration.id,f.actor.userId])
  await assert.rejects(f.admit(request), denied('transfer_unavailable'))
  await platform.assignConfiguration(f.actor, f.organisation, f.configuration.id, f.actor.userId)
  await gatewayHeartbeat(f.nodeId, { instanceId: f.instance, ready: false })
  await assert.rejects(f.admit(request), denied('gateway_not_ready'))
  await gatewayHeartbeat(f.nodeId, { instanceId: f.instance, ready: true })
  await f.admit(request)
  await assert.rejects(f.admit(request, randomUUID()), denied('gateway_lease_lost'))
  await assert.rejects(f.report(request.transferId, 'failed', randomUUID()), denied('gateway_lease_lost'))
  await getPool().query("UPDATE gateway_transfers SET expires_at=now()-interval '1 second' WHERE id=$1", [request.transferId])
  await assert.rejects(f.admit(request), denied('transfer_unavailable'))
  await assert.rejects(f.admit({ ...request, transferId: randomUUID() }), denied('transfer_pending'), 'An expired attempt must be reconciled before another can use its legs')
  await getPool().query("UPDATE gateway_nodes SET controller_expires_at=now()-interval '1 second' WHERE id=$1", [f.nodeId])
  const replacement = randomUUID()
  await gatewayHeartbeat(f.nodeId, { instanceId: replacement, ready: false })
  await assert.rejects(f.report(request.transferId, 'failed'), denied('gateway_lease_lost'))
  assert.equal((await f.report(request.transferId, 'failed', replacement)).state, 'failed', 'The replacement can replay recovery results while admissions remain paused')
  assert.equal((await gatewayCall(f.nodeId, callId)).state, 'answered')
  await gatewayHeartbeat(f.nodeId, { instanceId: replacement, ready: true })
  const late = { ...request, transferId: randomUUID() }
  await f.admit(late, replacement)
  await gatewayCall(f.nodeId, callId, { event: 'ended', reason: 'completed' })
  await f.report(late.transferId, 'completed', replacement)
  assert.equal((await gatewayCall(f.nodeId, callId)).state, 'ended', 'Late completion must not resurrect a call')
})

test('transfers cannot join different customer accounts or cross a database tenant relationship', async t => {
  const f = await fixture(t), callId = await f.outgoing()
  const otherOrganisation = (await platform.createOrganisation(f.actor, f.workspace, { name: 'Other transfer customer' })).id
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [f.workspace,otherOrganisation,f.actor.userId])
  const otherDevice = await platform.enrolDevice(f.actor, otherOrganisation, { installationId: randomUUID(), name: 'Other fixture phone', platform: 'ios', appVersion: 'test', osVersion: 'test' })
  for (const [organisation, device] of [[f.organisation,f.devices[0]!.id],[otherOrganisation,otherDevice.id]]) {
    const configuration = await platform.createConfiguration(f.actor, organisation!, { label: 'Separate transfer account', mode: 'gateway', password: 'fictional-secret', settings: { username: '1002', domain: 'pbx.example.invalid', server: 'sip.example.invalid' } })
    await platform.assignConfiguration(f.actor, organisation!, configuration.id, f.actor.userId)
    const credential = (await platform.provisionDevice(f.actor, device!)).accounts.find(account => account.id === configuration.id)!
    const other = randomUUID()
    await admitGatewayOutgoing(f.nodeId, { callId: other, endpoint: credential.settings.username, destination: '2001' })
    await gatewayCall(f.nodeId, other, { event: 'connected', deviceId: device })
    await assert.rejects(f.admit({ transferId: randomUUID(), callId, consultationCallId: other, deviceId: f.devices[0]!.id }), denied('transfer_unavailable'))
    assert.equal((await gatewayCall(f.nodeId, other)).state, 'answered')
  }
  const request = { transferId: randomUUID(), callId, deviceId: f.devices[0]!.id, destination: '2003' }
  await f.admit(request)
  await assert.rejects(gatewayTransfer('other-gateway', f.instance, request.transferId), denied('gateway_lease_lost'))
  await assert.rejects(getPool().query(`INSERT INTO gateway_transfers
    (id,gateway_id,organisation_id,call_id,device_id,configuration_id,configuration_revision,destination_envelope,state,completed_at)
    SELECT $2,gateway_id,$3,call_id,device_id,configuration_id,configuration_revision,destination_envelope,'failed',now()
    FROM gateway_transfers WHERE id=$1`, [request.transferId,randomUUID(),otherOrganisation]), (error: any) => error.code === '23503')
  await f.report(request.transferId, 'failed')
})
