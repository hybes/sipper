import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows, transaction } from '../server/lib/db'
import { openSecret } from '../server/lib/crypto'
import { requireOrganisation, requireWorkspace, type Principal } from '../server/lib/access'
import * as platform from '../server/lib/platform'
import * as staff from '../server/lib/workspace-staff'
import { auditHistory, createGroup, deleteConfiguration, setGroupMembers } from '../server/lib/management'
import { billingPortal, changeQuantity } from '../server/lib/billing'
import { customerCallActivity, requestCallEnd } from '../server/lib/service-operations'
import { companySignIn } from '../server/lib/company-sign-in'
import { scimSettings } from '../server/lib/scim-settings'
import { organisationDirectory } from '../server/lib/directory'
import { createSetupLink } from '../server/lib/setup-links'
import { changeMemberRole, removeMember } from '../server/lib/customer-members'
import { invitationDestination } from '../app/utils/invitation-navigation'

const userIds: string[] = [], workspaceIds: string[] = []
const denied = (code: string) => (error: any) => error.code === code
async function user(label: string): Promise<Principal> {
  const userId = randomUUID(), email = `${label}-${userId}@example.invalid`
  await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())', [userId, label, email])
  userIds.push(userId)
  return { userId, email, verified: true, mfa: true }
}
async function workspace(owner: Principal) {
  const result = await platform.createWorkspace(owner, { name: 'Staff test workspace', kind: 'reseller' })
  workspaceIds.push(result.id)
  return result.id as string
}
async function add(actor: Principal, workspaceId: string, role: string) {
  await getPool().query('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspaceId, actor.userId, role])
}
async function tokenFor(invitationId: string) {
  const job = (await rows('SELECT id,payload FROM jobs WHERE deduplication_key=$1', [`workspace-invitation:${invitationId}`]))[0]!
  const message = JSON.parse(openSecret(job.payload, `mail:${job.id}`))
  const url = new URL(message.text.match(/https?:\/\/\S+/)[0])
  assert.equal(url.pathname, '/portal/workspace-invitation')
  assert.equal(url.search, '')
  const token = url.hash.slice('#token='.length)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(!JSON.stringify(job.payload).includes(token))
  return token
}
before(() => { assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test')) })
after(async () => {
  await getPool().query("DELETE FROM jobs WHERE deduplication_key IN (SELECT 'workspace-invitation:'||id FROM workspace_invitations WHERE workspace_id=ANY($1::uuid[]))", [workspaceIds])
  await getPool().query('DELETE FROM audit_events WHERE workspace_id=ANY($1::uuid[])', [workspaceIds])
  await getPool().query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [userIds])
  await getPool().end()
})

test('staff roles enforce verified owner-only writes, tenant boundaries and role-aware management views', async () => {
  const [owner, admin, billing, outsider, invited] = await Promise.all(['owner', 'admin', 'billing', 'outside', 'invited'].map(user))
  const id = await workspace(owner!)
  await add(admin!, id, 'admin'); await add(billing!, id, 'billing')
  assert.equal((await staff.workspaceStaff(owner!, id)).canManage, true)
  assert.equal((await staff.workspaceStaff(admin!, id)).canManage, false)
  assert.deepEqual((await platform.workspaceDetails(billing!, id)).permissions, { manageCustomers: false, viewCustomers: false, manageBilling: true, viewStaff: false })
  assert.deepEqual((await platform.workspaceDetails(admin!, id)).permissions, { manageCustomers: true, viewCustomers: true, manageBilling: true, viewStaff: true })
  for (const actor of [billing!, outsider!]) await assert.rejects(staff.workspaceStaff(actor, id), denied('not_found'))
  for (const work of [
    () => staff.inviteWorkspaceStaff(admin!, id, { email: invited!.email, role: 'admin' }),
    () => staff.changeWorkspaceMember(admin!, id, billing!.userId, { role: 'owner' }),
    () => staff.revokeWorkspaceInvitation(admin!, id, randomUUID()),
  ]) await assert.rejects(work(), denied('owner_required'))
  await assert.rejects(staff.inviteWorkspaceStaff(outsider!, id, { email: invited!.email, role: 'admin' }), denied('not_found'))
  await assert.rejects(staff.inviteWorkspaceStaff({ ...owner!, mfa: false }, id, { email: invited!.email, role: 'admin' }), denied('mfa_required'))
  await assert.rejects(staff.inviteWorkspaceStaff({ ...owner!, verified: false }, id, { email: invited!.email, role: 'admin' }), denied('email_verification_required'))
  await assert.rejects(staff.inviteWorkspaceStaff(owner!, id, { email: invited!.email, role: 'platform_owner' }))
  await assert.rejects(staff.inviteWorkspaceStaff(owner!, id, { email: admin!.email, role: 'owner' }), denied('already_member'))
  assert.equal((await rows('SELECT * FROM workspace_invitations WHERE workspace_id=$1', [id])).length, 0)
})

test('staff invitations are encrypted, identity-bound, MFA-protected and consumed once without calling access', async () => {
  const [owner, recipient, outsider] = await Promise.all(['owner', 'recipient', 'outside'].map(user))
  const id = await workspace(owner!)
  const invitation = await staff.inviteWorkspaceStaff(owner!, id, { email: ` ${recipient!.email.toUpperCase()} `, role: 'admin' })
  const token = await tokenFor(invitation.id)
  const list = await staff.workspaceStaff(owner!, id)
  assert.equal(list.invitations[0]!.email, recipient!.email)
  assert.ok(!JSON.stringify(list).includes(token)); assert.ok(!JSON.stringify(list).includes('token_hash'))
  await assert.rejects(staff.inspectWorkspaceInvitation(outsider!, token), denied('invalid_invitation'))
  await assert.rejects(staff.inspectWorkspaceInvitation({ ...recipient!, verified: false }, token), denied('email_verification_required'))
  assert.equal((await staff.inspectWorkspaceInvitation({ ...recipient!, mfa: false }, token)).role, 'admin')
  await assert.rejects(staff.acceptWorkspaceInvitation({ ...recipient!, mfa: false }, token), denied('mfa_required'))
  const results = await Promise.allSettled([staff.acceptWorkspaceInvitation(recipient!, token), staff.acceptWorkspaceInvitation(recipient!, token)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'invalid_invitation')
  const member = (await rows('SELECT * FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [id, recipient!.userId]))[0]!
  assert.equal(member.role, 'admin'); assert.ok(member.joined_at)
  assert.equal((await rows('SELECT * FROM seat_assignments WHERE workspace_id=$1', [id])).length, 0)
  assert.equal((await rows('SELECT * FROM organisation_members WHERE workspace_id=$1', [id])).length, 0)
  const history = await auditHistory(owner!, id)
  assert.equal(history.filter(event => event.action === 'workspace_member.joined').length, 1)
  assert.equal(history.find(event => event.action === 'workspace_member.joined')!.target_name, 'recipient')
  assert.equal(history.find(event => event.action === 'workspace_invitation.created')!.target_name, recipient!.email)
  assert.ok(!JSON.stringify(history).includes(token))
})

test('replacement, expiry and revocation invalidate workspace invitations without changing existing roles', async () => {
  const [owner, recipient, outsider] = await Promise.all(['owner', 'recipient', 'outside'].map(user))
  const id = await workspace(owner!), other = await workspace(outsider!)
  const first = await staff.inviteWorkspaceStaff(owner!, id, { email: recipient!.email, role: 'owner' }), firstToken = await tokenFor(first.id)
  const second = await staff.inviteWorkspaceStaff(owner!, id, { email: recipient!.email, role: 'billing' }), secondToken = await tokenFor(second.id)
  await assert.rejects(staff.acceptWorkspaceInvitation(recipient!, firstToken), denied('invalid_invitation'))
  await assert.rejects(staff.revokeWorkspaceInvitation(outsider!, other, second.id), denied('not_found'))
  await staff.revokeWorkspaceInvitation(owner!, id, second.id)
  await assert.rejects(staff.acceptWorkspaceInvitation(recipient!, secondToken), denied('invalid_invitation'))
  const expired = await staff.inviteWorkspaceStaff(owner!, id, { email: recipient!.email, role: 'owner' }), expiredToken = await tokenFor(expired.id)
  await getPool().query("UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id])
  await assert.rejects(staff.acceptWorkspaceInvitation(recipient!, expiredToken), denied('invalid_invitation'))
  const current = await staff.inviteWorkspaceStaff(owner!, id, { email: recipient!.email, role: 'owner' }), currentToken = await tokenFor(current.id)
  await add(recipient!, id, 'billing')
  await assert.rejects(staff.acceptWorkspaceInvitation(recipient!, currentToken), denied('already_member'))
  assert.equal((await rows('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [id, recipient!.userId]))[0]!.role, 'billing')
  await staff.changeWorkspaceMember(owner!, id, recipient!.userId, { role: 'admin' })
  await assert.rejects(staff.acceptWorkspaceInvitation(recipient!, currentToken), denied('invalid_invitation'))
})

test('concurrent invitations leave only the latest reference usable', async () => {
  const [owner, recipient] = await Promise.all(['owner', 'recipient'].map(user)), id = await workspace(owner!)
  const invitations = await Promise.all(['admin', 'billing'].map(role => staff.inviteWorkspaceStaff(owner!, id, { email: recipient!.email, role })))
  const tokens = await Promise.all(invitations.map(invitation => tokenFor(invitation.id)))
  const checks = await Promise.allSettled(tokens.map(token => staff.inspectWorkspaceInvitation(recipient!, token)))
  assert.equal(checks.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await rows('SELECT id FROM workspace_invitations WHERE workspace_id=$1 AND revoked_at IS NULL', [id])).length, 1)
})

test('last-owner protection is serialised and rechecks the acting owner after a concurrent demotion', async () => {
  const [first, second] = await Promise.all(['first-owner', 'second-owner'].map(user)), id = await workspace(first!)
  await assert.rejects(staff.changeWorkspaceMember(first!, id, first!.userId, null), denied('last_owner'))
  await assert.rejects(staff.changeWorkspaceMember(first!, id, first!.userId, { role: 'admin' }), denied('last_owner'))
  await add(second!, id, 'owner')
  const results = await Promise.allSettled([
    staff.changeWorkspaceMember(first!, id, first!.userId, { role: 'admin' }),
    staff.changeWorkspaceMember(second!, id, second!.userId, { role: 'billing' }),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'last_owner')
  assert.equal((await rows("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND role='owner'", [id])).length, 1)

  // Hold the same lock as a role change, queue the demoted actor, then commit the change.
  const current = (await rows("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND role='owner'", [id]))[0]!.user_id
  const surviving = current === first!.userId ? first! : second!, demoted = current === first!.userId ? second! : first!
  await staff.changeWorkspaceMember(surviving, id, demoted.userId, { role: 'owner' })
  let queued: Promise<unknown> | undefined
  await transaction(async db => {
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [id])
    await db.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [id, demoted.userId])
    queued = staff.changeWorkspaceMember(demoted, id, surviving.userId, { role: 'billing' })
  })
  await assert.rejects(queued!, denied('owner_required'))
})

test('staff removal withdraws administration and pending invites while preserving separate customer calling access', async () => {
  const [owner, colleague, recipient] = await Promise.all(['owner', 'colleague', 'recipient'].map(user)), id = await workspace(owner!)
  await add(colleague!, id, 'owner')
  const org = (await platform.createOrganisation(owner!, id, { name: 'Fictional calling customer' })).id
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [id, org, colleague!.userId])
  await getPool().query("INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats,paid_until) VALUES ($1,'test','active',1,now()+interval '1 day')", [id])
  await platform.assignSeat(owner!, id, colleague!.userId)
  const device = await platform.enrolDevice(colleague!, org, { installationId: randomUUID(), name: 'Fictional Mac', platform: 'macos', appVersion: '0.1.0', osVersion: '14' })
  const invitation = await staff.inviteWorkspaceStaff(colleague!, id, { email: recipient!.email, role: 'owner' }), token = await tokenFor(invitation.id)
  await staff.changeWorkspaceMember(owner!, id, colleague!.userId, null)
  await assert.rejects(requireWorkspace(colleague!, id), denied('not_found'))
  await assert.rejects(requireOrganisation(colleague!, org), denied('not_found'))
  await assert.rejects(staff.acceptWorkspaceInvitation(recipient!, token), denied('invalid_invitation'))
  await requireOrganisation(colleague!, org, false)
  assert.equal((await rows('SELECT * FROM seat_assignments WHERE workspace_id=$1 AND user_id=$2', [id, colleague!.userId])).length, 1)
  assert.equal((await rows('SELECT revoked_at FROM devices WHERE id=$1', [device.id]))[0]!.revoked_at, null)
  const history = await auditHistory(owner!, id)
  assert.equal(history.find(row => row.action === 'workspace_member.removed')!.target_id, colleague!.userId)
})

test('platform-owner staff actions still require MFA, retain last-owner checks and attribute audit events', async () => {
  const [owner, global, recipient] = await Promise.all(['owner', 'platform-owner', 'recipient'].map(user)), id = await workspace(owner!)
  await getPool().query('INSERT INTO platform_owners (user_id) VALUES ($1)', [global!.userId])
  try {
    assert.equal((await staff.workspaceStaff(global!, id)).canManage, true)
    await assert.rejects(staff.inviteWorkspaceStaff({ ...global!, mfa: false }, id, { email: recipient!.email, role: 'billing' }), denied('mfa_required'))
    await assert.rejects(staff.changeWorkspaceMember(global!, id, owner!.userId, null), denied('last_owner'))
    const invitation = await staff.inviteWorkspaceStaff(global!, id, { email: recipient!.email, role: 'billing' }), token = await tokenFor(invitation.id)
    assert.equal((await rows("SELECT actor_id FROM audit_events WHERE workspace_id=$1 AND action='workspace_invitation.created'", [id]))[0]!.actor_id, global!.userId)
    await getPool().query('DELETE FROM platform_owners WHERE user_id=$1', [global!.userId])
    await assert.rejects(staff.acceptWorkspaceInvitation(recipient!, token), denied('invalid_invitation'))
    await assert.rejects(auditHistory(global!, id), denied('not_found'))
  } finally { await getPool().query('DELETE FROM platform_owners WHERE user_id=$1', [global!.userId]) }
})

test('invitation references stay in a validated fragment through browser sign-in and MFA navigation', () => {
  const hash = `#token=${'a'.repeat(43)}`
  assert.equal(invitationDestination('/portal/workspace-invitation', hash), `/portal/workspace-invitation${hash}`)
  for (const next of ['/portal', '/portal/security', '/portal/workspace-invitation?extra=true']) assert.equal(invitationDestination(next, hash), next)
  for (const fragment of ['#token=short', `${hash}&role=owner`, '#token=' + 'a'.repeat(44), '#token=%61'.repeat(43)]) assert.equal(invitationDestination('/portal/workspace-invitation', fragment), '/portal/workspace-invitation')
})

test('activity history pages without duplicates and never includes another workspace', async () => {
  const [owner, outsider] = await Promise.all(['audit-owner', 'audit-outside'].map(user)), id = await workspace(owner!), other = await workspace(outsider!)
  await getPool().query("INSERT INTO audit_events (workspace_id,actor_id,action,target_id) SELECT $1,$2,'workspace_member.role_changed',$2 FROM generate_series(1,105)", [id, owner!.userId])
  const first = await auditHistory(owner!, id), second = await auditHistory(owner!, id, first.at(-1)!.id)
  assert.equal(first.length, 100); assert.equal(second.length, 6)
  assert.equal(new Set([...first, ...second].map(row => row.id)).size, 106)
  assert.equal((await auditHistory(owner!, id, second.at(-1)!.id)).length, 0)
  assert.ok([...first, ...second].every(row => row.actor_name === 'audit-owner'))
  await assert.rejects(auditHistory(owner!, other), denied('not_found'))
  await assert.rejects(auditHistory(owner!, id, 'bad-cursor'), denied('invalid_cursor'))
})


test('read-only support can inspect scoped activity but cannot mutate, obtain credentials or inherit calling access', async () => {
  const [owner, support, outside, person] = await Promise.all(['support-owner', 'support-reader', 'outside', 'calling-user'].map(user))
  const id = await workspace(owner!), other = await workspace(outside!)
  const org = (await platform.createOrganisation(owner!, id, { name: 'Support customer' })).id
  const otherOrg = (await platform.createOrganisation(outside!, other, { name: 'Private customer' })).id
  const invitation = await staff.inviteWorkspaceStaff(owner!, id, { email: support!.email, role: 'support' })
  const token = await tokenFor(invitation.id)
  assert.equal((await staff.inspectWorkspaceInvitation(support!, token)).role, 'support')
  await assert.rejects(staff.acceptWorkspaceInvitation({ ...support!, mfa: false }, token), denied('mfa_required'))
  await staff.acceptWorkspaceInvitation(support!, token)
  assert.deepEqual((await platform.workspaceDetails(support!, id)).permissions, { manageCustomers: false, viewCustomers: true, manageBilling: false, viewStaff: false })
  assert.equal((await rows('SELECT 1 FROM organisation_members WHERE user_id=$1', [support!.userId])).length, 0)
  assert.equal((await rows('SELECT 1 FROM seat_assignments WHERE user_id=$1', [support!.userId])).length, 0)
  await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')", [id,org,person!.userId])
  await getPool().query("INSERT INTO subscriptions(workspace_id,provider,status,purchased_seats,paid_until) VALUES($1,'test','active',1,now()+interval '1 day')", [id])
  await platform.assignSeat(owner!, id, person!.userId)
  const settings = { label:'Fixture account', mode:'direct', password:'support-fixture-secret', settings:{ username:'test',domain:'pbx.example.invalid',server:'sip.example.invalid' } }
  const config = await platform.createConfiguration(owner!,org,settings)
  await platform.assignConfiguration(owner!,org,config.id,person!.userId)
  const device = await platform.enrolDevice(person!,org,{installationId:randomUUID(),name:'Fixture phone',platform:'android',appVersion:'0.1.0',osVersion:'16'})
  await getPool().query("UPDATE devices SET last_request_ip='192.0.2.25',last_login_at=now(),last_request_at=now(),last_request_action='report' WHERE id=$1",[device.id])
  await assert.rejects(platform.provisionDevice(support!,device.id),denied('device_unavailable'))
  const detail = await platform.organisationDetails(support!,org)
  assert.equal(detail.permissions.manage,false); assert.equal(detail.devices[0]!.last_request_ip,'192.0.2.25')
  assert.ok(detail.devices[0]!.last_login_at); assert.ok(detail.devices[0]!.last_request_at)
  for (const value of ['support-fixture-secret','secret_envelope','token_hash']) assert.ok(!JSON.stringify(detail).includes(value))
  assert.equal((await customerCallActivity(support!,org)).canEndCalls,false)
  assert.ok((await auditHistory(support!,id)).length)
  for (const read of [() => platform.workspaceDetails(support!,other), () => platform.organisationDetails(support!,otherOrg), () => customerCallActivity(support!,otherOrg), () => auditHistory(support!,other)]) await assert.rejects(read(),denied('not_found'))
  await assert.rejects(platform.organisationDetails({...support!,mfa:false},org),denied('mfa_required'))
  await assert.rejects(platform.organisationDetails({...support!,verified:false},org),denied('email_verification_required'))
  const before = (await auditHistory(owner!,id)).length
  for (const change of [
    () => requireWorkspace(support!,id,'manage'), () => requireWorkspace(support!,id,'billing'),
    () => requireOrganisation(support!,org,false),
    () => platform.createOrganisation(support!,id,{name:'Denied'}),
    () => platform.assignSeat(support!,id,person!.userId), () => platform.releaseSeat(support!,id,person!.userId),
    () => platform.createConfiguration(support!,org,settings), () => deleteConfiguration(support!,org,config.id),
    () => platform.assignConfiguration(support!,org,config.id,support!.userId),
    () => platform.setMemberStatus(support!,org,person!.userId,'suspended'),
    () => platform.revokeDevice(support!,org,device.id),
    () => platform.inviteMember(support!,org,{email:'blocked@example.invalid',role:'admin'}),
    () => createGroup(support!,org,{name:'Denied'}), () => setGroupMembers(support!,org,randomUUID(),{userIds:[]}),
    () => createSetupLink(support!,org,person!.userId),
    () => changeMemberRole(support!,org,person!.userId,{role:'admin'}), () => removeMember(support!,org,person!.userId),
    () => staff.workspaceStaff(support!,id), () => staff.changeWorkspaceMember(support!,id,support!.userId,{role:'owner'}),
    () => billingPortal(support!,id), () => changeQuantity(support!,id,{quantity:2}),
    () => requestCallEnd(support!,org,randomUUID()), () => companySignIn(support!,org), () => scimSettings(support!,org), () => organisationDirectory(support!,org,{}),
  ]) await assert.rejects(change(),denied('not_found'))
  assert.equal((await auditHistory(owner!,id)).length,before)
  assert.equal((await rows('SELECT revoked_at FROM devices WHERE id=$1',[device.id]))[0]!.revoked_at,null)
  // Separately granted customer administration remains additive, never workspace billing access.
  await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'admin')",[id,org,support!.userId])
  assert.equal((await platform.organisationDetails(support!,org)).permissions.manage,true)
  assert.equal((await customerCallActivity(support!,org)).canEndCalls,true)
  await assert.rejects(billingPortal(support!,id),denied('not_found'))
  await getPool().query("UPDATE organisation_members SET role='user' WHERE organisation_id=$1 AND user_id=$2",[org,support!.userId])
  await staff.changeWorkspaceMember(owner!,id,support!.userId,null)
  for (const read of [() => platform.workspaceDetails(support!,id), () => platform.organisationDetails(support!,org), () => customerCallActivity(support!,org), () => auditHistory(support!,id)]) await assert.rejects(read(),denied('not_found'))
  await requireOrganisation(support!,org,false)
})
