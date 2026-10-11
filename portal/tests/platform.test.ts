import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import { sealSecret, openSecret } from '../server/lib/crypto'
import type { Principal } from '../server/lib/access'
import * as platform from '../server/lib/platform'
import * as management from '../server/lib/management'
import { reportDevice } from '../server/lib/devices'
import { recordDeviceRequest } from '../server/lib/activity'
import { managePeople } from '../server/lib/bulk'
import { createSetupLink, redeemSetupLink, revokeSetupLink } from '../server/lib/setup-links'

const actors: Principal[] = []
const workspaceIds: string[] = []
const invitationIds: string[] = []
let admin: Principal, otherAdmin: Principal, alice: Principal, bob: Principal
let workspace: string, organisation: string, otherWorkspace: string, otherOrganisation: string
const settings = { username: '100', domain: 'pbx.example.invalid', server: 'sip.example.invalid' }
const denied = (code: string) => (error: any) => error.code === code

async function user(label: string): Promise<Principal> {
  const id = randomUUID()
  const actor = { userId: id, email: `${label}-${id}@example.invalid`, verified: true, mfa: true }
  await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())', [id, label, actor.email])
  actors.push(actor)
  return actor
}
async function addMember(actor: Principal, org = organisation, ws = workspace) {
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [ws, org, actor.userId])
}
async function capacity(seats: number) {
  await getPool().query(`INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats,paid_until) VALUES ($1,'test','active',$2,now()+interval '1 day')
    ON CONFLICT (workspace_id) DO UPDATE SET purchased_seats=$2`, [workspace, seats])
}
const newDevice = () => ({ installationId: randomUUID(), name: 'Test device', platform: 'macos', appVersion: '0.1.0', osVersion: '14' })

before(async () => {
  assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
  ;[admin, otherAdmin, alice, bob] = await Promise.all(['admin', 'other-admin', 'alice', 'bob'].map(user))
  workspace = (await platform.createWorkspace(admin, { name: 'Test reseller', kind: 'reseller' })).id
  otherWorkspace = (await platform.createWorkspace(otherAdmin, { name: 'Other reseller', kind: 'reseller' })).id
  workspaceIds.push(workspace, otherWorkspace)
  organisation = (await platform.createOrganisation(admin, workspace, { name: 'Customer A' })).id
  otherOrganisation = (await platform.createOrganisation(otherAdmin, otherWorkspace, { name: 'Other customer' })).id
  await addMember(alice)
  await addMember(bob)
})
after(async () => {
  const invitations = await rows('SELECT id FROM invitations WHERE workspace_id=ANY($1::uuid[])', [workspaceIds])
  invitationIds.push(...invitations.map(row => row.id))
  await getPool().query('DELETE FROM jobs WHERE deduplication_key=ANY($1::text[])', [invitationIds.map(id => `invitation:${id}`)])
  await getPool().query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [actors.map(a => a.userId)])
  await getPool().end()
})

