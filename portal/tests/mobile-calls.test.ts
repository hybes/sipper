import { after, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import type { Principal } from '../server/lib/access'
import * as platform from '../server/lib/platform'
import { openSecret } from '../server/lib/crypto'
import { deviceCall, incomingGatewayCall, gatewayCall, gatewayPrincipal, savePushToken, cleanUpCalls } from '../server/lib/mobile-calls'
import { runOnePushJob } from '../server/lib/push-jobs'
import { ownDevices, leaveDevice, ownCallingPreferences, setCallingPreference, clientOrganisations } from '../server/lib/devices'

after(async () => getPool().end())
async function fixture(t: TestContext) {
  assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
  const actors: Principal[] = []
  for (const name of ['admin', 'member', 'stranger']) {
    const id = randomUUID(), email = `${id}@example.invalid`
    await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())', [id, name, email])
    actors.push({ userId: id, email, verified: true, mfa: true })
  }
  const [admin, member, stranger] = actors as [Principal, Principal, Principal]
  const workspace = (await platform.createWorkspace(admin, { name: 'Mobile test workspace', kind: 'business' })).id
  const organisation = (await platform.createOrganisation(admin, workspace, { name: 'Mobile test customer' })).id
  const calls: string[] = []
  t.after(async () => {
    await getPool().query("DELETE FROM jobs WHERE kind='call_push' AND deduplication_key LIKE ANY($1::text[])", [calls.map(id => `call_push:${id}:%`)])
    await getPool().query('DELETE FROM workspaces WHERE id=$1', [workspace])
    await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [actors.map(a => a.userId)])
  })
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [workspace, organisation, member.userId])
  await getPool().query("INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats,paid_until) VALUES ($1,'test','active',1,now()+interval '1 day')", [workspace])
  await platform.assignSeat(admin, workspace, member.userId)
  const configuration = (await platform.createConfiguration(admin, organisation, { label: 'Gateway test account', mode: 'gateway', password: 'fictional-upstream-password',
    settings: { username: '1001', domain: 'pbx.example.invalid', server: 'sip.example.invalid' } })).id
  await platform.assignConfiguration(admin, organisation, configuration, member.userId)
  const ios = (await platform.enrolDevice(member, organisation, { installationId: randomUUID(), name: 'Fixture iPhone', platform: 'ios', appVersion: 'test', osVersion: 'test' })).id
  const android = (await platform.enrolDevice(member, organisation, { installationId: randomUUID(), name: 'Fixture Android', platform: 'android', appVersion: 'test', osVersion: 'test' })).id
  await savePushToken(member, ios, { token: 'a'.repeat(64) })
  await savePushToken(member, android, { token: 'fictional-fcm-token-only-for-local-tests' })
  const incoming = async () => {
    const id = randomUUID(); calls.push(id)
    await incomingGatewayCall('test-gateway', { callId: id, configurationId: configuration, caller: { name: 'Example caller', number: '2001' } })
    return id
  }
  return { admin, member, stranger, workspace, organisation, configuration, ios, android, incoming, calls }
}
const denied = (code: string) => (error: any) => error.code === code

