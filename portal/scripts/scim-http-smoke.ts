import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { authRequests, totp } from '../tests/auth-helper'
import { getConfig } from '../server/lib/config'
import { getPool, rows } from '../server/lib/db'
import { SCIM } from '../server/lib/scim-protocol'

const config = getConfig()
if (config.NODE_ENV !== 'development' || !['localhost', '127.0.0.1'].includes(new URL(config.SIPPER_BASE_URL).hostname)) throw new Error('SCIM HTTP checks require local development')
const fixture = JSON.parse(await readFile('.data/browser-fixture.json', 'utf8'))
assert.match(fixture.email, /@example\.invalid$/)
const browser = authRequests(), workspaceIds: string[] = []
try {
  assert.equal((await browser.call('/sign-in/email', { email: fixture.email, password: fixture.password })).status, 200)
  assert.equal((await browser.call('/two-factor/verify-totp', { code: totp(fixture.totpSecret) })).status, 200)
  const headers = browser.headers(); headers.set('origin', config.SIPPER_BASE_URL); headers.set('content-type', 'application/json')
  async function api(path: string, method = 'GET', body?: unknown, expected = 200) {
    const response = await fetch(`${config.SIPPER_BASE_URL}/api/platform/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.status, expected, `${method} ${path}: ${response.status}`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return response.json() as Promise<any>
  }
  const workspace = await api('workspaces', 'POST', { name: 'Temporary SCIM HTTP check', kind: 'reseller' })
  workspaceIds.push(workspace.id)
  const customer = await api(`workspaces/${workspace.id}/organisations`, 'POST', { name: 'Fictional SCIM customer' })
  const management = `organisations/${customer.id}/provisioning`
  const settings = await api(management)
  assert.equal(settings.connection, null)
  assert.equal((await fetch(`${config.SIPPER_BASE_URL}/api/platform/${management}`)).status, 401)
  const wrongOrigin = new Headers(headers); wrongOrigin.set('origin', 'https://untrusted.example')
  assert.equal((await fetch(`${config.SIPPER_BASE_URL}/api/platform/${management}`, { method: 'POST', headers: wrongOrigin, body: '{}' })).status, 403)
  await api(management, 'POST', { role: 'admin' }, 400)
  let issued = await api(management, 'POST', {})
  const base = issued.baseURL
  assert.equal(base, `${config.SIPPER_BASE_URL}/api/scim/v2/${customer.id}`)
  const bearer = () => ({ authorization: `Bearer ${issued.token}`, 'content-type': 'application/scim+json' })
  async function scim(path: string, method = 'GET', body?: unknown, expected = 200, extra: Record<string, string> = {}) {
    const response = await fetch(`${base}/${path}`, { method, headers: { ...bearer(), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.status, expected, `${method} ${path}: ${response.status}`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    if (expected === 204) { assert.equal(await response.text(), ''); return { response, body: null } }
    assert.match(response.headers.get('content-type') ?? '', /^application\/scim\+json/)
    const result = await response.json() as any
    if (expected >= 400) { assert.deepEqual(result.schemas, [SCIM.Error]); assert.equal(result.status, String(expected)) }
    return { response, body: result }
  }
  const cookieOnly = await fetch(`${base}/Users`, { headers })
  assert.equal(cookieOnly.status, 401); assert.match(cookieOnly.headers.get('www-authenticate')!, /^Bearer /)
  assert.equal((await fetch(`${config.SIPPER_BASE_URL}/api/scim/v2/${randomUUID()}/Users`, { headers: bearer() })).status, 401)
  const malformed = await fetch(`${base}/Users`, { method: 'POST', headers: bearer(), body: '{' })
  assert.equal(malformed.status, 400); assert.equal((await malformed.json() as any).scimType, 'invalidSyntax')
  await scim('Users', 'POST', {}, 415, { 'content-type': 'text/plain' })
  const oversized = await fetch(`${base}/Users`, { method: 'POST', headers: bearer(), body: JSON.stringify({ text: 'x'.repeat(1024 * 1024) }) })
  assert.equal(oversized.status, 413); assert.deepEqual((await oversized.json() as any).schemas, [SCIM.Error])
  assert.equal((await scim('ServiceProviderConfig', 'GET', undefined, 200, { authorization: `bearer ${issued.token}` })).body.patch.supported, true)
  assert.equal((await scim(`Schemas/${encodeURIComponent(SCIM.User)}`)).body.id, SCIM.User)
  const created = await scim('Users', 'POST', { schemas: [SCIM.User], userName: `pending-${randomUUID()}@example.invalid`, displayName: 'Pending HTTP person', active: true }, 201, { 'content-type': 'application/SCIM+JSON; charset=utf-8' })
  const userPath = `Users/${created.body.id}`
  assert.equal(created.response.headers.get('location'), `${base}/${userPath}`)
  assert.equal(created.response.headers.get('etag'), created.body.meta.version)
  const group = await scim('Groups', 'POST', { schemas: [SCIM.Group], displayName: 'Provisioned HTTP group', members: [{ value: created.body.id }] }, 201)
  await api(`organisations/${customer.id}/groups/${group.body.id}/members`, 'PUT', { userIds: [] }, 409)
  await api(`organisations/${customer.id}/groups/${group.body.id}`, 'DELETE', undefined, 409)
  const changed = await scim(userPath, 'PATCH', { schemas: [SCIM.Patch], Operations: [{ op: 'replace', path: 'active', value: false }] }, 200, { 'if-match': created.body.meta.version })
  assert.equal(changed.body.active, false)
  await scim(userPath, 'PUT', created.body, 412, { 'if-match': created.body.meta.version })
  const bound = await scim('Users', 'POST', { schemas: [SCIM.User], userName: fixture.email, displayName: 'Existing verified HTTP person' }, 201)
  const customerDetails = await api(`organisations/${customer.id}`)
  assert.equal(customerDetails.members[0].role, 'user'); assert.equal(customerDetails.members[0].licensed, false)
  assert.equal(customerDetails.members[0].scim_user_id, bound.body.id)
  assert.equal(customerDetails.groups[0].scim_managed, true)
  const list = await api(`${management}/users`)
  assert.equal(list.users.length, 2); assert.ok(!JSON.stringify(list).includes(issued.token))
  await scim(`Groups/${group.body.id}`, 'DELETE', undefined, 204)
  await scim(userPath, 'DELETE', undefined, 204)
  await scim(userPath, 'GET', undefined, 404)
  const oldHeaders = bearer()
  issued = await api(management, 'POST', {})
  assert.equal((await fetch(`${base}/Users`, { headers: oldHeaders })).status, 401)
  await getPool().query('UPDATE scim_connections SET request_count=600,request_window_at=now() WHERE organisation_id=$1', [customer.id])
  const limited = await scim('Users', 'GET', undefined, 429)
  assert.equal(limited.response.headers.get('retry-after'), '60')
  await api(management, 'DELETE')
  await scim('Users', 'GET', undefined, 401)
  assert.equal((await api(management)).connection.enabled, false)
  assert.equal((await rows('SELECT status FROM organisation_members WHERE organisation_id=$1', [customer.id]))[0]!.status, 'active')
  const audit = await api(`workspaces/${workspace.id}/audit`)
  assert.ok(audit.some((entry: any) => entry.action === 'scim.user_created' && entry.actor_name === 'SCIM provisioning'))
  assert.ok(!JSON.stringify(audit).includes(issued.token))
  console.log('SCIM HTTP checks passed: scoped tokens, cookie/origin denial, bounded JSON, CRUD, versions, managed groups, user-only membership, rotation, rate limiting, revocation and redacted audit.')
} finally {
  await getPool().query('DELETE FROM audit_events WHERE workspace_id=ANY($1::uuid[])', [workspaceIds])
  await getPool().query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await browser.call('/sign-out')
  await getPool().end()
}
