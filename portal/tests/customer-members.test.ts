import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows, transaction } from '../server/lib/db'
import { openSecret } from '../server/lib/crypto'
import { requireOrganisation, type Principal } from '../server/lib/access'
import * as platform from '../server/lib/platform'
import * as management from '../server/lib/management'
import { changeMemberRole, removeMember } from '../server/lib/customer-members'
import { clientOrganisations, reportDevice } from '../server/lib/devices'
import { createSetupLink, redeemSetupLink } from '../server/lib/setup-links'
import { deviceCall, gatewayCall, incomingGatewayCall, savePushToken } from '../server/lib/mobile-calls'
import { runOnePushJob } from '../server/lib/push-jobs'
import { invitationDestination, invitationAuthPath, isInvitationPath, legacyCustomerInvitationHash } from '../app/utils/invitation-navigation'

const userIds: string[] = [], workspaceIds: string[] = []
const denied = (code: string) => (error: any) => error.code === code
async function user(name: string): Promise<Principal> {
  const userId = randomUUID(), email = `${name}-${userId}@example.invalid`
  await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())', [userId, name, email])
  userIds.push(userId)
  return { userId, email, verified: true, mfa: true }
}
async function fixture() {
  const [owner, manager, member, outsider] = await Promise.all(['owner', 'manager', 'member', 'outsider'].map(user)) as [Principal, Principal, Principal, Principal]
  const ws = (await platform.createWorkspace(owner, { name: 'Membership test workspace', kind: 'reseller' })).id as string
  workspaceIds.push(ws)
  const org = (await platform.createOrganisation(owner, ws, { name: 'Customer A' })).id as string
  const otherOrg = (await platform.createOrganisation(owner, ws, { name: 'Customer B' })).id as string
  for (const [id, who, role] of [[org, member, 'user'], [otherOrg, member, 'user'], [org, manager, 'admin']] as const) {
    await getPool().query('INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,$4)', [ws, id, who.userId, role])
  }
  await getPool().query("INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats,paid_until) VALUES ($1,'test','active',2,now()+interval '1 day')", [ws])
  await platform.assignSeat(owner, ws, member.userId)
  return { owner, manager, member, outsider, ws, org, otherOrg }
}
const deviceInput = (platform = 'macos') => ({ installationId: randomUUID(), name: 'Fictional device', platform, appVersion: 'test', osVersion: 'test' })
const accountInput = (mode = 'direct') => ({ label: 'Fictional calling account', mode, password: 'fictional-membership-password', settings: { username: '100', domain: 'pbx.example.invalid', server: 'sip.example.invalid' } })
async function tokenFor(id: string) {
  const job = (await rows('SELECT id,payload FROM jobs WHERE deduplication_key=$1', [`invitation:${id}`]))[0]!
  const mail = JSON.parse(openSecret(job.payload, `mail:${job.id}`))
  const link = new URL(mail.text.match(/https?:\/\/\S+/)[0])
  assert.equal(link.pathname, '/portal/invitations/accept')
  assert.equal(link.search, '')
  const token = link.hash.slice('#token='.length)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(!JSON.stringify(job.payload).includes(token))
  return token
}
before(() => { assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test')) })
after(async () => {
  await getPool().query("DELETE FROM jobs WHERE deduplication_key IN (SELECT 'invitation:'||id FROM invitations WHERE workspace_id=ANY($1::uuid[]))", [workspaceIds])
  await getPool().query("DELETE FROM jobs j USING gateway_calls c,organisations o WHERE c.organisation_id=o.id AND o.workspace_id=ANY($1::uuid[]) AND j.deduplication_key LIKE 'call_push:'||c.id||':%'", [workspaceIds])
  await getPool().query('DELETE FROM audit_events WHERE workspace_id=ANY($1::uuid[])', [workspaceIds])
  await getPool().query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [userIds])
  await getPool().end()
})

test('customer invitation review is identity-bound, redacted and does not grant access before acceptance', async () => {
  const f = await fixture()
  const invitation = await platform.inviteMember(f.owner, f.org, { email: f.outsider.email, role: 'admin' })
  const token = await tokenFor(invitation.id)
  const review = await platform.inspectInvitation({ ...f.outsider, mfa: false }, token)
  assert.deepEqual(Object.keys(review).sort(), ['existingRole', 'expiresAt', 'organisationName', 'role'])
  assert.equal(review.organisationName, 'Customer A'); assert.equal(review.role, 'admin'); assert.equal(review.existingRole, null)
  assert.equal((await rows('SELECT * FROM organisation_members WHERE user_id=$1', [f.outsider.userId])).length, 0)
  assert.equal((await rows('SELECT * FROM seat_assignments WHERE user_id=$1', [f.outsider.userId])).length, 0)
  await assert.rejects(platform.inspectInvitation(f.member, token), denied('invitation_email_mismatch'))
  await assert.rejects(platform.inspectInvitation({ ...f.outsider, verified: false }, token), denied('email_verification_required'))
  await assert.rejects(platform.acceptInvitation({ ...f.outsider, mfa: false }, token), denied('mfa_required'))
  await platform.acceptInvitation(f.outsider, token)
  await assert.rejects(platform.inspectInvitation(f.outsider, token), denied('invalid_invitation'))
  assert.equal((await rows('SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2', [f.org, f.outsider.userId]))[0]!.role, 'admin')

  const existing = await platform.inviteMember(f.owner, f.org, { email: f.member.email, role: 'admin' }), existingToken = await tokenFor(existing.id)
  assert.equal((await platform.inspectInvitation(f.member, existingToken)).existingRole, 'user')
  await platform.acceptInvitation(f.member, existingToken)
  assert.equal((await rows('SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2', [f.org, f.member.userId]))[0]!.role, 'user')
})

test('customer invitation review rejects expired, revoked, suspended and withdrawn-authority invitations', async () => {
  const f = await fixture()
  for (const kind of ['expired', 'revoked', 'suspended', 'authority']) {
    const invitation = await platform.inviteMember(f.manager, f.org, { email: f.member.email, role: 'user' }), token = await tokenFor(invitation.id)
    await platform.inspectInvitation(f.member, token)
    if (kind === 'expired') await getPool().query("UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [invitation.id])
    if (kind === 'revoked') await management.revokeInvitation(f.owner, f.org, invitation.id)
    if (kind === 'suspended') await platform.setMemberStatus(f.owner, f.org, f.member.userId, 'suspended')
    if (kind === 'authority') await changeMemberRole(f.owner, f.org, f.manager.userId, { role: 'user' })
    await assert.rejects(platform.inspectInvitation(f.member, token), denied(kind === 'suspended' ? 'user_suspended' : 'invalid_invitation'))
    await assert.rejects(platform.acceptInvitation(f.member, token), denied(kind === 'suspended' ? 'user_suspended' : 'invalid_invitation'))
    if (kind === 'suspended') await platform.setMemberStatus(f.owner, f.org, f.member.userId, 'active')
  }
})

test('both invitation routes preserve validated fragments and legacy customer links normalise without carrying query data', () => {
  const token = 'x'.repeat(43), hash = `#token=${token}`
  for (const path of ['/portal/invitations/accept', '/portal/workspace-invitation']) {
    assert.equal(isInvitationPath(path), true)
    assert.equal(invitationDestination(path, hash), path + hash)
    assert.equal(invitationAuthPath(path), path)
    const securityPath = invitationAuthPath('/portal/security', path)!
    assert.equal(securityPath, `/portal/security?next=${path}`)
    assert.equal(invitationDestination(securityPath, hash), securityPath + hash)
    for (const invalid of ['#token=short', `${hash}&role=admin`, '#token=%20', `#token=${token}x`]) assert.equal(invitationDestination(path, invalid), path)
  }
  assert.equal(legacyCustomerInvitationHash('/portal/invitations/accept', token), hash)
  for (const value of [undefined, [token], '', token + '&role=admin']) assert.equal(legacyCustomerInvitationHash('/portal/invitations/accept', value), '')
  for (const path of ['/portal', '/portal/security', '//untrusted.example', '/portal/invitations/accept?extra=1']) {
    assert.equal(isInvitationPath(path), false)
    assert.equal(invitationDestination(path, hash), path)
    assert.equal(legacyCustomerInvitationHash(path, token), '')
  }
  assert.equal(invitationAuthPath('/portal/security', '//untrusted.example'), null)
  assert.equal(invitationAuthPath('/portal/security', ['/portal/invitations/accept']), null)
  assert.equal(invitationDestination('/portal/security?next=/portal/invitations/accept&extra=1', hash), '/portal/security?next=/portal/invitations/accept&extra=1')
})

test('customer roles and removal require scoped administration and MFA, with immediate role changes', async () => {
  const f = await fixture()
  for (const actor of [f.member, f.outsider]) {
    await assert.rejects(changeMemberRole(actor, f.org, f.member.userId, { role: 'admin' }), denied('not_found'))
    await assert.rejects(removeMember(actor, f.org, f.member.userId), denied('not_found'))
  }
  await assert.rejects(changeMemberRole({ ...f.manager, mfa: false }, f.org, f.member.userId, { role: 'admin' }), denied('mfa_required'))
  await assert.rejects(removeMember({ ...f.owner, verified: false }, f.org, f.member.userId), denied('email_verification_required'))
  await assert.rejects(changeMemberRole(f.manager, f.org, f.member.userId, { role: 'owner' }))
  await assert.rejects(removeMember(f.manager, f.otherOrg, f.member.userId), denied('not_found'))
  await changeMemberRole(f.manager, f.org, f.member.userId, { role: 'admin' })
  await requireOrganisation(f.member, f.org)
  await assert.rejects(requireOrganisation(f.member, f.otherOrg), denied('not_found'))
  await changeMemberRole(f.owner, f.org, f.member.userId, { role: 'user' })
  await assert.rejects(requireOrganisation(f.member, f.org), denied('not_found'))
  assert.equal((await platform.requireLicensedMember(f.member, f.org)).status, 'active')
  const changes = (await management.auditHistory(f.owner, f.ws)).filter(row => row.action === 'member.role_changed')
  assert.equal(changes.length, 2); assert.equal(changes[0]!.target_name, 'member')
  assert.deepEqual(changes[0]!.details, { previousRole: 'admin', role: 'user' })
})

test('removal revokes customer devices, assignments and references while preserving other customer access and workspace seats', async () => {
  const f = await fixture()
  const account = await platform.createConfiguration(f.owner, f.org, accountInput())
  const group = await management.createGroup(f.owner, f.org, { name: 'Fictional group' })
  await platform.assignConfiguration(f.owner, f.org, account.id, f.member.userId)
  await management.setGroupMembers(f.owner, f.org, group.id, { userIds: [f.member.userId] })
  await management.setGroupConfigurations(f.owner, f.org, group.id, { configurationIds: [account.id] })
  const device = await platform.enrolDevice(f.member, f.org, deviceInput('ios')), other = await platform.enrolDevice(f.member, f.otherOrg, deviceInput())
  await savePushToken(f.member, device.id, { token: 'a'.repeat(64) })
  const setup = await createSetupLink(f.owner, f.org, f.member.userId)
  const invitation = await platform.inviteMember(f.owner, f.org, { email: f.member.email }), token = await tokenFor(invitation.id)
  await removeMember(f.manager, f.org, f.member.userId)
  await removeMember(f.manager, f.org, f.member.userId) // Idempotent without duplicate audit records.
  const detail = await platform.organisationDetails(f.owner, f.org), member = detail.members.find(row => row.user_id === f.member.userId)!
  assert.equal(member.status, 'removed'); assert.ok(member.removed_at); assert.equal(member.licensed, true)
  assert.ok(detail.devices.find(row => row.id === device.id)!.revoked_at)
  assert.equal(detail.assignments.length, 0); assert.deepEqual(detail.groups[0]!.user_ids, [])
  assert.equal((await rows('SELECT * FROM push_endpoints WHERE device_id=$1', [device.id])).length, 0)
  await assert.rejects(platform.provisionDevice(f.member, device.id), denied('device_unavailable'))
  await assert.rejects(reportDevice(f.member, device.id, {}), denied('device_unavailable'))
  await assert.rejects(platform.enrolDevice(f.member, f.org, deviceInput()), denied('managed_access_unavailable'))
  await assert.rejects(redeemSetupLink(f.member, { reference: new URL(setup.url).hash.slice(5) }), denied('setup_link_unavailable'))
  await assert.rejects(platform.acceptInvitation(f.member, token), denied('invalid_invitation'))
  await assert.rejects(platform.setMemberStatus(f.owner, f.org, f.member.userId, 'active'), denied('member_removed'))
  await assert.rejects(changeMemberRole(f.owner, f.org, f.member.userId, { role: 'admin' }), denied('member_removed'))
  await assert.rejects(platform.assignConfiguration(f.owner, f.org, account.id, f.member.userId), denied('not_found'))
  await assert.rejects(management.setGroupMembers(f.owner, f.org, group.id, { userIds: [f.member.userId] }), denied('invalid_members'))
  assert.deepEqual((await clientOrganisations(f.member)).organisations.map(row => row.id), [f.otherOrg])
  assert.deepEqual((await platform.overview(f.member)).organisations.map(row => row.id), [f.otherOrg])
  assert.equal((await platform.provisionDevice(f.member, other.id)).organisation.id, f.otherOrg)
  assert.equal((await platform.workspaceDetails(f.owner, f.ws)).seats.length, 1)
  assert.equal((await management.auditHistory(f.owner, f.ws)).filter(row => row.action === 'member.removed').length, 1)
})

test('rejoining requires a fresh invitation and does not restore old devices or assignments', async () => {
  const f = await fixture(), input = deviceInput()
  const device = await platform.enrolDevice(f.member, f.org, input)
  await removeMember(f.owner, f.org, f.member.userId)
  const invitation = await platform.inviteMember(f.owner, f.org, { email: f.member.email, role: 'admin' }), token = await tokenFor(invitation.id)
  await assert.rejects(platform.acceptInvitation({ ...f.member, mfa: false }, token), denied('mfa_required'))
  assert.equal((await platform.acceptInvitation(f.member, token)).organisationId, f.org)
  const record = (await rows('SELECT * FROM organisation_members WHERE organisation_id=$1 AND user_id=$2', [f.org, f.member.userId]))[0]!
  assert.equal(record.role, 'admin'); assert.equal(record.status, 'active'); assert.equal(record.removed_at, null)
  await assert.rejects(platform.provisionDevice(f.member, device.id), denied('device_unavailable'))
  await assert.rejects(platform.enrolDevice(f.member, f.org, input), denied('device_revoked'))
  const fresh = await platform.enrolDevice(f.member, f.org, deviceInput())
  assert.notEqual(fresh.id, device.id); assert.deepEqual((await platform.provisionDevice(f.member, fresh.id)).accounts, [])
  assert.ok((await management.auditHistory(f.owner, f.ws)).some(row => row.action === 'member.restored'))
})

test('removal and invitation acceptance are serialised and cannot restore withdrawn access', async () => {
  const f = await fixture()
  const invitation = await platform.inviteMember(f.owner, f.org, { email: f.member.email }), token = await tokenFor(invitation.id)
  const results = await Promise.allSettled([platform.acceptInvitation(f.member, token), removeMember(f.owner, f.org, f.member.userId)])
  assert.equal(results[1]!.status, 'fulfilled')
  if (results[0]!.status === 'rejected') assert.equal(results[0]!.reason.code, 'invalid_invitation')
  assert.equal((await rows('SELECT status FROM organisation_members WHERE organisation_id=$1 AND user_id=$2', [f.org, f.member.userId]))[0]!.status, 'removed')
  const next = await fixture()
  const enrolments = Array.from({ length: 8 }, () => platform.enrolDevice(next.member, next.org, deviceInput()))
  const all = await Promise.allSettled([...enrolments, removeMember(next.owner, next.org, next.member.userId)])
  assert.equal(all.at(-1)!.status, 'fulfilled')
  for (const result of all.slice(0, -1)) if (result.status === 'rejected') assert.equal(result.reason.code, 'managed_access_unavailable')
  assert.equal((await rows('SELECT id FROM devices WHERE organisation_id=$1 AND user_id=$2 AND revoked_at IS NULL', [next.org, next.member.userId])).length, 0)
})

test('demotion and removal invalidate delegated invitations, and queued writes recheck the administrator role', async () => {
  const f = await fixture()
  const invitation = await platform.inviteMember(f.manager, f.org, { email: f.outsider.email }), token = await tokenFor(invitation.id)
  await changeMemberRole(f.owner, f.org, f.manager.userId, { role: 'user' })
  await assert.rejects(platform.acceptInvitation(f.outsider, token), denied('invalid_invitation'))
  await assert.rejects(platform.inviteMember(f.manager, f.org, { email: f.outsider.email }), denied('not_found'))
  await changeMemberRole(f.owner, f.org, f.manager.userId, { role: 'admin' })
  let queued: Promise<unknown> | undefined
  await transaction(async db => {
    await db.query('SELECT id FROM organisations WHERE id=$1 FOR UPDATE', [f.org])
    await db.query("UPDATE organisation_members SET role='user' WHERE organisation_id=$1 AND user_id=$2", [f.org, f.manager.userId])
    queued = changeMemberRole(f.manager, f.org, f.member.userId, { role: 'admin' })
  })
  await assert.rejects(queued!, denied('not_found'))
  const stillUser = (await rows('SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2', [f.org, f.member.userId]))[0]!
  assert.equal(stillUser.role, 'user')
})

test('removing gateway access stops registration eligibility and queued pushes without ending an answered call', async () => {
  const f = await fixture(), config = await platform.createConfiguration(f.owner, f.org, accountInput('gateway'))
  await platform.assignConfiguration(f.owner, f.org, config.id, f.member.userId)
  const device = await platform.enrolDevice(f.member, f.org, deviceInput('ios'))
  await savePushToken(f.member, device.id, { token: 'b'.repeat(64) })
  const callId = randomUUID()
  await incomingGatewayCall('membership-test', { callId, configurationId: config.id, caller: { name: 'Fictional caller', number: '200' } })
  await deviceCall(f.member, device.id, callId, 'answer')
  await gatewayCall('membership-test', callId, { event: 'connected', deviceId: device.id })
  const pendingId = randomUUID()
  await incomingGatewayCall('membership-test', { callId: pendingId, configurationId: config.id, caller: { name: 'Fictional second caller', number: '201' } })
  await removeMember(f.owner, f.org, f.member.userId)
  assert.equal((await rows('SELECT * FROM eligible_gateway_devices WHERE device_id=$1', [device.id])).length, 0)
  assert.equal((await gatewayCall('membership-test', callId)).state, 'answered')
  assert.equal((await deviceCall(f.member, device.id, callId, 'status')).state, 'answered')
  const withdrawn = await deviceCall(f.member, device.id, pendingId, 'answer')
  assert.equal(withdrawn.state, 'ended'); assert.equal(withdrawn.reason, 'access_withdrawn'); assert.equal(withdrawn.claimedByThisDevice, false)
  assert.equal('caller' in withdrawn, false)
  await assert.rejects(gatewayCall('membership-test', pendingId, { event: 'answer', deviceId: device.id }), denied('call_taken'))
  let sends = 0
  while (await runOnePushJob(async () => { sends++; return 'accepted' })) {}
  assert.equal(sends, 0)
  await gatewayCall('membership-test', callId, { event: 'ended', reason: 'completed' })
  assert.equal((await gatewayCall('membership-test', callId)).state, 'ended')
})