test('calling preferences belong to the verified member, remain customer scoped and do not grant calling access', async t => {
  const f = await fixture(t), member = { ...f.member, mfa: false }
  assert.deepEqual(await ownCallingPreferences(f.admin), { organisations: [] })
  assert.deepEqual(await ownCallingPreferences(f.stranger), { organisations: [] })
  const initial = (await ownCallingPreferences(member)).organisations[0]!
  assert.deepEqual(Object.keys(initial).sort(), ['id','name','status','do_not_disturb','availability','share_status','share_activity','calling_preference_updated_at'].sort())
  assert.equal(initial.do_not_disturb, false); assert.equal(initial.calling_preference_updated_at, null)
  for (const actor of [f.admin, f.stranger]) await assert.rejects(setCallingPreference(actor, f.organisation, { doNotDisturb: true }), denied('membership_unavailable'))
  await assert.rejects(ownCallingPreferences({ ...member, verified: false }), denied('email_verification_required'))
  await assert.rejects(setCallingPreference({ ...member, verified: false }, f.organisation, { doNotDisturb: true }), denied('email_verification_required'))
  for (const input of [{}, { doNotDisturb: 'false' }, { doNotDisturb: null }, { doNotDisturb: true, userId: f.stranger.userId }]) await assert.rejects(setCallingPreference(member, f.organisation, input))
  await assert.rejects(setCallingPreference(member, randomUUID(), { doNotDisturb: true }), denied('membership_unavailable'))
  const other = await platform.createOrganisation(f.admin, f.workspace, { name: 'Second preference customer' })
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [f.workspace, other.id, member.userId])
  const changes = await Promise.all([setCallingPreference(member, f.organisation, { doNotDisturb: true }), setCallingPreference(member, f.organisation, { doNotDisturb: true })])
  assert.deepEqual(changes[0], changes[1]); assert.ok(changes[0]!.updatedAt)
  const preferences = (await ownCallingPreferences(member)).organisations
  assert.equal(preferences.find(o => o.id === other.id)!.do_not_disturb, false)
  assert.equal(preferences.find(o => o.id === f.organisation)!.do_not_disturb, true)
  assert.equal((await clientOrganisations(member)).organisations.find(o => o.id === f.organisation)!.doNotDisturb, true)
  assert.equal((await clientOrganisations(member)).organisations.find(o => o.id === other.id)!.doNotDisturb, false)
  const events = await rows("SELECT actor_id,target_id,details FROM audit_events WHERE organisation_id=$1 AND action='member.calling_preference_changed'", [f.organisation])
  assert.deepEqual(events, [{ actor_id: member.userId, target_id: member.userId, details: { doNotDisturb: true } }])
  assert.equal((await platform.organisationDetails(f.admin, f.organisation)).members[0]!.do_not_disturb, true)
  await platform.releaseSeat(f.admin, f.workspace, member.userId)
  await setCallingPreference(member, f.organisation, { doNotDisturb: false }) // Preferences do not require or issue a seat.
  assert.equal((await rows('SELECT 1 FROM eligible_gateway_devices WHERE device_id=$1', [f.ios])).length, 0)
  await platform.setMemberStatus(f.admin, f.organisation, member.userId, 'suspended')
  assert.equal((await ownCallingPreferences(member)).organisations.find(o => o.id === f.organisation)!.status, 'suspended')
  await assert.rejects(setCallingPreference(member, f.organisation, { doNotDisturb: true }), denied('membership_unavailable'))
  await getPool().query("UPDATE organisation_members SET status='removed',removed_at=now() WHERE organisation_id=$1 AND user_id=$2", [f.organisation, member.userId])
  assert.ok(!(await ownCallingPreferences(member)).organisations.some(o => o.id === f.organisation))
  await assert.rejects(setCallingPreference(member, f.organisation, { doNotDisturb: true }), denied('membership_unavailable'))
})

