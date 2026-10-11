import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { authRequests, totp } from '../tests/auth-helper'
import { getConfig } from '../server/lib/config'
import { getPool, rows } from '../server/lib/db'
import { openSecret } from '../server/lib/crypto'
import { sessionPrincipal } from '../server/lib/http'
import { createWorkspace, enrolDevice } from '../server/lib/platform'
import { inviteWorkspaceStaff, acceptWorkspaceInvitation } from '../server/lib/workspace-staff'
import { readDirectoryCsv } from '../shared/directory'
import { gatewayCall } from '../server/lib/mobile-calls'

const config = getConfig()
if (config.NODE_ENV !== 'development' || !['localhost', '127.0.0.1'].includes(new URL(config.SIPPER_BASE_URL).hostname) || !['localhost', '127.0.0.1'].includes(config.SMTP_HOST)) throw new Error('Staff HTTP checks require local development and local Mailpit')
const fixture = JSON.parse(await readFile('.data/browser-fixture.json', 'utf8'))
assert.match(fixture.email, /@example\.invalid$/)
const browser = authRequests(), workspaceIds: string[] = []
const userId = randomUUID(), email = `staff-http-${userId}@example.invalid`
const recipient = { userId, email, verified: true, mfa: true }
async function invitationToken(id: string, kind = 'workspace-invitation') {
  const job = (await rows('SELECT id,payload FROM jobs WHERE deduplication_key=$1', [`${kind}:${id}`]))[0]!
  const message = JSON.parse(openSecret(job.payload, `mail:${job.id}`))
  const link = new URL(message.text.match(/https?:\/\/\S+/)[0])
  assert.equal(link.search, '')
  return link.hash.slice('#token='.length)
}
try {
  assert.equal((await browser.call('/sign-in/email', { email: fixture.email, password: fixture.password })).status, 200)
  assert.equal((await browser.call('/two-factor/verify-totp', { code: totp(fixture.totpSecret) })).status, 200)
  const headers = browser.headers(); headers.set('origin', config.SIPPER_BASE_URL); headers.set('content-type', 'application/json')
  const actor = await sessionPrincipal(headers), base = `${config.SIPPER_BASE_URL}/api/platform`
  async function api(path: string, method = 'GET', body?: unknown, expected = 200) {
    const response = await fetch(`${base}/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.status, expected, `${method} ${path} returned ${response.status}`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return await response.json() as any
  }
  await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())', [userId, 'Fictional HTTP staff', email])
  const workspace = await api('workspaces', 'POST', { name: 'Temporary staff HTTP check', kind: 'reseller' })
  workspaceIds.push(workspace.id)
  const path = `workspaces/${workspace.id}`
  assert.equal((await fetch(`${base}/${path}/staff`)).status, 401)
  assert.equal((await api(`${path}/staff`)).canManage, true)
  await api(`${path}/staff/${actor.userId}`, 'PATCH', { role: 'billing' }, 409)
  await api(`${path}/staff/${actor.userId}`, 'DELETE', undefined, 409)
  await api(`${path}/staff-invitations`, 'POST', { email, role: 'platform_owner' }, 400)
  const first = await api(`${path}/staff-invitations`, 'POST', { email, role: 'admin' })
  const firstToken = await invitationToken(first.id)
  await api('workspace-invitations/inspect', 'POST', { token: firstToken }, 404)
  const staff = await api(`${path}/staff`)
  assert.ok(!JSON.stringify(staff).includes(firstToken)); assert.ok(!JSON.stringify(staff).includes('token_hash'))
  await api(`${path}/staff-invitations/${first.id}`, 'DELETE')
  const second = await api(`${path}/staff-invitations`, 'POST', { email, role: 'admin' })
  await acceptWorkspaceInvitation(recipient, await invitationToken(second.id))
  await api(`${path}/staff/${userId}`, 'PATCH', { role: 'billing' })
  assert.equal((await api(`${path}/staff`)).members.find((member: any) => member.user_id === userId).role, 'billing')
  await api(`${path}/staff/${userId}`, 'DELETE')
  assert.ok(!(await api(`${path}/staff`)).members.some((member: any) => member.user_id === userId))
  const history = await api(`${path}/audit`)
  assert.ok(history.some((row: any) => row.action === 'workspace_member.removed' && row.target_name === 'Fictional HTTP staff'))

  const customer = await api(`${path}/organisations`, 'POST', { name: 'Temporary customer access check' })
  const customerPath = `organisations/${customer.id}`, memberPath = `${customerPath}/members/${actor.userId}`
  const directoryPath = `${customerPath}/directory`, importPath = `${directoryPath}/import`
  const contacts = { entries: readDirectoryCsv('name,number,label\nReception,+1 (202) 555-0101,Work\nReception,+12025550101,Work\nInvalid,sip:101@example.invalid,Work') }
  const directoryBefore = await api(directoryPath)
  const imported = await api(importPath,'POST',contacts)
  assert.deepEqual(imported.results.map((row: any)=>row.status),['imported','skipped','invalid'])
  const directoryAfter = await api(directoryPath)
  assert.equal(directoryAfter.contacts.length,1)
  assert.equal(directoryAfter.contacts[0].numbers[0].number,'+12025550101')
  assert.notEqual(directoryAfter.revision,directoryBefore.revision)
  assert.deepEqual((await api(importPath,'POST',contacts)).results.map((row: any)=>row.status),['skipped','skipped','invalid'])
  assert.equal((await api(directoryPath)).revision,directoryAfter.revision)
  await api(importPath,'POST',{entries:Array(101).fill(contacts.entries[0])},400)
  await api(`organisations/${randomUUID()}/directory/import`,'POST',contacts,404)
  const otherOrigin = new Headers(headers); otherOrigin.set('origin','https://untrusted.example')
  assert.equal((await fetch(`${base}/${importPath}`,{method:'POST',headers:otherOrigin,body:JSON.stringify(contacts)})).status,403)
  assert.equal((await fetch(`${base}/${importPath}`,{method:'POST',headers:{origin:config.SIPPER_BASE_URL,'content-type':'application/json'},body:JSON.stringify(contacts)})).status,401)
  assert.equal((await api(`${path}/audit`)).filter((row: any)=>row.action==='directory.imported').length,1)
  const callAccount=await api(`${customerPath}/configurations`,'POST',{label:'Fictional call end check',mode:'gateway',password:'fixture-only',settings:{username:'100',server:'sip.example.invalid',domain:'sip.example.invalid'}})
  const callId=randomUUID(), gatewayId=`http-end-${randomUUID()}`, endPath=`${customerPath}/calls/${callId}/end`
  await getPool().query("INSERT INTO gateway_calls (id,gateway_id,organisation_id,configuration_id,state,expires_at) VALUES ($1,$2,$3,$4,'answered',now()-interval '1 minute')",[callId,gatewayId,customer.id,callAccount.id])
  await api(endPath,'POST',{unexpected:true},400)
  await api(`organisations/${randomUUID()}/calls/${callId}/end`,'POST',{},404)
  assert.equal((await fetch(`${base}/${endPath}`,{method:'POST',headers:otherOrigin,body:'{}'})).status,403)
  assert.equal((await fetch(`${base}/${endPath}`,{method:'POST',headers:{origin:config.SIPPER_BASE_URL,'content-type':'application/json'},body:'{}'})).status,401)
  const end=await api(endPath,'POST',{})
  assert.equal((await api(endPath,'POST',{})).requestedAt,end.requestedAt)
  const call=(await api(`${customerPath}/calls`)).calls.find((value: any)=>value.id===callId)
  assert.equal(call.state,'answered'); assert.equal(call.end_requested_at,end.requestedAt); assert.equal(call.end_reason,null)
  const endAudit=(await api(`${path}/audit`)).filter((row: any)=>row.action==='gateway_call.end_requested')
  assert.equal(endAudit.length,1); assert.equal(endAudit[0].target_id,callId); assert.equal(endAudit[0].organisation_id,customer.id)
  assert.equal((await rows('SELECT actor_id FROM audit_events WHERE id=$1',[endAudit[0].id]))[0]!.actor_id,actor.userId)
  await gatewayCall(gatewayId,callId,{event:'ended',reason:'admin_ended'})
  await api(endPath,'POST',{},409)
  const customerInvite = await api(`${customerPath}/invitations`, 'POST', { email: actor.email, role: 'user' })
  const customerToken = await invitationToken(customerInvite.id, 'invitation')
  const customerReview = await api('invitations/inspect', 'POST', { token: customerToken })
  assert.equal(customerReview.organisationName, 'Temporary customer access check')
  assert.equal(customerReview.role, 'user'); assert.equal(customerReview.existingRole, null)
  assert.ok(!JSON.stringify(customerReview).includes(customerToken))
  assert.equal((await fetch(`${base}/invitations/inspect`, { method: 'POST', headers: { 'content-type': 'application/json', origin: config.SIPPER_BASE_URL }, body: JSON.stringify({ token: customerToken }) })).status, 401)
  await api('invitations/accept', 'POST', { token: customerToken })
  await api('invitations/inspect', 'POST', { token: customerToken }, 400)
  await api(`${memberPath}/role`, 'PATCH', { role: 'admin' })
  assert.equal((await api(customerPath)).members[0].role, 'admin')
  await api(memberPath, 'DELETE')
  await api(`${memberPath}/status`, 'PATCH', { status: 'active' }, 409)
  await api(`${memberPath}/role`, 'PATCH', { role: 'admin' }, 409)
  const removed = (await api(customerPath)).members[0]
  assert.equal(removed.status, 'removed'); assert.ok(removed.removed_at)
  // Removing calling membership leaves independently granted workspace administration.
  assert.equal((await api(`${path}/staff`)).canManage, true)
  const returnInvite = await api(`${customerPath}/invitations`, 'POST', { email: actor.email, role: 'user' })
  await api('invitations/accept', 'POST', { token: await invitationToken(returnInvite.id, 'invitation') })
  const rejoined = (await api(customerPath)).members[0]
  assert.equal(rejoined.status, 'active'); assert.equal(rejoined.role, 'user'); assert.equal(rejoined.removed_at, null)
  assert.ok((await api(`${path}/audit`)).some((row: any) => row.action === 'member.restored'))

  await api(`${path}/billing/test`, 'POST', { quantity: 2 })
  await api(`${path}/seats/${actor.userId}`, 'PUT', {})
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user')", [workspace.id, customer.id, recipient.userId])
  await api(`${path}/seats/${recipient.userId}`, 'PUT', {})
  const self = await enrolDevice(actor, customer.id, { installationId: randomUUID(), name: 'Self-service HTTP fixture', platform: 'macos', appVersion: 'test', osVersion: 'test' })
  const otherDevice = await enrolDevice(recipient, customer.id, { installationId: randomUUID(), name: 'Another person HTTP fixture', platform: 'windows', appVersion: 'test', osVersion: 'test' })
  const mine = await api('me/devices?q=Self-service%20HTTP%20fixture')
  assert.deepEqual(mine.devices.map((device: any) => device.id), [self.id])
  for (const key of ['installation_id', 'user_id', 'status', 'settings', 'secret_envelope']) assert.ok(!(key in mine.devices[0]))
  assert.equal((await fetch(`${base}/me/devices`)).status, 401)
  await api(`me/devices?after=${otherDevice.id}`, 'GET', undefined, 404)
  await api(`me/devices?userId=${recipient.userId}`, 'GET', undefined, 400)
  await api(`me/devices/${otherDevice.id}`, 'DELETE', undefined, 404)
  await api('me/devices/invalid-id', 'DELETE', undefined, 400)
  const foreignDeviceOrigin = new Headers(headers); foreignDeviceOrigin.set('origin', 'https://untrusted.example')
  assert.equal((await fetch(`${base}/me/devices/${self.id}`, { method: 'DELETE', headers: foreignDeviceOrigin })).status, 403)
  await Promise.all([api(`me/devices/${self.id}`, 'DELETE'), api(`me/devices/${self.id}`, 'DELETE')])
  const revoked = await api('me/devices?q=Self-service%20HTTP%20fixture&state=revoked')
  assert.equal(revoked.devices[0].id, self.id); assert.ok(revoked.devices[0].revoked_at)
  assert.equal((await api(`${path}/audit`)).filter((row: any) => row.action === 'device.signed_out' && row.target_id === self.id).length, 1)

  const other = await createWorkspace(recipient, { name: 'Temporary invitation HTTP check', kind: 'business' })
  workspaceIds.push(other.id)
  const invitation = await inviteWorkspaceStaff(recipient, other.id, { email: actor.email, role: 'billing' })
  const token = await invitationToken(invitation.id)
  const foreign = new Headers(headers); foreign.set('origin', 'https://untrusted.example')
  assert.equal((await fetch(`${base}/workspace-invitations/accept`, { method: 'POST', headers: foreign, body: JSON.stringify({ token }) })).status, 403)
  assert.equal((await api('workspace-invitations/inspect', 'POST', { token })).role, 'billing')
  assert.equal((await api('workspace-invitations/accept', 'POST', { token })).workspaceId, other.id)
  await api('workspace-invitations/accept', 'POST', { token }, 404)
  await api(`workspaces/${other.id}/staff`, 'GET', undefined, 404)
  assert.deepEqual((await api(`workspaces/${other.id}`)).permissions, { manageCustomers: false, viewStaff: false })
  console.log('Management HTTP checks passed: staff/customer access, contact imports, call end requests and retries, invitations, self-service devices, identity/origin boundaries, billing-only access and audit attribution.')
} finally {
  await getPool().query("DELETE FROM jobs WHERE deduplication_key IN (SELECT 'workspace-invitation:'||id FROM workspace_invitations WHERE workspace_id=ANY($1::uuid[]))", [workspaceIds])
  await getPool().query("DELETE FROM jobs WHERE deduplication_key IN (SELECT 'invitation:'||id FROM invitations WHERE workspace_id=ANY($1::uuid[]))", [workspaceIds])
  await getPool().query('DELETE FROM audit_events WHERE workspace_id=ANY($1::uuid[])', [workspaceIds])
  await getPool().query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await getPool().query('DELETE FROM auth_user WHERE id=$1', [userId])
  await browser.call('/sign-out')
  await getPool().end()
}
