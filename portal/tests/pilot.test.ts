import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import { configurePilot } from '../server/lib/pilot'
import { configureTestBilling } from '../server/lib/billing'
import { assignSeat, createOrganisation, createWorkspace, requireLicensedMember, workspaceDetails } from '../server/lib/platform'
import type { Principal } from '../server/lib/access'

const owner: Principal = { userId: randomUUID(), email: `pilot-owner-${randomUUID()}@example.invalid`, verified: true, mfa: true }
const admin: Principal = { userId: randomUUID(), email: `pilot-admin-${randomUUID()}@example.invalid`, verified: true, mfa: true }
const member: Principal = { userId: randomUUID(), email: `pilot-member-${randomUUID()}@example.invalid`, verified: true, mfa: false }
let workspace: string, organisation: string, paidWorkspace: string
const grant = { quantity: 2, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), expectedUpdatedAt: null as string | null }
const code = (expected: string) => (error: any) => error.code === expected

before(async () => {
  for (const actor of [owner, admin, member]) {
    await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,$4,now(),now())', [actor.userId, 'Pilot fixture', actor.email, actor.mfa])
  }
  await getPool().query('INSERT INTO platform_owners (user_id) VALUES ($1)', [owner.userId])
  workspace = (await createWorkspace(admin, { name: 'Pilot fixture', kind: 'business' })).id
  paidWorkspace = (await createWorkspace(admin, { name: 'Paid fixture', kind: 'business' })).id
  organisation = (await createOrganisation(admin, workspace, { name: 'Pilot customer' })).id
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role,status) VALUES ($1,$2,$3,'user','active'),($1,$2,$4,'user','active')", [workspace, organisation, member.userId, admin.userId])
  await getPool().query("INSERT INTO subscriptions (workspace_id,provider,status,purchased_seats) VALUES ($1,'stripe','active',5)", [paidWorkspace])
})
after(async () => {
  await getPool().query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [[workspace, paidWorkspace]])
  await getPool().query('DELETE FROM platform_owners WHERE user_id=$1', [owner.userId])
  await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [[owner.userId, admin.userId, member.userId]])
  await getPool().end()
})

test('only a verified MFA platform owner can grant production pilot capacity', async () => {
  await assert.rejects(configurePilot(admin, workspace, grant), code('not_found'))
  await assert.rejects(configurePilot({ ...owner, verified: false }, workspace, grant), code('email_verification_required'))
  await assert.rejects(configurePilot({ ...owner, mfa: false }, workspace, grant), code('mfa_required'))
  assert.equal((await rows('SELECT * FROM subscriptions WHERE workspace_id=$1', [workspace])).length, 0)
  await configurePilot(owner, workspace, grant)
  await assignSeat(admin, workspace, member.userId)
  assert.equal((await requireLicensedMember(member, organisation)).user_id, member.userId)
  const sub = (await workspaceDetails(admin, workspace)).subscription!
  assert.equal(sub.provider, 'pilot')
  assert.equal(sub.paid_until.toISOString(), grant.expiresAt)
})

test('pilot exact retries are idempotent, stale changes fail and existing payments are preserved', async () => {
  await configurePilot(owner, workspace, grant)
  assert.equal((await rows("SELECT * FROM audit_events WHERE workspace_id=$1 AND action='billing.pilot_updated'", [workspace])).length, 1)
  await assert.rejects(configurePilot(owner, workspace, { ...grant, quantity: 3 }), code('pilot_changed'))
  await assert.rejects(configurePilot(owner, paidWorkspace, grant), code('subscription_exists'))
  await assert.rejects(configureTestBilling(admin, workspace, { quantity: 3 }), code('real_billing_exists'))
  assert.equal((await rows('SELECT purchased_seats FROM subscriptions WHERE workspace_id=$1', [paidWorkspace]))[0]!.purchased_seats, 5)
})

test('pilots require bounded expiry and cannot drop allocated capacity', async () => {
  for (const offset of [-1, 91]) {
    await assert.rejects(configurePilot(owner, workspace, { ...grant, expiresAt: new Date(Date.now() + offset * 86400000).toISOString() }), code('invalid_pilot_expiry'))
  }
  await assignSeat(admin, workspace, admin.userId)
  const sub = (await workspaceDetails(admin, workspace)).subscription!
  await assert.rejects(configurePilot(owner, workspace, { ...grant, quantity: 1, expectedUpdatedAt: sub.updated_at.toISOString() }), code('seats_in_use'))
  await assert.rejects(getPool().query('UPDATE subscriptions SET paid_until=NULL WHERE workspace_id=$1', [workspace]), code('23514'))
})

test('expiry withdraws managed access without deleting personal identity or seat assignments', async () => {
  await getPool().query("UPDATE subscriptions SET paid_until=now()-interval '1 second' WHERE workspace_id=$1", [workspace])
  await assert.rejects(requireLicensedMember(member, organisation), code('managed_access_unavailable'))
  assert.equal((await rows('SELECT * FROM seat_assignments WHERE workspace_id=$1', [workspace])).length, 2)
  assert.equal((await rows('SELECT id FROM auth_user WHERE id=$1', [member.userId])).length, 1)
})