test('stated availability is private to a membership and independent of call admission and concurrent DND changes', async t => {
  const f = await fixture(t), member = { ...f.member, mfa: false }
  const before = (await rows('SELECT revision FROM sip_configurations WHERE id=$1', [f.configuration]))[0]
  assert.equal((await clientOrganisations(member)).organisations[0]!.availability, 'unset')
  for (const actor of [f.admin, f.stranger]) await assert.rejects(setCallingPreference(actor, f.organisation, { availability: 'busy' }), denied('membership_unavailable'))
  for (const input of [{ availability: 'online' }, { availability: null }, { availability: 'busy', userId: member.userId }]) await assert.rejects(setCallingPreference(member, f.organisation, input))
  const other = await platform.createOrganisation(f.admin, f.workspace, { name: 'Other availability customer' })
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [f.workspace, other.id, member.userId])
  const saved = await setCallingPreference(member, f.organisation, { availability: 'away' })
  assert.equal(saved.doNotDisturb, false)
  assert.deepEqual(await setCallingPreference(member, f.organisation, { availability: 'away' }), saved)
  assert.equal((await clientOrganisations(member)).organisations.find(o => o.id === other.id)!.availability, 'unset')
  assert.deepEqual((await rows('SELECT revision FROM sip_configurations WHERE id=$1', [f.configuration]))[0], before)
  const call = await f.incoming()
  assert.equal((await rows('SELECT 1 FROM call_recipients WHERE call_id=$1', [call])).length, 2, 'Away must not filter ringing recipients')
  await Promise.all([setCallingPreference(member, f.organisation, { availability: 'busy' }), setCallingPreference(member, f.organisation, { doNotDisturb: true })])
  const current = (await ownCallingPreferences(member)).organisations.find(o => o.id === f.organisation)!
  assert.equal(current.availability, 'busy'); assert.equal(current.do_not_disturb, true)
  assert.equal((await platform.organisationDetails(f.admin, f.organisation)).members[0]!.availability, 'busy')
  assert.equal((await rows("SELECT 1 FROM audit_events WHERE organisation_id=$1 AND details->>'availability'='away'", [f.organisation])).length, 1)
  await setCallingPreference(member, f.organisation, { availability: 'unset' })
  assert.equal((await clientOrganisations(member)).organisations.find(o => o.id === f.organisation)!.availability, 'unset')
  await platform.setMemberStatus(f.admin, f.organisation, member.userId, 'suspended')
  await assert.rejects(setCallingPreference(member, f.organisation, { availability: 'available' }), denied('membership_unavailable'))
})

test('Do Not Disturb excludes all of a person’s devices from new calls and pushes, without changing existing recipients', async t => {
  const f = await fixture(t), existing = await f.incoming()
  await setCallingPreference(f.member, f.organisation, { doNotDisturb: true })
  const blocked = await f.incoming()
  assert.equal((await gatewayCall('test-gateway', blocked)).reason, 'rejected')
  assert.equal((await rows('SELECT 1 FROM call_recipients WHERE call_id=$1', [blocked])).length, 0)
  assert.equal((await rows("SELECT 1 FROM jobs WHERE payload->>'callId'=$1", [blocked])).length, 0)
  await assert.rejects(deviceCall(f.member, f.ios, blocked, 'wake'), denied('call_unavailable'))
  let sends = 0
  while (await runOnePushJob(async push => { assert.equal(push.callId, existing); sends++; return 'accepted' })) {}
  assert.equal(sends, 2, 'calls admitted before DND can still deliver their queued wake')
  assert.equal((await deviceCall(f.member, f.android, existing, 'wake')).state, 'ringing')
  await deviceCall(f.member, f.ios, existing, 'answer')
  await gatewayCall('test-gateway', existing, { event: 'connected', deviceId: f.ios })
  await setCallingPreference(f.member, f.organisation, { doNotDisturb: false })
  assert.equal((await gatewayCall('test-gateway', existing)).state, 'answered')
  assert.equal((await incomingGatewayCall('test-gateway', { callId: blocked, configurationId: f.configuration, caller: { name: '', number: '' } })).state, 'ended', 'turning off DND never resurrects a rejected call')
  const resumed = await f.incoming()
  assert.equal((await rows('SELECT 1 FROM call_recipients WHERE call_id=$1', [resumed])).length, 2)
  await setCallingPreference(f.member, f.organisation, { doNotDisturb: true })
  await incomingGatewayCall('test-gateway', { callId: resumed, configurationId: f.configuration, caller: { name: '', number: '' } })
  assert.equal((await rows('SELECT 1 FROM call_recipients WHERE call_id=$1', [resumed])).length, 2, 'an admitted call retry keeps its original recipients')
  assert.equal((await gatewayCall('test-gateway', existing)).state, 'answered')
  await getPool().query('UPDATE subscriptions SET purchased_seats=2 WHERE workspace_id=$1', [f.workspace])
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [f.workspace, f.organisation, f.stranger.userId])
  await platform.assignSeat(f.admin, f.workspace, f.stranger.userId)
  await platform.assignConfiguration(f.admin, f.organisation, f.configuration, f.stranger.userId)
  const colleague = await platform.enrolDevice(f.stranger, f.organisation, { installationId: randomUUID(), name: 'Colleague', platform: 'android', appVersion: 'test', osVersion: 'test' })
  await savePushToken(f.stranger, colleague.id, { token: 'fictional-colleague-push-token' })
  const shared = await f.incoming()
  assert.deepEqual((await rows('SELECT device_id FROM call_recipients WHERE call_id=$1', [shared])).map(r => r.device_id), [colleague.id])
  assert.deepEqual((await rows("SELECT payload->>'deviceId' AS device_id FROM jobs WHERE payload->>'callId'=$1", [shared])).map(r => r.device_id), [colleague.id])
  assert.equal((await deviceCall(f.stranger, colleague.id, shared, 'answer')).claimedByThisDevice, true)
})

