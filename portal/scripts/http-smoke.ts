import { readFile } from 'node:fs/promises'
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import assert from 'node:assert/strict'
import { authRequests, totp } from '../tests/auth-helper'
import { getConfig } from '../server/lib/config'
import { getPool, rows } from '../server/lib/db'
import { sessionPrincipal } from '../server/lib/http'
import { createWorkspace, createOrganisation, createConfiguration, assignConfiguration, assignSeat } from '../server/lib/platform'
import { configureTestBilling } from '../server/lib/billing'
import { deleteDirectoryContact } from '../server/lib/directory'

const c = getConfig()
if (c.NODE_ENV !== 'development' || !['localhost','127.0.0.1'].includes(new URL(c.SIPPER_BASE_URL).hostname) || c.SIPPER_ALLOW_TEST_BILLING !== 'true') throw new Error('HTTP smoke tests require local development with test billing enabled')
const fixture = JSON.parse(await readFile('.data/browser-fixture.json', 'utf8'))
const browser = authRequests()
assert.equal((await browser.call('/sign-in/email', { email: fixture.email, password: fixture.password })).status, 200)
assert.equal((await browser.call('/two-factor/verify-totp', { code: totp(fixture.totpSecret) })).status, 200)
const headers = browser.headers(); headers.set('origin', c.SIPPER_BASE_URL); headers.set('content-type', 'application/json')
const actor = await sessionPrincipal(headers)
const base = `${c.SIPPER_BASE_URL}/api/platform`
assert.equal((await fetch(`${base}/overview`, { headers })).status, 200)
assert.equal((await fetch(`${base}/workspaces/00000000-0000-4000-8000-000000000001`, { headers })).status, 404)
const foreign = new Headers(headers); foreign.set('origin', 'https://untrusted.example')
assert.equal((await fetch(`${base}/workspaces`, { method: 'POST', headers: foreign, body: JSON.stringify({ name: 'Must not create', kind: 'business' }) })).status, 403)
assert.equal((await fetch(`${base}/workspaces`, { method: 'POST', headers, body: JSON.stringify({ name: '', kind: 'business' }) })).status, 400)
assert.equal((await fetch(`${base}/workspaces`, { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(70000), kind: 'business' }) })).status, 413)
// A sender that exceeds the limit and then stalls must still receive the rejection.
const oversized = await new Promise<number | undefined>((resolve, reject) => {
  const req = request(`${base}/workspaces`, { method: 'POST', headers: Object.fromEntries(headers) }, response => {
    response.resume()
    response.once('end', () => resolve(response.statusCode))
    response.once('error', reject)
  })
  req.setTimeout(5000, () => req.destroy(new Error('Oversized upload was not rejected promptly')))
  req.once('error', reject)
  req.write(Buffer.alloc(70000, 'x')) // Intentionally do not finish the request body.
})
assert.equal(oversized, 413)

const workspace = (await rows(`SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at LIMIT 1`, [actor.userId]))[0]
  ?? await createWorkspace(actor, { name: 'Local HTTP demo', kind: 'reseller' })
const organisation = (await rows('SELECT id FROM organisations WHERE workspace_id=$1 ORDER BY created_at LIMIT 1', [workspace.id]))[0]
  ?? await createOrganisation(actor, workspace.id, { name: 'Example customer · Local demo' })
await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role) VALUES ($1,$2,$3,'user') ON CONFLICT DO NOTHING", [workspace.id, organisation.id, actor.userId])
await configureTestBilling(actor, workspace.id, { quantity: 3 })
await assignSeat(actor, workspace.id, actor.userId)
const account = (await rows("SELECT id FROM sip_configurations WHERE organisation_id=$1 AND label='Example extension · Local test'", [organisation.id]))[0]
  ?? await createConfiguration(actor, organisation.id, { label: 'Example extension · Local test', mode: 'direct', settings: { username: '100', domain: 'pbx.example.invalid', server: 'sip.example.invalid' }, password: 'fictional-SIP-fixture' })
