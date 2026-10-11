import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { getAuth } from '../server/lib/auth'
import { getPool } from '../server/lib/db'
import { seedNativeClients, nativePrincipal, clientResource } from '../server/lib/native-auth'
import { createVerifiedLocalUser } from './auth-helper'

let server: Server, origin: string, fixture: Awaited<ReturnType<typeof createVerifiedLocalUser>>
before(async () => {
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const response = await getAuth().handler(new Request(`${origin}${req.url}`, { method: req.method,
        headers: req.headers as Record<string, string>, ...(['GET','HEAD'].includes(req.method!) ? {} : { body: Buffer.concat(chunks) }) }))
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(500); res.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.SIPPER_BASE_URL = origin
  await seedNativeClients()
  fixture = await createVerifiedLocalUser('Native fixture')
})
after(async () => {
  if (fixture) await getPool().query('DELETE FROM auth_user WHERE id=$1', [fixture.userId])
  if (origin) await getPool().query('DELETE FROM "oauthResource" WHERE identifier=$1', [`${origin}/api/client`])
  await getPool().end()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
})
async function authorise(verifier: string, overrides: Record<string, string> = {}) {
  const query = new URLSearchParams({ client_id: 'sipper-macos', response_type: 'code', redirect_uri: 'com.hybes.sipper:/oauth/callback',
    scope: 'openid email offline_access sipper:client', resource: clientResource(), state: 'fixture-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...overrides })
  const response = await fixture.client.call(`/oauth2/authorize?${query}`)
  const redirect = response.location ?? response.data?.url
  if (!redirect) throw new Error(`Authorisation did not redirect (${response.status})`)
  return { response, redirect: new URL(redirect, origin) }
}
async function consent(verifier: string) {
  const authorised = await authorise(verifier)
  if (authorised.redirect.protocol === 'com.hybes.sipper:' && authorised.redirect.searchParams.has('code')) return authorised.redirect.searchParams.get('code')!
  assert.equal(authorised.redirect.pathname, '/portal/consent', `OAuth result: ${authorised.redirect.searchParams.get('error')} / ${authorised.redirect.searchParams.get('error_description')}`)
  const response = await fixture.client.call('/oauth2/consent', { accept: true, oauth_query: authorised.redirect.search.slice(1) })
  assert.equal(response.status, 200)
  const callback = new URL(response.data.url)
  assert.equal(callback.searchParams.get('state'), 'fixture-state')
  assert.equal(callback.protocol, 'com.hybes.sipper:')
  return callback.searchParams.get('code')!
}
async function exchange(body: Record<string, string>) {
  const response = await getAuth().handler(new Request(`${origin}/api/auth/oauth2/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'sipper-macos', ...body }) }))
  return { status: response.status, data: await response.json() as any }
}
test('native clients require PKCE, issue scoped tokens and lose access when their session is revoked', async () => {
  const verifier = randomBytes(32).toString('base64url')
  const code = await consent(verifier)
  const tokens = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'com.hybes.sipper:/oauth/callback', resource: clientResource() })
  assert.equal(tokens.status, 200)
  assert.ok(tokens.data.refresh_token)
  const request = () => new Request(`${origin}/api/client/organisations`, { headers: { authorization: `Bearer ${tokens.data.access_token}` } })
  const identity = await nativePrincipal(request())
  assert.equal(identity.userId, fixture.userId)
  assert.equal(identity.mfa, false)
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.data.refresh_token, resource: clientResource() })
  assert.equal(refreshed.status, 200)
  await fixture.client.call('/sign-out', {})
  await assert.rejects(nativePrincipal(request()), (e: any) => e.code === 'invalid_access_token')
  assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: refreshed.data.refresh_token })).status, 400)
  assert.equal((await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'com.hybes.sipper:/oauth/callback' })).status, 400)
})
test('a forged bearer token and browser cookie alone cannot authenticate native APIs', async () => {
  await assert.rejects(nativePrincipal(new Request(`${origin}/api/client/organisations`, { headers: { authorization: 'Bearer forged.token.value' } })), (e: any) => e.code === 'invalid_access_token')
  await assert.rejects(nativePrincipal(new Request(`${origin}/api/client/organisations`, { headers: fixture.client.headers() })), (e: any) => e.code === 'invalid_access_token')
})
test('wrong PKCE verifiers, unregistered redirects and scope escalation are refused', async () => {
  assert.equal((await fixture.client.call('/sign-in/email', { email: fixture.email, password: fixture.password })).status, 200)
  const verifier = randomBytes(32).toString('base64url')
  const code = await consent(verifier)
  const wrong = await exchange({ grant_type: 'authorization_code', code, code_verifier: randomBytes(32).toString('base64url'), redirect_uri: 'com.hybes.sipper:/oauth/callback' })
  assert.ok([400, 401].includes(wrong.status))
  assert.equal(wrong.data.access_token, undefined)
  const invalid = await authorise(verifier, { scope: 'openid sipper:admin' })
  assert.equal(invalid.redirect.searchParams.get('error'), 'invalid_scope')
  const request = new URLSearchParams({ client_id: 'sipper-macos', response_type: 'code', redirect_uri: 'https://untrusted.example/capture', scope: 'openid', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
  const response = await fixture.client.call(`/oauth2/authorize?${request}`)
  assert.ok(response.status >= 400 || !String(response.location ?? response.data?.url).startsWith('https://untrusted.example'))
})