test('users can inspect only their own device activity with literal search and stable private pagination', async t => {
  const f = await fixture(t), member = { ...f.member, mfa: false }
  assert.equal((await ownDevices(member)).devices.length, 2)
  for (const actor of [f.admin, f.stranger]) {
    assert.deepEqual(await ownDevices(actor), { devices: [], nextCursor: null })
    await assert.rejects(ownDevices(actor, { after: f.ios }), denied('not_found'))
  }
  await assert.rejects(ownDevices({ ...member, verified: false }), denied('email_verification_required'))
  await assert.rejects(ownDevices(member, { after: 'bad-id' }))
  await assert.rejects(ownDevices(member, { userId: f.stranger.userId }))
  await getPool().query(`UPDATE devices SET name='Device 100%_QA',last_request_ip='2001:db8::42',last_request_at=now(),last_login_at=now()-interval '1 day',status='{"private":"must not appear"}' WHERE id=$1`, [f.ios])
  for (const q of ['100%', '%_', '2001:db8::42', 'mobile TEST customer']) assert.ok((await ownDevices(member, { q })).devices.some(d => d.id === f.ios))
  assert.equal((await ownDevices(member, { q: 'does not exist' })).devices.length, 0)
  const row = (await ownDevices(member, { q: '100%' })).devices[0]!
  assert.deepEqual(Object.keys(row).sort(), ['id','name','platform','app_version','os_version','enrolled_at','revoked_at','last_login_at','last_request_at','last_request_ip','last_report_at','organisation_id','organisation_name','membership_status'].sort())
  assert.equal(row.last_request_ip, '2001:db8::42')
  assert.ok(row.last_login_at); assert.ok(!JSON.stringify(row).includes('must not appear'))
  await getPool().query(`INSERT INTO devices (organisation_id,user_id,installation_id,name,platform,app_version,os_version,enrolled_at)
    SELECT $1,$2,gen_random_uuid(),'Page fixture '||n,'windows','test','test','2026-09-26 12:34:56.123456+00' FROM generate_series(1,101) n`, [f.organisation, member.userId])
  const seen: string[] = []; let after: string | null = null
  do {
    const page = await ownDevices(member, { q: 'Page fixture', ...(after ? { after } : {}) })
    assert.ok(page.devices.length <= 50); seen.push(...page.devices.map(d => d.id)); after = page.nextCursor
  } while (after)
  assert.equal(seen.length, 101); assert.equal(new Set(seen).size, 101)
  await leaveDevice(member, f.ios)
  assert.deepEqual((await ownDevices(member, { state: 'revoked' })).devices.map(d => d.id), [f.ios])
  assert.ok(!(await ownDevices(member, { state: 'enrolled' })).devices.some(d => d.id === f.ios))
  await platform.setMemberStatus(f.admin, f.organisation, member.userId, 'suspended')
  assert.equal((await ownDevices(member, { q: '100%' })).devices[0]!.membership_status, 'suspended')
})