await assignConfiguration(actor, organisation.id, account.id, actor.userId)

const verifier = randomBytes(32).toString('base64url'), resource = `${c.SIPPER_BASE_URL}/api/client`
const params = new URLSearchParams({ client_id: 'sipper-macos', response_type: 'code', redirect_uri: 'com.hybes.sipper:/oauth/callback', scope: 'openid email profile offline_access sipper:client', resource, state: randomUUID(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
const authorised = await browser.call(`/oauth2/authorize?${params}`)
let redirect = new URL(authorised.location ?? authorised.data.url, c.SIPPER_BASE_URL)
if (redirect.pathname === '/portal/consent') {
  const consent = await browser.call('/oauth2/consent', { accept: true, oauth_query: redirect.search.slice(1) })
  assert.equal(consent.status, 200); redirect = new URL(consent.data.url)
}
assert.ok(redirect.searchParams.get('code'))
// AppAuth's default code exchange does not repeat the resource from the authorisation request.
const tokenResponse = await fetch(`${c.SIPPER_BASE_URL}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'sipper-macos', grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, code_verifier: verifier, redirect_uri: 'com.hybes.sipper:/oauth/callback' }) })
const tokens = await tokenResponse.json() as any
assert.equal(tokenResponse.status, 200, `Token exchange failed: ${tokens.error ?? tokens.code} / ${tokens.error_description ?? tokens.message}`)
assert.ok(typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 20, 'Native sign-in must issue a refresh token')
const clientHeaders = { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }
const setupResponse = await fetch(`${base}/organisations/${organisation.id}/members/${actor.userId}/setup-link`, { method: 'POST', headers, body: '{}' })
assert.equal(setupResponse.status, 200)
const setup = await setupResponse.json() as { url: string }
const setupURL = new URL(setup.url)
assert.equal(setupURL.search, '')
const setupBody = JSON.stringify({ reference: setupURL.hash.slice(5) })
assert.equal((await fetch(`${resource}/setup-links/redeem`, { method: 'POST', headers, body: setupBody })).status, 401)
const redeemed = await fetch(`${resource}/setup-links/redeem`, { method: 'POST', headers: clientHeaders, body: setupBody })
assert.equal(redeemed.status, 200)
const selected = await redeemed.json() as any
assert.equal(selected.userId, actor.userId)
assert.equal(selected.organisation.id, organisation.id)
assert.equal((await fetch(`${resource}/setup-links/redeem`, { method: 'POST', headers: clientHeaders, body: setupBody })).status, 404)
assert.equal((await fetch(`${resource}/organisations`, { headers: clientHeaders })).status, 200)
assert.equal((await fetch(`${base}/overview`, { headers: clientHeaders })).status, 401)
// Reuse this synthetic installation so repeated checks do not fill the preview with duplicates.
const installationId = (await rows("SELECT installation_id FROM devices WHERE organisation_id=$1 AND user_id=$2 AND name='Simulated Mac · HTTP test' AND revoked_at IS NULL ORDER BY enrolled_at LIMIT 1", [organisation.id, actor.userId]))[0]?.installation_id ?? randomUUID()
const enrol = await fetch(`${resource}/organisations/${organisation.id}/devices`, { method: 'POST', headers: clientHeaders, body: JSON.stringify({ installationId, name: 'Simulated Mac · HTTP test', platform: 'macos', appVersion: 'test-fixture', osVersion: 'test-fixture' }) })
const device = await enrol.json() as any
assert.equal(enrol.status, 200, `Enrolment failed: ${device.code ?? 'unknown'}`)
const provision = await fetch(`${resource}/devices/${device.id}/configuration`, { headers: clientHeaders })
assert.equal(provision.status, 200)
assert.equal(provision.headers.get('cache-control'), 'no-store')
const config = await provision.json() as any
assert.ok(config.accounts.some((a: any) => a.id === account.id && a.password === 'fictional-SIP-fixture'))
const directoryURL=`${base}/organisations/${organisation.id}/directory`, directoryName=`Directory HTTP fixture ${randomUUID()}`
const addedContact=await fetch(directoryURL,{method:'POST',headers,body:JSON.stringify({name:directoryName,company:'Fictional directory',numbers:[{label:'Work',number:'+1 (202) 555-0101'}]})})
assert.equal(addedContact.status,200)
const sharedContact=await addedContact.json() as any
try {
  const nativeDirectory=`${resource}/devices/${device.id}/directory`
  assert.equal((await fetch(nativeDirectory,{headers})).status,401,'Browser sessions must not authorise native directory access')
  assert.equal((await fetch(directoryURL,{headers:clientHeaders})).status,401,'Native access must not authorise directory administration')
  const snapshot=await fetch(`${nativeDirectory}?q=${encodeURIComponent(directoryName)}`,{headers:clientHeaders})
  assert.equal(snapshot.status,200); assert.equal(snapshot.headers.get('cache-control'),'no-store')
  const directory=await snapshot.json() as any
  assert.equal(directory.deviceId,device.id); assert.equal(directory.organisation.id,organisation.id)
  assert.equal(directory.contacts.length,1); assert.equal(directory.contacts[0].numbers[0].number,'+12025550101')
  const changed=await fetch(`${directoryURL}/${sharedContact.id}`,{method:'PATCH',headers,body:JSON.stringify({name:directoryName,company:'Updated fictional directory',numbers:[{label:'Extension',number:'101'}],revision:1})})
  assert.equal(changed.status,200)
  assert.equal((await fetch(`${nativeDirectory}?revision=${directory.revision}`,{headers:clientHeaders})).status,409)
  assert.equal((await fetch(`${directoryURL}/${sharedContact.id}?revision=1`,{method:'DELETE',headers})).status,409)
  assert.equal((await fetch(`${directoryURL}/${sharedContact.id}?revision=2`,{method:'DELETE',headers})).status,200)
  console.log('PASS: authenticated directory CRUD, native scope separation, revision conflicts and non-cached device pages')
} finally {
  const remaining=(await rows('SELECT revision FROM directory_contacts WHERE id=$1 AND organisation_id=$2',[sharedContact.id,organisation.id]))[0]
  if(remaining) await deleteDirectoryContact(actor,organisation.id,sharedContact.id,remaining.revision)
}
const directCalls = config.accounts.filter((a: any) => a.mode === 'direct').map((a: any) => ({ accountId: a.id, ringing: 0, dialling: 0, connected: 0, held: 0 }))
const reportURL = `${resource}/devices/${device.id}/report`
assert.equal((await fetch(reportURL, { method: 'POST', headers, body: JSON.stringify({ appliedRevision: config.revision, directCalls }) })).status, 401)
assert.equal((await fetch(reportURL, { method: 'POST', headers: clientHeaders, body: JSON.stringify({ directCalls }) })).status, 400)
assert.equal((await fetch(reportURL, { method: 'POST', headers: clientHeaders, body: JSON.stringify({ appliedRevision: config.revision, directCalls: directCalls.map((a: any) => ({ ...a, remoteNumber: 'private-caller' })) }) })).status, 400)
const report = await fetch(`${resource}/devices/${device.id}/report`, { method: 'POST', headers: clientHeaders, body: JSON.stringify({ appliedRevision: config.revision, registrations: [{ accountId: account.id, state: 'unknown' }], directCalls }) })
assert.equal(report.status, 200)
const detailsResponse = await fetch(`${base}/organisations/${organisation.id}`, { headers })
assert.equal(detailsResponse.status, 200)
const details = await detailsResponse.json() as any
const activity = details.devices.find((d: any) => d.id === device.id)
assert.ok(activity)
if (process.argv.includes('--dev-proxy')) {
  // Nuxt's development worker uses a Unix socket with no verifiable network peer.
  assert.equal(activity.last_request_ip, null)
} else {
  assert.ok(['127.0.0.1', '::1'].includes(activity.last_request_ip))
}
assert.equal(activity.last_login_at, new Date(actor.sessionCreatedAt!).toISOString())
assert.equal(activity.last_request_action, 'report')
for (const field of ['last_request_at', 'last_configuration_at', 'last_report_at']) {
  assert.ok(Date.now() - new Date(activity[field]).getTime() < 60_000, `${field} must reflect the actual HTTP request`)
}
assert.equal(activity.applied_revision, config.revision)
assert.equal(activity.status.registrations[0].source, 'device')
assert.equal(activity.status.registrations[0].state, 'unknown')
assert.ok(activity.status.registrations[0].observedAt)
assert.deepEqual(activity.status.directCalls.accounts, directCalls)
assert.equal(activity.status.directCalls.source, 'device')
assert.ok(Date.now() - Date.parse(activity.status.directCalls.observedAt) < 5000)
assert.equal(report.headers.get('cache-control'), 'no-store')
assert.ok(!JSON.stringify(details).includes('private-caller'))
assert.equal(activity.status.directCalls.confirmed, true)
const unconfirmed = await fetch(reportURL, { method: 'POST', headers: clientHeaders, body: JSON.stringify({ registrations: [] }) })
assert.equal(unconfirmed.status, 200)
const changedActivity = await (await fetch(`${base}/organisations/${organisation.id}`, { headers })).json() as any
assert.equal(changedActivity.devices.find((d: any) => d.id === device.id).status.directCalls.confirmed, false)
assert.equal((await fetch(reportURL, { method: 'POST', headers: clientHeaders, body: JSON.stringify({ appliedRevision: config.revision, directCalls }) })).status, 200)

assert.equal(details.members.find((m: any) => m.user_id === actor.userId).last_request_ip, activity.last_request_ip)
assert.ok(!JSON.stringify(details).includes('fictional-SIP-fixture'), 'The admin response must not include SIP passwords')
const refreshBody = new URLSearchParams({ client_id: 'sipper-macos', grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource })
const renewed = await fetch(`${c.SIPPER_BASE_URL}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: refreshBody })
assert.equal(renewed.status, 200, 'Native refresh must retain the client API audience')
const renewedTokens = await renewed.json() as any
// A refresh response can omit this field when the existing token remains current.
const currentRefreshToken = renewedTokens.refresh_token ?? tokens.refresh_token
assert.ok(typeof currentRefreshToken === 'string' && currentRefreshToken.length > 20, 'Native refresh must retain usable refresh credentials')
assert.equal((await fetch(`${resource}/organisations`, { headers: { authorization: `Bearer ${renewedTokens.access_token}` } })).status, 200)
const revoked = await fetch(`${c.SIPPER_BASE_URL}/api/auth/oauth2/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'sipper-macos', token: currentRefreshToken, token_type_hint: 'refresh_token' }) })
if (revoked.status !== 200) {
  const failure = await revoked.json() as any
  assert.fail(`Native revocation failed (${revoked.status}, ${failure.error ?? failure.code ?? 'unknown'})`)
}
refreshBody.set('refresh_token', currentRefreshToken)
const afterRevoke = await fetch(`${c.SIPPER_BASE_URL}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: refreshBody })
assert.equal(afterRevoke.status, 400, 'Signed-out native credentials must not refresh')
assert.equal((await afterRevoke.json() as any).error, 'invalid_grant')
console.log('HTTP checks passed: portal isolation, origin/body limits, AppAuth-style native PKCE, refresh/revocation, bearer scope separation, single-use setup redemption, encrypted provisioning, status acknowledgement and server-observed login/request/IP activity.')
console.log(`Dummy customer: ${c.SIPPER_BASE_URL}/portal/organisations/${organisation.id}`)
await getPool().end()