test('encrypted SIP passwords cannot be read under another tenant context or after tampering', () => {
  const envelope = sealSecret('fixture-password', 'sip:tenant-a:account-a')
  assert.equal(openSecret(envelope, 'sip:tenant-a:account-a'), 'fixture-password')
  assert.throws(() => openSecret(envelope, 'sip:tenant-b:account-a'))
  assert.throws(() => openSecret({ ...envelope, data: Buffer.from('tampered').toString('base64') }, 'sip:tenant-a:account-a'))
  assert.ok(!JSON.stringify(envelope).includes('fixture-password'))
})
test('verified identity and administrator MFA are required', async () => {
  await assert.rejects(platform.createWorkspace({ ...admin, verified: false }, { name: 'No', kind: 'business' }), denied('email_verification_required'))
  await assert.rejects(platform.workspaceDetails({ ...admin, mfa: false }, workspace), denied('mfa_required'))
})
test('workspace and organisation administration reject another customer and ordinary users', async () => {
  await assert.rejects(platform.workspaceDetails(otherAdmin, workspace), denied('not_found'))
  await assert.rejects(platform.organisationDetails(otherAdmin, organisation), denied('not_found'))
  await assert.rejects(platform.organisationDetails(alice, organisation), denied('not_found'))
  await assert.rejects(platform.createOrganisation(admin, otherWorkspace, { name: 'No' }), denied('not_found'))
})
test('concurrent assignments cannot consume the last seat twice', async () => {
  await capacity(1)
  const result = await Promise.allSettled([platform.assignSeat(admin, workspace, alice.userId), platform.assignSeat(admin, workspace, bob.userId)])
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  const rejection = result.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejection.reason.code, 'no_available_seats')
  assert.equal((await rows('SELECT * FROM seat_assignments WHERE workspace_id=$1', [workspace])).length, 1)
  await capacity(2)
  await platform.assignSeat(admin, workspace, alice.userId)
  await platform.assignSeat(admin, workspace, bob.userId)
})
test('one person consumes one seat across organisations and any number of devices', async () => {
  const secondOrg = (await platform.createOrganisation(admin, workspace, { name: 'Customer B' })).id
  await addMember(alice, secondOrg)
  await platform.assignSeat(admin, workspace, alice.userId)
  const devices = await Promise.all([
    platform.enrolDevice(alice, organisation, newDevice()),
    platform.enrolDevice(alice, organisation, { ...newDevice(), platform: 'ios' }),
    platform.enrolDevice(alice, secondOrg, { ...newDevice(), platform: 'android' }),
  ])
  assert.equal(new Set(devices.map(d => d.id)).size, 3)
  assert.equal((await rows('SELECT * FROM seat_assignments WHERE workspace_id=$1 AND user_id=$2', [workspace, alice.userId])).length, 1)
})
test('provisioning is scoped to the enrolled identity and assigned organisation', async () => {
  const config = await platform.createConfiguration(admin, organisation, { label: 'Test SIP', mode: 'direct', settings, password: 'fixture-secret' })
  assert.ok(!JSON.stringify(config).includes('fixture-secret'))
  await platform.assignConfiguration(admin, organisation, config.id, alice.userId)
  const device = await platform.enrolDevice(alice, organisation, newDevice())
  const response = await platform.provisionDevice(alice, device.id)
  assert.equal(response.accounts.length, 1)
  assert.equal(response.accounts[0]!.password, 'fixture-secret')
  assert.equal(response.organisation.id, organisation)
  const bobDevice = await platform.enrolDevice(bob, organisation, newDevice())
  assert.equal((await platform.provisionDevice(bob, bobDevice.id)).accounts.length, 0)
  await assert.rejects(platform.provisionDevice(bob, device.id), denied('device_unavailable'))
  await assert.rejects(platform.assignConfiguration(admin, organisation, randomUUID(), alice.userId), denied('not_found'))
  await assert.rejects(platform.assignConfiguration(otherAdmin, otherOrganisation, config.id, otherAdmin.userId), denied('not_found'))
  assert.ok(!JSON.stringify(await platform.organisationDetails(admin, organisation)).includes('fixture-secret'))
})
test('calling account revisions reject concurrent and stale settings or password changes', async () => {
  const account = await platform.createConfiguration(admin, organisation, { label: 'Concurrent account', mode: 'direct', settings, password: 'fictional-original' })
  const input = { label: account.label, mode: account.mode, settings: account.settings }
  for (const revision of [undefined, 0, 1.5, '1']) await assert.rejects(management.updateConfiguration(admin, organisation, account.id, { ...input, revision }))
  await assert.rejects(management.updateConfiguration(otherAdmin, organisation, account.id, { ...input, revision: account.revision }), denied('not_found'))
  const attempts = ['one', 'two'].map(label => ({ ...input, label, revision: account.revision, password: `fictional-${label}` }))
  const results = await Promise.allSettled(attempts.map(value => management.updateConfiguration(admin, organisation, account.id, value)))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const loser = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(loser.reason.code, 'configuration_changed')
  const winner = attempts[results.findIndex(result => result.status === 'fulfilled')]!
  let stored = (await rows('SELECT * FROM sip_configurations WHERE id=$1', [account.id]))[0]!
  assert.equal(stored.revision, account.revision + 1)
  assert.equal(stored.label, winner.label)
  assert.equal(openSecret(stored.secret_envelope, `sip:${organisation}:${account.id}`), winner.password)
  await assert.rejects(management.updateConfiguration(admin, organisation, account.id, { ...input, revision: account.revision, password: 'fictional-stale' }), denied('configuration_changed'))
  const saved = await management.updateConfiguration(admin, organisation, account.id, { ...input, revision: stored.revision, label: 'Fresh edit' })
  stored = (await rows('SELECT * FROM sip_configurations WHERE id=$1', [account.id]))[0]!
  assert.equal(stored.revision, saved.revision)
  assert.equal(stored.label, 'Fresh edit')
  assert.equal(openSecret(stored.secret_envelope, `sip:${organisation}:${account.id}`), winner.password, 'Omitting a password keeps the encrypted credential')
  assert.equal((await rows("SELECT id FROM audit_events WHERE target_id=$1 AND action='sip_configuration.updated'", [account.id])).length, 2)
  assert.ok(!JSON.stringify(await platform.organisationDetails(admin, organisation)).includes(winner.password))
})
test('suspension blocks provisioning without removing the purchased seat; resuming restores it', async () => {
  const device = await platform.enrolDevice(alice, organisation, newDevice())
  await platform.setMemberStatus(admin, organisation, alice.userId, 'suspended')
  await assert.rejects(platform.provisionDevice(alice, device.id), denied('managed_access_unavailable'))
  await assert.rejects(platform.enrolDevice(alice, organisation, newDevice()), denied('managed_access_unavailable'))
  assert.equal((await rows('SELECT * FROM seat_assignments WHERE workspace_id=$1 AND user_id=$2', [workspace, alice.userId])).length, 1)
  await platform.setMemberStatus(admin, organisation, alice.userId, 'active')
  assert.equal((await platform.provisionDevice(alice, device.id)).deviceId, device.id)
})
test('a revoked installation cannot re-enrol itself, while other devices remain usable', async () => {
  const input = newDevice()
  const revoked = await platform.enrolDevice(alice, organisation, input)
  const retained = await platform.enrolDevice(alice, organisation, newDevice())
  await platform.revokeDevice(admin, organisation, revoked.id)
  await assert.rejects(platform.enrolDevice(alice, organisation, input), denied('device_revoked'))
  await assert.rejects(platform.provisionDevice(alice, revoked.id), denied('device_unavailable'))
  assert.equal((await platform.provisionDevice(alice, retained.id)).deviceId, retained.id)
})
test('removing a licence blocks all managed devices for that workspace', async () => {
  const device = await platform.enrolDevice(bob, organisation, newDevice())
  await platform.releaseSeat(admin, workspace, bob.userId)
  await assert.rejects(platform.provisionDevice(bob, device.id), denied('managed_access_unavailable'))
  await platform.assignSeat(admin, workspace, bob.userId)
})
test('gateway mode fails closed until it can issue separate device credentials', async () => {
  const config = await platform.createConfiguration(admin, organisation, { label: 'Gateway', mode: 'gateway', settings, password: 'never-provision-this-upstream-secret' })
  await platform.assignConfiguration(admin, organisation, config.id, bob.userId)
  const device = await platform.enrolDevice(bob, organisation, newDevice())
  await assert.rejects(platform.provisionDevice(bob, device.id), denied('gateway_not_ready'))
})
test('invitation acceptance requires the intended email and a token can be used only once', async () => {
  const invitation = await platform.inviteMember(admin, organisation, { email: alice.email })
  invitationIds.push(invitation.id)
  const job = (await rows('SELECT id,payload FROM jobs WHERE deduplication_key=$1', [`invitation:${invitation.id}`]))[0]!
  const mail = JSON.parse(openSecret(job.payload, `mail:${job.id}`))
  const token = new URL(mail.text.match(/http[^\s]+/)[0]).hash.slice('#token='.length)
  await assert.rejects(platform.acceptInvitation(bob, token), denied('invitation_email_mismatch'))
  assert.equal((await platform.acceptInvitation(alice, token)).organisationId, organisation)
  await assert.rejects(platform.acceptInvitation(alice, token), denied('invalid_invitation'))
})
test('new invitations cannot restore a suspended membership and revoked invitations stay invalid', async () => {
  const invitation = await platform.inviteMember(admin, organisation, { email: alice.email })
  invitationIds.push(invitation.id)
  const job = (await rows('SELECT id,payload FROM jobs WHERE deduplication_key=$1', [`invitation:${invitation.id}`]))[0]!
  const token = new URL(JSON.parse(openSecret(job.payload, `mail:${job.id}`)).text.match(/http[^\s]+/)[0]).hash.slice('#token='.length)
  await platform.setMemberStatus(admin, organisation, alice.userId, 'suspended')
  await assert.rejects(platform.acceptInvitation(alice, token), denied('user_suspended'))
  await platform.setMemberStatus(admin, organisation, alice.userId, 'active')
  await management.revokeInvitation(admin, organisation, invitation.id)
  await assert.rejects(platform.acceptInvitation(alice, token), denied('invalid_invitation'))
})
test('group membership grants assigned calling accounts, without crossing customer boundaries', async () => {
  const group = await management.createGroup(admin, organisation, { name: 'Support' })
  const config = await platform.createConfiguration(admin, organisation, { label: 'Group account', mode: 'direct', settings, password: 'group-fixture' })
  await management.setGroupMembers(admin, organisation, group.id, { userIds: [alice.userId] })
  await management.setGroupConfigurations(admin, organisation, group.id, { configurationIds: [config.id] })
  const device = await platform.enrolDevice(alice, organisation, newDevice())
  assert.ok((await platform.provisionDevice(alice, device.id)).accounts.some(a => a.id === config.id))
  await assert.rejects(management.setGroupMembers(admin, organisation, group.id, { userIds: [otherAdmin.userId] }), denied('invalid_members'))
  const otherConfig = await platform.createConfiguration(otherAdmin, otherOrganisation, { label: 'Other', mode: 'direct', settings, password: 'other-fixture' })
  await assert.rejects(management.setGroupConfigurations(admin, organisation, group.id, { configurationIds: [otherConfig.id] }), denied('invalid_configurations'))
  await management.setGroupMembers(admin, organisation, group.id, { userIds: [] })
  assert.ok(!(await platform.provisionDevice(alice, device.id)).accounts.some(a => a.id === config.id))
})
test('compound group creation is atomic and retries cannot create duplicates or overwrite another group', async () => {
  const id = randomUUID()
  const account = await platform.createConfiguration(admin, organisation, { label: 'Atomic group account', mode: 'direct', settings, password: 'group-fixture' })
  const body = { id, name: 'Fictional service team', userIds: [alice.userId], configurationIds: [account.id] }
  await assert.rejects(management.createGroup(admin, organisation, { ...body, configurationIds: [randomUUID()] }), denied('invalid_configurations'))
  assert.equal((await rows('SELECT id FROM groups WHERE id=$1', [id])).length, 0)
  assert.equal((await rows('SELECT id FROM audit_events WHERE target_id=$1', [id])).length, 0)
  const created = await management.createGroup(admin, organisation, body)
  const retry = await management.createGroup(admin, organisation, { ...body, userIds: [alice.userId, alice.userId], configurationIds: [account.id.toUpperCase(), account.id] })
  assert.deepEqual(retry, created)
  assert.equal((await rows("SELECT id FROM audit_events WHERE target_id=$1 AND action='group.created'", [id])).length, 1)
  assert.deepEqual(created.user_ids, [alice.userId]); assert.deepEqual(created.configuration_ids, [account.id])
  assert.equal((await platform.organisationDetails(admin, organisation)).groups.find(g => g.id === id)!.revision, created.revision)
  await assert.rejects(management.createGroup(admin, organisation, { ...body, name: 'Different request' }), denied('group_changed'))
  await assert.rejects(management.createGroup(otherAdmin, otherOrganisation, { id, name: 'Other customer' }), denied('group_changed'))
  assert.equal((await rows('SELECT name FROM groups WHERE id=$1', [id]))[0]!.name, body.name)
})
test('group edits commit name, people and calling accounts together and preserve configuration on rejection', async () => {
  const account = await platform.createConfiguration(admin, organisation, { label: 'Group edit account', mode: 'direct', settings, password: 'group-fixture' })
  const group = await management.createGroup(admin, organisation, { name: 'Fictional planning team', userIds: [alice.userId], configurationIds: [account.id] })
  const device = await platform.enrolDevice(alice, organisation, newDevice())
  const before = await platform.provisionDevice(alice, device.id)
  assert.ok(before.accounts.some(a => a.id === account.id))
  await assert.rejects(management.updateGroup(admin, organisation, group.id, { revision: group.revision, name: 'Rejected name', userIds: [bob.userId], configurationIds: [randomUUID()] }), denied('invalid_configurations'))
  assert.deepEqual((await platform.organisationDetails(admin, organisation)).groups.find(g => g.id === group.id), group)
  assert.equal((await rows("SELECT id FROM audit_events WHERE target_id=$1 AND action='group.updated'", [group.id])).length, 0)
  const renamed = await management.updateGroup(admin, organisation, group.id, { revision: group.revision, name: 'Fictional operations team' })
  assert.notEqual(renamed.revision, group.revision)
  assert.equal((await platform.provisionDevice(alice, device.id)).revision, before.revision)
  const unchanged = await management.updateGroup(admin, organisation, group.id, { revision: renamed.revision, name: renamed.name, userIds: [alice.userId], configurationIds: [account.id] })
  assert.equal(unchanged.revision, renamed.revision)
  assert.equal((await rows("SELECT id FROM audit_events WHERE target_id=$1 AND action='group.updated'", [group.id])).length, 1)
  const changed = await management.updateGroup(admin, organisation, group.id, { revision: renamed.revision, name: 'Fictional billing team', userIds: [bob.userId], configurationIds: [] })
  assert.deepEqual(changed.user_ids, [bob.userId]); assert.deepEqual(changed.configuration_ids, [])
  assert.ok(!(await platform.provisionDevice(alice, device.id)).accounts.some(a => a.id === account.id))
  const audit = (await rows("SELECT details FROM audit_events WHERE target_id=$1 AND action='group.updated' ORDER BY id DESC LIMIT 1", [group.id]))[0]!
  assert.deepEqual(audit.details, { people: 1, accounts: 0 })
})
test('group saves reject stale concurrent edits, legacy changes, foreign users and missing administrator authority', async () => {
  const group = await management.createGroup(admin, organisation, { name: 'Fictional concurrent team' })
  const body = { revision: group.revision, userIds: [alice.userId], configurationIds: [] }
  await assert.rejects(management.updateGroup(otherAdmin, organisation, group.id, body), denied('not_found'))
  await assert.rejects(management.updateGroup(alice, organisation, group.id, body), denied('not_found'))
  await assert.rejects(management.updateGroup({ ...admin, mfa: false }, organisation, group.id, body), denied('mfa_required'))
  await assert.rejects(management.updateGroup({ ...admin, verified: false }, organisation, group.id, body), denied('email_verification_required'))
  await assert.rejects(management.updateGroup(admin, organisation, group.id, { ...body, userIds: [otherAdmin.userId] }), denied('invalid_members'))
  await assert.rejects(management.updateGroup(admin, organisation, group.id, { userIds: [alice.userId] }))
  const edits = await Promise.allSettled(['First editor', 'Second editor'].map(name => management.updateGroup(admin, organisation, group.id, { ...body, name })))
  assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((edits.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'group_changed')
  const saved = (edits.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value
  await management.setGroupMembers(admin, organisation, group.id, { userIds: [bob.userId] })
  await assert.rejects(management.updateGroup(admin, organisation, group.id, { ...body, revision: saved.revision, name: 'Stale editor' }), denied('group_changed'))
  const latest = (await platform.organisationDetails(admin, organisation)).groups.find(g => g.id === group.id)!
  assert.deepEqual(latest.user_ids, [bob.userId]); assert.equal(latest.name, saved.name)
})
test('device reports must acknowledge the current revision and only assigned calling accounts', async () => {
  const device = await platform.enrolDevice(alice, organisation, newDevice())
  const config = await platform.provisionDevice(alice, device.id)
  await assert.rejects(reportDevice(alice, device.id, { appliedRevision: '0'.repeat(64) }), denied('configuration_changed'))
  await assert.rejects(reportDevice(alice, device.id, { registrations: [{ accountId: randomUUID(), state: 'registered' }] }), denied('invalid_registration_report'))
  await reportDevice(alice, device.id, { appliedRevision: config.revision, registrations: [{ accountId: config.accounts[0]!.id.toUpperCase(), state: 'registered', sipCode: 200 }] })
  const saved = (await rows('SELECT applied_revision,status FROM devices WHERE id=$1', [device.id]))[0]!
  assert.equal(saved.applied_revision, config.revision)
  assert.equal(saved.status.registrations[0].source, 'device')
  assert.equal(saved.status.registrations[0].accountId, config.accounts[0]!.id)
  assert.equal(saved.status.registrations[0].state, 'registered')
})

test('direct call snapshots are bounded, private, assigned and tied to an applied revision', async () => {
  const device = await platform.enrolDevice(alice, organisation, newDevice())
  const config = await platform.provisionDevice(alice, device.id)
  const directCalls = config.accounts.filter(a => a.mode === 'direct').map(a => ({ accountId: a.id.toUpperCase(), ringing: 1, dialling: 0, connected: 0, held: 0 }))
  const body = { appliedRevision: config.revision, directCalls }
  await reportDevice(alice, device.id, body)
  const details = await platform.organisationDetails(admin, organisation)
  const report = details.devices.find(d => d.id === device.id)!.status.directCalls
  assert.equal(report.source, 'device')
  assert.ok(Math.abs(Date.now() - Date.parse(report.observedAt)) < 5000)
  assert.deepEqual(report.accounts, directCalls.map(r => ({ ...r, accountId: r.accountId.toLowerCase() })))
  await assert.rejects(platform.organisationDetails(otherAdmin, organisation))
  await assert.rejects(reportDevice(bob, device.id, body))
  await assert.rejects(reportDevice(alice, device.id, { directCalls }), denied('invalid_call_report'))
  await assert.rejects(reportDevice(alice, device.id, { ...body, appliedRevision: '0'.repeat(64) }), denied('configuration_changed'))
  await assert.rejects(reportDevice(alice, device.id, { ...body, directCalls: [] }), denied('invalid_call_report'))
  await assert.rejects(reportDevice(alice, device.id, { ...body, directCalls: [...directCalls, directCalls[0]] }), denied('invalid_call_report'))
  for (const patch of [{ accountId: randomUUID() }, { ringing: 33 }, { held: -1 }, { connected: 0.5 }, { remoteNumber: 'private-caller' }, { observedAt: new Date().toISOString() }]) {
    await assert.rejects(reportDevice(alice, device.id, { ...body, directCalls: directCalls.map((r, i) => i ? r : { ...r, ...patch }) }))
  }
  await reportDevice(alice, device.id, { registrations: directCalls.map(r => ({ accountId: r.accountId, state: 'unknown' })) })
  const unavailable = (await rows('SELECT status FROM devices WHERE id=$1', [device.id]))[0]!.status.directCalls
  assert.equal(unavailable.confirmed, false, 'An unapplied engine must not leave its earlier calls confirmed')
  assert.equal(unavailable.observedAt, report.observedAt, 'Invalidation does not invent a fresh observation')
  await reportDevice(alice, device.id, { appliedRevision: config.revision })
  assert.equal((await rows('SELECT status FROM devices WHERE id=$1', [device.id]))[0]!.status.directCalls.confirmed, false)
  await reportDevice(alice, device.id, { ...body, directCalls: directCalls.map(r => ({ ...r, ringing: 0 })) })
  const idle = (await rows('SELECT status FROM devices WHERE id=$1', [device.id]))[0]!.status.directCalls
  assert.ok(idle.accounts.every((a: any) => a.ringing === 0))
  assert.equal(idle.confirmed, true)
  assert.ok(!JSON.stringify(idle).includes('private-caller'))
})

test('device activity records the authenticated session and stays within its person and customer', async () => {
  const device = await platform.enrolDevice(alice, organisation, newDevice())
  const sessionCreatedAt = new Date('2026-09-01T12:00:00Z')
  await recordDeviceRequest({ ...alice, sessionCreatedAt }, device.id, 'report', '192.0.2.20')
  await recordDeviceRequest({ ...bob, sessionCreatedAt }, device.id, 'configuration', '192.0.2.99')
  const details = await platform.organisationDetails(admin, organisation)
  const row = details.devices.find(d => d.id === device.id)!
  assert.equal(row.last_request_ip, '192.0.2.20')
  assert.equal(row.last_request_action, 'report')
  assert.equal(row.last_login_at.toISOString(), sessionCreatedAt.toISOString())
  assert.ok(row.last_request_at)
  assert.equal(details.members.find(m => m.user_id === alice.userId)!.last_request_ip, '192.0.2.20')
  assert.equal(details.members.find(m => m.user_id === alice.userId)!.last_request_action, 'report')
  // An older, still-valid session must not move the last login backwards.
  await recordDeviceRequest({ ...alice, sessionCreatedAt: new Date('2026-08-01T12:00:00Z') }, device.id, 'configuration', '2001:db8::1')
  const again = await platform.organisationDetails(admin, organisation)
  assert.equal(again.devices.find(d => d.id === device.id)!.last_login_at.toISOString(), sessionCreatedAt.toISOString())
  const isolated = await platform.createOrganisation(admin, workspace, { name: 'Isolated activity' })
  await addMember(alice, isolated.id)
  assert.equal((await platform.organisationDetails(admin, isolated.id)).members[0]!.last_request_ip, null)
  await assert.rejects(platform.organisationDetails(otherAdmin, organisation), denied('not_found'))
})

test('bulk people actions retain successful rows, enforce licence capacity and reject cross-customer targets', async () => {
  const ws = (await platform.createWorkspace(admin, { name: 'Bulk action test', kind: 'reseller' })).id
  workspaceIds.push(ws)
  const org = (await platform.createOrganisation(admin, ws, { name: 'Batch customer' })).id
  const sibling = (await platform.createOrganisation(admin, ws, { name: 'Other batch customer' })).id
  const outsider = await user('bulk-outsider')
  await addMember(alice, org, ws); await addMember(bob, org, ws); await addMember(outsider, sibling, ws)
  await getPool().query("INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats) VALUES ($1,'test','active',1)", [ws])
  await assert.rejects(managePeople(otherAdmin, org, { action: 'suspend', userIds: [alice.userId] }), denied('not_found'))
  await assert.rejects(managePeople({ ...admin, mfa: false }, org, { action: 'suspend', userIds: [alice.userId] }), denied('mfa_required'))
  const allocated = await managePeople(admin, org, { action: 'assign_seat', userIds: [alice.userId, bob.userId, outsider.userId, alice.userId, null] })
  assert.deepEqual(allocated.results.map(row => row.code ?? 'ok'), ['ok', 'no_available_seats', 'not_found', 'duplicate_row', 'invalid_input'])
  assert.equal((await platform.workspaceDetails(admin, ws)).seats.length, 1)
  const suspended = await managePeople(admin, org, { action: 'suspend', userIds: [alice.userId, outsider.userId, bob.userId] })
  assert.deepEqual(suspended.results.map(row => row.ok), [true, false, true])
  assert.equal((await platform.organisationDetails(admin, sibling)).members[0]!.status, 'active')
  assert.ok((await platform.organisationDetails(admin, org)).members.every(row => row.status === 'suspended'))
  assert.equal((await platform.workspaceDetails(admin, ws)).seats.length, 1)
  await managePeople(admin, org, { action: 'resume', userIds: [alice.userId, bob.userId] })
  const account = await platform.createConfiguration(admin, org, { label: 'Batch extension', mode: 'direct', settings, password: 'fictional-batch-password' })
  const assigned = await managePeople(admin, org, { action: 'assign_account', userIds: [alice.userId, bob.userId], configurationId: account.id })
  assert.ok(assigned.results.every(row => row.ok))
  await assert.rejects(managePeople(admin, sibling, { action: 'assign_account', userIds: [outsider.userId], configurationId: account.id }), denied('not_found'))
  await getPool().query("UPDATE organisation_members SET role='admin' WHERE organisation_id=$1 AND user_id=$2", [org, bob.userId])
  await assert.rejects(managePeople(bob, org, { action: 'release_seat', userIds: [alice.userId] }), denied('not_found'))
  await managePeople(admin, org, { action: 'release_seat', userIds: [alice.userId] })
  assert.equal((await platform.workspaceDetails(admin, ws)).seats.length, 0)
  assert.equal((await platform.organisationDetails(admin, org)).assignments.length, 2)
  assert.ok((await management.auditHistory(admin, ws)).some(row => row.action === 'member.suspended' && row.target_id === alice.userId && row.actor_name === 'admin'))
})

test('bulk invitations validate each row and concurrent replacements leave one usable invitation', async () => {
  const email = `bulk-${randomUUID()}@example.invalid`
  const result = await managePeople(admin, organisation, { action: 'invite', entries: [
    { email, role: 'user' }, { email: 'invalid', role: 'user' }, { email: email.toUpperCase(), role: 'admin' },
    { email: alice.email, role: 'admin' }, { email: `invalid-role-${randomUUID()}@example.invalid`, role: 'owner' },
  ] })
  assert.deepEqual(result.results.map(row => row.code ?? 'ok'), ['ok', 'invalid_input', 'duplicate_row', 'already_member', 'invalid_input'])
  assert.deepEqual(await rows('SELECT role FROM invitations WHERE organisation_id=$1 AND email=$2', [organisation, email]), [{ role: 'user' }])
  const replaced = await Promise.all([platform.inviteMember(admin, organisation, { email }), platform.inviteMember(admin, organisation, { email })])
  assert.equal(replaced.length, 2)
  const current = await rows('SELECT id,revoked_at FROM invitations WHERE organisation_id=$1 AND email=$2', [organisation, email])
  assert.equal(current.length, 3)
  assert.equal(current.filter(row => !row.revoked_at).length, 1)
  const jobs = await rows('SELECT payload FROM jobs WHERE deduplication_key=ANY($1::text[])', [current.map(row => `invitation:${row.id}`)])
  assert.equal(jobs.length, 3)
  assert.ok(!JSON.stringify(jobs).includes(email))
})

test('platform owner access spans workspaces but still requires verified identity and MFA', async () => {
  const owner = await user('platform-owner')
  await getPool().query('INSERT INTO platform_owners (user_id) VALUES ($1)', [owner.userId])
  const overview = await platform.overview(owner)
  assert.equal(overview.platformOwner, true)
  assert.ok(overview.workspaces.some(row => row.id === workspace))
  assert.ok(overview.workspaces.some(row => row.id === otherWorkspace))
  assert.ok(!(await platform.overview(admin)).workspaces.some(row => row.id === otherWorkspace))
  await platform.workspaceDetails(owner, otherWorkspace)
  await platform.organisationDetails(owner, otherOrganisation)
  await assert.rejects(platform.overview({ ...owner, mfa: false }), denied('mfa_required'))
  await assert.rejects(platform.organisationDetails({ ...owner, mfa: false }, otherOrganisation), denied('mfa_required'))
  await assert.rejects(platform.workspaceDetails({ ...owner, verified: false }, otherWorkspace), denied('email_verification_required'))
  const changed = await managePeople(owner, organisation, { action: 'resume', userIds: [alice.userId] })
  assert.equal(changed.results[0]!.ok, true)
  assert.ok((await management.auditHistory(owner, workspace)).some(row => row.action === 'member.resumed' && row.actor_name === 'platform-owner'))
})

test('setup links are identity-bound, single-use and never expose credentials in URLs or admin records', async () => {
  await capacity(100)
  await platform.assignSeat(admin, workspace, alice.userId)
  await assert.rejects(createSetupLink(otherAdmin, organisation, alice.userId), denied('not_found'))
  await assert.rejects(createSetupLink({ ...admin, mfa: false }, organisation, alice.userId), denied('mfa_required'))
  await assert.rejects(createSetupLink(admin, organisation, otherAdmin.userId), denied('not_found'))
  const link = await createSetupLink(admin, organisation, alice.userId)
  const url = new URL(link.url), reference = url.hash.slice(5)
  assert.equal(url.pathname, '/portal/setup'); assert.equal(url.search, '')
  assert.match(reference, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(new Date(link.expiresAt).getTime() - Date.now() <= 15 * 60_000)
  const saved = (await rows('SELECT * FROM setup_links WHERE id=$1', [link.id]))[0]!
  assert.notEqual(saved.token_hash, reference)
  const details = JSON.stringify(await platform.organisationDetails(admin, organisation))
  assert.ok(!details.includes(reference)); assert.ok(!details.includes(saved.token_hash))
  assert.ok(!link.url.includes(alice.email)); assert.ok(!link.url.includes('pbx.example'))
  await assert.rejects(redeemSetupLink(bob, { reference }), denied('setup_link_unavailable'))
  await assert.rejects(redeemSetupLink({ ...alice, verified: false }, { reference }), denied('email_verification_required'))
  const attempts = await Promise.allSettled([redeemSetupLink(alice, { reference }), redeemSetupLink(alice, { reference })])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  const result = attempts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>
  assert.equal(result.value.userId, alice.userId)
  assert.deepEqual(result.value.organisation, { id: organisation, name: 'Customer A', status: 'active', licensed: true })
  assert.ok((await management.auditHistory(admin, workspace)).some(row => row.action === 'setup_link.used' && row.target_id === link.id))
})

test('setup links enforce replacement, revocation, expiry and current licensed access', async () => {
  const first = await createSetupLink(admin, organisation, alice.userId)
  const second = await createSetupLink(admin, organisation, alice.userId)
  const input = (link: { url: string }) => ({ reference: new URL(link.url).hash.slice(5) })
  await assert.rejects(redeemSetupLink(alice, input(first)), denied('setup_link_unavailable'))
  await assert.rejects(revokeSetupLink(otherAdmin, otherOrganisation, second.id), denied('not_found'))
  await revokeSetupLink(admin, organisation, second.id)
  await assert.rejects(redeemSetupLink(alice, input(second)), denied('setup_link_unavailable'))
  const third = await createSetupLink(admin, organisation, alice.userId)
  await platform.setMemberStatus(admin, organisation, alice.userId, 'suspended')
  await assert.rejects(redeemSetupLink(alice, input(third)), denied('managed_access_unavailable'))
  await assert.rejects(createSetupLink(admin, organisation, alice.userId), denied('managed_access_unavailable'))
  await platform.setMemberStatus(admin, organisation, alice.userId, 'active')
  await platform.releaseSeat(admin, workspace, alice.userId)
  await assert.rejects(redeemSetupLink(alice, input(third)), denied('managed_access_unavailable'))
  await platform.assignSeat(admin, workspace, alice.userId)
  await getPool().query("UPDATE setup_links SET expires_at=now()-interval '1 second' WHERE id=$1", [third.id])
  await assert.rejects(redeemSetupLink(alice, input(third)), denied('setup_link_unavailable'))
  assert.equal((await rows('SELECT used_at FROM setup_links WHERE id=$1', [third.id]))[0]!.used_at, null)
})