test('self-service revocation is idempotent, preserves other access and calls, and removes gateway and push eligibility', async t => {
  const f = await fixture(t), member = { ...f.member, mfa: false }, call = await f.incoming()
  await deviceCall(member, f.ios, call, 'answer')
  await gatewayCall('test-gateway', call, { event: 'connected', deviceId: f.ios })
  for (const actor of [f.admin, f.stranger]) await assert.rejects(leaveDevice(actor, f.ios), denied('not_found'))
  await assert.rejects(leaveDevice({ ...member, verified: false }, f.ios), denied('email_verification_required'))
  const otherOrg = (await platform.createOrganisation(f.admin, f.workspace, { name: 'Second customer' })).id
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [f.workspace, otherOrg, member.userId])
  const other = await platform.enrolDevice(member, otherOrg, { installationId: randomUUID(), name: 'Other customer', platform: 'macos', appVersion: 'test', osVersion: 'test' })
  await Promise.all([leaveDevice(member, f.ios), leaveDevice(member, f.ios)])
  assert.equal((await rows("SELECT id FROM audit_events WHERE target_id=$1 AND action='device.signed_out'", [f.ios])).length, 1)
  assert.equal((await rows('SELECT device_id FROM push_endpoints WHERE device_id=$1', [f.ios])).length, 0)
  assert.equal((await rows('SELECT device_id FROM eligible_gateway_devices WHERE device_id=$1', [f.ios])).length, 0)
  assert.equal((await rows('SELECT device_id FROM eligible_gateway_devices WHERE device_id=$1', [f.android])).length, 1)
  assert.equal((await rows('SELECT revoked_at FROM devices WHERE id=$1', [other.id]))[0]!.revoked_at, null)
  assert.equal((await rows('SELECT user_id FROM seat_assignments WHERE workspace_id=$1 AND user_id=$2', [f.workspace, member.userId])).length, 1)
  assert.equal((await gatewayCall('test-gateway', call)).state, 'answered')
  assert.equal((await deviceCall(member, f.ios, call, 'status')).state, 'answered')
  await assert.rejects(platform.provisionDevice(member, f.ios), denied('device_unavailable'))
  await assert.rejects(savePushToken(member, f.ios, { token: 'b'.repeat(64) }), denied('device_unavailable'))
  await platform.setMemberStatus(f.admin, f.organisation, member.userId, 'suspended')
  await platform.releaseSeat(f.admin, f.workspace, member.userId)
  await leaveDevice(member, f.android) // Losing calling access must not prevent security cleanup.
  assert.ok((await rows('SELECT revoked_at FROM devices WHERE id=$1', [f.android]))[0]!.revoked_at)
})

test('push tokens are encrypted, device-owned and erased on revocation', async t => {
  const f = await fixture(t)
  const endpoint = (await rows('SELECT * FROM push_endpoints WHERE device_id=$1', [f.ios]))[0]!
  assert.ok(!JSON.stringify(endpoint).includes('a'.repeat(64)))
  assert.equal(openSecret(endpoint.token_envelope, `push:${f.organisation}:${f.ios}`), 'a'.repeat(64))
  assert.throws(() => openSecret(endpoint.token_envelope, `push:${f.organisation}:${f.android}`))
  await assert.rejects(savePushToken(f.stranger, f.ios, { token: 'b'.repeat(64) }), denied('device_unavailable'))
  await assert.rejects(savePushToken(f.member, f.ios, { token: 'invalid-platform-token' }), denied('invalid_push_token'))
  await platform.revokeDevice(f.admin, f.organisation, f.ios)
  assert.equal((await rows('SELECT * FROM push_endpoints WHERE device_id=$1', [f.ios])).length, 0)
  await assert.rejects(savePushToken(f.member, f.ios, { token: 'b'.repeat(64) }), denied('device_unavailable'))
})

test('incoming-call retries do not duplicate recipients or pushes and caller data stays out of jobs', async t => {
  const f = await fixture(t), callId = await f.incoming()
  const retry = await incomingGatewayCall('test-gateway', { callId, configurationId: f.configuration, caller: { name: 'Ignored retry', number: '999' } })
  assert.equal(retry.state, 'ringing'); assert.equal('caller_envelope' in retry, false)
  assert.equal((await rows('SELECT * FROM call_recipients WHERE call_id=$1', [callId])).length, 2)
  const jobs = await rows("SELECT * FROM jobs WHERE payload->>'callId'=$1", [callId])
  assert.equal(jobs.length, 2)
  for (const text of ['fictional-upstream-password', 'Example caller', '2001', 'pbx.example.invalid']) assert.ok(!JSON.stringify(jobs).includes(text))
  assert.equal((await deviceCall(f.member, f.ios, callId, 'wake')).caller.name, 'Example caller')
  await assert.rejects(deviceCall(f.stranger, f.ios, callId, 'status'), denied('device_unavailable'))
  await assert.rejects(gatewayCall('other-gateway', callId), denied('call_unavailable'))
  assert.throws(() => gatewayPrincipal('Bearer fictional-wrong-key'))
})

test('only one device can claim a call and only the gateway can confirm connection', async t => {
  const f = await fixture(t), callId = await f.incoming()
  const results = await Promise.allSettled([f.ios, f.android].map(id => deviceCall(f.member, id, callId, 'answer')))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'call_taken')
  const pending = await gatewayCall('test-gateway', callId)
  assert.equal(pending.state, 'answering')
  await assert.rejects(gatewayCall('test-gateway', callId, { event: 'connected', deviceId: pending.winnerDeviceId === f.ios ? f.android : f.ios }), denied('call_not_claimed'))
  const connected = await gatewayCall('test-gateway', callId, { event: 'connected', deviceId: pending.winnerDeviceId })
  assert.equal(connected.state, 'answered')
  assert.equal((await gatewayCall('test-gateway', callId, { event: 'connected', deviceId: pending.winnerDeviceId })).version, connected.version)
  assert.equal((await rows('SELECT caller_envelope FROM gateway_calls WHERE id=$1', [callId]))[0]!.caller_envelope, null)
  await platform.setMemberStatus(f.admin, f.organisation, f.member.userId, 'suspended')
  assert.equal((await gatewayCall('test-gateway', callId)).state, 'answered', 'ordinary suspension does not terminate an established call')
  assert.equal((await deviceCall(f.member, pending.winnerDeviceId!, callId, 'status')).state, 'answered')
  await platform.revokeDevice(f.admin, f.organisation, pending.winnerDeviceId!)
  assert.equal((await deviceCall(f.member, pending.winnerDeviceId!, callId, 'status')).state, 'answered', 'device revocation does not tell an established call to hang up')
})

test('failed claims can be retried by another device; decline and cancellation cannot resurrect calls', async t => {
  const f = await fixture(t), callId = await f.incoming()
  await deviceCall(f.member, f.ios, callId, 'answer')
  await rows("UPDATE gateway_calls SET claim_until=now()-interval '1 second' WHERE id=$1", [callId])
  assert.equal((await deviceCall(f.member, f.android, callId, 'answer')).claimedByThisDevice, true)
  await assert.rejects(gatewayCall('test-gateway', callId, { event: 'decline', deviceId: randomUUID() }), denied('call_unavailable'))
  await gatewayCall('test-gateway', callId, { event: 'decline', deviceId: f.android })
  await assert.rejects(gatewayCall('test-gateway', callId, { event: 'answer', deviceId: f.android }), denied('call_taken'))
  assert.equal((await deviceCall(f.member, f.ios, callId, 'decline')).state, 'ended')
  await assert.rejects(gatewayCall('test-gateway', callId, { event: 'connected', deviceId: f.android }), denied('call_not_claimed'))
  const cancelled = await f.incoming()
  await gatewayCall('test-gateway', cancelled, { event: 'ended', reason: 'caller_cancelled' })
  assert.equal((await deviceCall(f.member, f.ios, cancelled, 'wake')).reason, 'caller_cancelled')
  assert.equal((await deviceCall(f.member, f.ios, cancelled, 'answer')).state, 'ended')
  let sends = 0
  while (await runOnePushJob(async () => { sends++; return 'accepted' })) {}
  assert.equal(sends, 0)
})

test('queued pushes recheck licences, assignments, suspension, decline, revocation and expiry', async t => {
  const f = await fixture(t)
  for (const state of ['suspended', 'unlicensed', 'unassigned', 'expired', 'declined', 'revoked'] as const) {
    const callId = await f.incoming()
    if (state === 'suspended') await platform.setMemberStatus(f.admin, f.organisation, f.member.userId, 'suspended')
    if (state === 'unlicensed') await platform.releaseSeat(f.admin, f.workspace, f.member.userId)
    if (state === 'unassigned') await rows('DELETE FROM sip_assignments WHERE configuration_id=$1', [f.configuration])
    if (state === 'expired') await rows("UPDATE gateway_calls SET expires_at=now()-interval '1 second' WHERE id=$1", [callId])
    if (state === 'declined') { await deviceCall(f.member, f.ios, callId, 'decline'); await deviceCall(f.member, f.android, callId, 'decline') }
    if (state === 'revoked') { await platform.revokeDevice(f.admin, f.organisation, f.ios); await platform.revokeDevice(f.admin, f.organisation, f.android) }
    let sends = 0
    while (await runOnePushJob(async () => { sends++; return 'accepted' })) {}
    assert.equal(sends, 0, state)
    if (state === 'suspended') await platform.setMemberStatus(f.admin, f.organisation, f.member.userId, 'active')
    if (state === 'unlicensed') await platform.assignSeat(f.admin, f.workspace, f.member.userId)
    if (state === 'unassigned') await platform.assignConfiguration(f.admin, f.organisation, f.configuration, f.member.userId)
  }
  await cleanUpCalls()
})

test('push completion cannot invalidate a rotated token or overwrite another worker lease', async t => {
  const f = await fixture(t), callId = await f.incoming()
  // Select one job deterministically; the other remains for the token-rotation check.
  await rows("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE payload->>'deviceId'=$1", [f.android])
  await runOnePushJob(async push => {
    assert.equal(push.callId, callId); assert.equal(push.token, 'a'.repeat(64))
    await savePushToken(f.member, f.ios, { token: 'b'.repeat(64) })
    return 'invalid_token'
  })
  const endpoint = (await rows('SELECT * FROM push_endpoints WHERE device_id=$1', [f.ios]))[0]!
  assert.equal(endpoint.disabled_at, null)
  assert.equal(openSecret(endpoint.token_envelope, `push:${f.organisation}:${f.ios}`), 'b'.repeat(64))
  await rows("UPDATE jobs SET available_at=now() WHERE payload->>'deviceId'=$1", [f.android])
  const newLease = randomUUID()
  await runOnePushJob(async () => {
    await rows("UPDATE jobs SET lease_id=$2 WHERE payload->>'deviceId'=$1", [f.android, newLease])
    return 'invalid_token'
  })
  assert.equal((await rows('SELECT disabled_at FROM push_endpoints WHERE device_id=$1', [f.android]))[0]!.disabled_at, null)
  assert.equal((await rows('SELECT completed_at FROM jobs WHERE lease_id=$1', [newLease]))[0]!.completed_at, null)
})

test('provider acceptance is separate from device wake and transient delivery can retry', async t => {
  const f = await fixture(t), callId = await f.incoming()
  await rows("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE payload->>'deviceId'=$1", [f.android])
  await runOnePushJob(async () => 'retry')
  let job = (await rows("SELECT * FROM jobs WHERE payload->>'deviceId'=$1", [f.ios]))[0]!
  assert.equal(job.completed_at, null); assert.equal(job.last_error, 'provider_retry')
  await rows('UPDATE jobs SET available_at=now() WHERE id=$1', [job.id])
  await runOnePushJob(async () => 'accepted')
  job = (await rows('SELECT * FROM jobs WHERE id=$1', [job.id]))[0]!
  assert.ok(job.completed_at); assert.deepEqual(job.payload, {})
  const endpoint = (await rows('SELECT * FROM push_endpoints WHERE device_id=$1', [f.ios]))[0]!
  assert.equal(endpoint.last_push_status, 'accepted'); assert.equal(endpoint.last_wake_at, null)
  await deviceCall(f.member, f.ios, callId, 'wake')
  assert.ok((await rows('SELECT last_wake_at FROM push_endpoints WHERE device_id=$1', [f.ios]))[0]!.last_wake_at)
})
