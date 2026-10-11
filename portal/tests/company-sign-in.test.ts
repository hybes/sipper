import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { getPool, rows, transaction } from '../server/lib/db'
import { getAuth } from '../server/lib/auth'
import { sessionPrincipal } from '../server/lib/http'
import { seedNativeClients } from '../server/lib/native-auth'
import { createWorkspace, createOrganisation, overview } from '../server/lib/platform'
import { companySignIn, saveCompanySignIn, setCompanySignInEnabled, verifyCompanyDomain, readCompanyOidcConfig } from '../server/lib/company-sign-in'
import { authRequests, createVerifiedLocalUser, totp } from './auth-helper'
import type { Principal } from '../server/lib/access'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'local-idp', alg: 'RS256', use: 'sig' }
const codes = new Map<string, { challenge: string; claims: Record<string, unknown> }>()
let origin: string, issuer: string, organisation: string, workspace: string, provider: any, admin: Principal
let fixture: Awaited<ReturnType<typeof createVerifiedLocalUser>>
const userIds: string[] = []
const secret = 'fictional-company-client-secret'
let acceptedSecret = secret
function jwt(claims: Record<string, unknown>) {
  const payload = [ { alg: 'RS256', kid: jwk.kid, typ: 'JWT' }, { iss: issuer, aud: 'company-client', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, ...claims } ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`
}
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/idp/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] }))
  if (req.url === '/idp/jwks') return res.end(JSON.stringify({ keys: [jwk] }))
  if (req.url === '/idp/token') {
    let body = ''; for await (const part of req) body += part
    const form = new URLSearchParams(body), code = form.get('code') ?? '', entry = codes.get(code)
    codes.delete(code)
    if (!entry || req.headers.authorization !== `Basic ${Buffer.from(`company-client:${acceptedSecret}`).toString('base64')}` || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== entry.challenge) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })) }
    return res.end(JSON.stringify({ access_token: 'fictional-idp-access-token', refresh_token: 'fictional-idp-refresh-token', token_type: 'Bearer', expires_in: 300, id_token: jwt(entry.claims) }))
  }
  res.statusCode = 404; res.end('{}')
})
before(async () => {
  assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.SIPPER_BASE_URL = origin
  issuer = `${origin}/idp`
  fixture = await createVerifiedLocalUser('Company sign-in operator'); userIds.push(fixture.userId)
  await seedNativeClients()
  const enabled = await fixture.client.call('/two-factor/enable', { password: fixture.password })
  assert.equal(enabled.status, 200)
  const key = new URL(enabled.data.totpURI).searchParams.get('secret')!
  assert.equal((await fixture.client.call('/two-factor/verify-totp', { code: totp(key) })).status, 200)
  admin = await sessionPrincipal(fixture.client.headers())
  workspace = (await createWorkspace(admin, { name: 'Company sign-in fixture', kind: 'business' })).id
  organisation = (await createOrganisation(admin, workspace, { name: 'Company fixture' })).id
})
after(async () => {
  if (workspace) await getPool().query('DELETE FROM workspaces WHERE id=$1', [workspace])
  await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [userIds])
  const context = await getAuth().$context
  await context.adapter.deleteMany({ model: 'oauthClientResource', where: [{ field: 'resourceId', value: `${origin}/api/client` }] })
  await context.adapter.deleteMany({ model: 'oauthResource', where: [{ field: 'identifier', value: `${origin}/api/client` }] })
  await getPool().end()
  await new Promise<void>(resolve => server.close(() => resolve()))
})
const settings = () => ({ domain: 'example.invalid', issuer, clientId: 'company-client', clientSecret: secret })
async function start(client: ReturnType<typeof authRequests>, email: string, callbackURL = `${origin}/portal`) {
  const result = await client.call('/sign-in/sso', { email, callbackURL })
  assert.equal(result.status, 200, result.data?.message)
  const url = new URL(result.data.url)
  assert.equal(url.origin, origin); assert.equal(url.pathname, '/idp/authorize')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  return url
}
async function complete(client: ReturnType<typeof authRequests>, url: URL, claims: Record<string, unknown>) {
  const code = randomUUID()
  codes.set(code, { challenge: url.searchParams.get('code_challenge')!, claims })
  return client.call(`/sso/callback/sipper-${provider.id}?${new URLSearchParams({ code, state: url.searchParams.get('state')! })}`)
}
test('customer-bound configuration is encrypted, DNS-gated, audited and inaccessible through library CRUD', async t => {
  await assert.rejects(saveCompanySignIn({ ...admin, mfa: false }, organisation, settings()), (e: any) => e.code === 'mfa_required')
  await assert.rejects(saveCompanySignIn({ ...admin, userId: randomUUID() }, organisation, settings()), (e: any) => e.code === 'not_found')
  provider = (await saveCompanySignIn(admin, organisation, settings())).provider
  assert.ok(provider); assert.equal(provider.enabled, false); assert.equal(provider.verifiedAt, null)
  const stored = (await rows('SELECT p.oidc_config,c.envelope FROM auth_sso_provider p JOIN sso_configurations c ON c.id=p.oidc_config WHERE p.id=$1', [provider.id]))[0]!
  assert.ok(!JSON.stringify(stored).includes(secret))
  assert.ok(!JSON.stringify(await companySignIn(admin, organisation)).includes(secret))
  assert.equal(JSON.parse(await readCompanyOidcConfig(stored.oidc_config)).clientSecret, secret)
  assert.equal((await authRequests().call('/sign-in/sso', { email: fixture.email, callbackURL: '/portal' })).status, 404)
  await assert.rejects(setCompanySignInEnabled(admin, organisation, { enabled: true }), (e: any) => e.code === 'sso_domain_unverified')
  t.mock.method(Resolver.prototype, 'resolveTxt', async () => [['wrong-token']])
  await assert.rejects(verifyCompanyDomain(admin, organisation), (e: any) => e.code === 'sso_dns_pending')
  t.mock.restoreAll()
  t.mock.method(Resolver.prototype, 'resolveTxt', async (name: string) => { assert.equal(name, provider.verification.name); return [[provider.verification.value.slice(0,12),provider.verification.value.slice(12)]] })
  provider = (await verifyCompanyDomain(admin, organisation)).provider
  assert.ok(provider.verifiedAt)
  provider = (await setCompanySignInEnabled(admin, organisation, { enabled: true })).provider
  assert.equal(provider.enabled, true)
  for (const path of ['/sso/register','/sso/update-provider','/sso/delete-provider','/sso/verify-domain']) assert.equal((await fixture.client.call(path, {})).status, 404)
  for (const path of ['/sso/providers','/sso/get-provider']) assert.equal((await fixture.client.call(path)).status, 404)
  assert.deepEqual((await rows("SELECT action FROM audit_events WHERE organisation_id=$1 AND action LIKE 'company_sign_in.%' ORDER BY created_at",[organisation])).map(row => row.action), ['company_sign_in.created','company_sign_in.domain_verified','company_sign_in.enabled'])
})
test('signed OIDC identity cannot grant roles or licences, retain provider tokens, or accept a foreign domain', async () => {
  const client = authRequests(), email = `company-${randomUUID()}@example.invalid`, subject = randomUUID()
  const result = await complete(client, await start(client,email), { sub: subject, email, name: 'Company user', roles: ['admin'] })
  assert.equal(result.status, 302, result.location ?? '')
  const actor = await sessionPrincipal(client.headers()); userIds.push(actor.userId)
  assert.equal(actor.email,email); assert.equal(actor.verified,true); assert.equal(actor.mfa,false)
  const account = (await rows('SELECT * FROM auth_account WHERE "userId"=$1',[actor.userId]))[0]!
  assert.equal(account.accountId,subject); assert.equal(account.accessToken,null); assert.equal(account.refreshToken,null); assert.equal(account.idToken,null)
  const access = await overview(actor)
  assert.equal(access.organisations.length,0); assert.equal(access.workspaces.length,0); assert.equal(access.platformOwner,false)
  assert.equal((await rows('SELECT * FROM seat_assignments WHERE user_id=$1',[actor.userId])).length,0)
  const setup = await client.call('/two-factor/enable',{})
  assert.equal(setup.status,200,'Company-only identities must be able to enrol MFA without a Sipper password')
  assert.equal((await sessionPrincipal(client.headers())).mfa,false)
  const authenticatorKey = new URL(setup.data.totpURI).searchParams.get('secret')!
  assert.equal((await client.call('/two-factor/verify-totp',{code:totp(authenticatorKey)})).status,200)
  assert.equal((await sessionPrincipal(client.headers())).mfa,true)
  const foreign = authRequests()
  const denied = await complete(foreign,await start(foreign,email),{ sub: randomUUID(),email:'owner@foreign.example',name:'Wrong domain' })
  assert.equal(denied.status,302); assert.match(denied.location!,/company_sign_in_unavailable/)
  await assert.rejects(sessionPrincipal(foreign.headers()),(e: any)=>e.code==='sign_in_required')
  const expired = authRequests()
  const badToken = await complete(expired,await start(expired,email),{sub:subject,email,name:'Expired',exp:1})
  assert.match(badToken.location!,/token_not_verified/)
  await assert.rejects(sessionPrincipal(expired.headers()),(e: any)=>e.code==='sign_in_required')
  const wrongAudience = authRequests()
  const rejectedAudience = await complete(wrongAudience,await start(wrongAudience,email),{sub:subject,email,name:'Wrong audience',aud:'another-application'})
  assert.match(rejectedAudience.location!,/token_not_verified/)
  await assert.rejects(sessionPrincipal(wrongAudience.headers()),(e: any)=>e.code==='sign_in_required')
  const replacement = authRequests()
  const reassigned = await complete(replacement,await start(replacement,email),{sub:randomUUID(),email,name:'Different subject'})
  assert.match(reassigned.location!,/company_sign_in_unavailable/)
  await assert.rejects(sessionPrincipal(replacement.headers()),(e: any)=>e.code==='sign_in_required')
})
test('existing administrators must finish Sipper MFA after company sign-in; challenge codes cannot be replayed', async () => {
  const client = authRequests()
  const signedIn = await complete(client, await start(client,fixture.email), { sub: randomUUID(), email: fixture.email, name: 'Untrusted replacement name' })
  assert.equal(signedIn.status,302)
  const redirect = new URL(signedIn.location!)
  assert.equal(redirect.pathname,'/portal/sign-in'); assert.equal(redirect.searchParams.get('challenge'),'company')
  await assert.rejects(sessionPrincipal(client.headers()), (e: any) => e.code === 'sign_in_required')
  const twoFactor = (await rows('SELECT secret FROM "twoFactor" WHERE "userId"=$1',[fixture.userId]))[0]
  assert.ok(twoFactor)
  // Use the library's existing authenticated setup URI to generate the local OTP.
  const uri = await fixture.client.call('/two-factor/get-totp-uri', { password: fixture.password })
  const key = new URL(uri.data.totpURI).searchParams.get('secret')!
  const pendingHeaders = client.headers(); pendingHeaders.set('origin',origin); pendingHeaders.set('content-type','application/json')
  assert.equal((await client.call('/two-factor/verify-totp',{code:totp(key)})).status,200)
  assert.equal((await getAuth().handler(new Request(`${origin}/api/auth/two-factor/verify-totp`,{method:'POST',headers:pendingHeaders,body:JSON.stringify({code:totp(key)})}))).status,401)
  const actor = await sessionPrincipal(client.headers())
  assert.equal(actor.userId,fixture.userId); assert.equal(actor.mfa,true)
  assert.equal((await rows('SELECT name FROM auth_user WHERE id=$1',[actor.userId]))[0]!.name,'Company sign-in operator')
})
test('native PKCE consent resumes after company sign-in with and without MFA, including a fresh-login request', async () => {
  for (const mfa of [false,true]) {
    const client = authRequests(), verifier = randomBytes(32).toString('base64url'), state = randomUUID()
    const native = new URLSearchParams({client_id:'sipper-macos',response_type:'code',redirect_uri:'com.hybes.sipper:/oauth/callback',scope:'openid email profile offline_access sipper:client',resource:`${origin}/api/client`,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'login',max_age:'0'})
    const authorise = await client.call(`/oauth2/authorize?${native}`)
    const login = new URL(authorise.location ?? authorise.data.url,origin), signedQuery = login.search.slice(1)
    assert.equal(login.pathname,'/portal/sign-in',`${login.searchParams.get('error')}: ${login.searchParams.get('error_description')}`); assert.ok(login.searchParams.get('sig'))
    const email = mfa ? fixture.email : `native-${randomUUID()}@example.invalid`
    const subject = mfa ? (await rows('SELECT "accountId" FROM auth_account WHERE "userId"=$1 AND "providerId"=$2',[fixture.userId,`sipper-${provider.id}`]))[0]!.accountId : randomUUID()
    const start = await client.call('/sign-in/sso',{email,callbackURL:`${origin}/portal/company-callback?flow=${randomUUID()}`,oauth_query:signedQuery})
    assert.equal(start.status,200,start.data?.message)
    let result = await complete(client,new URL(start.data.url),{sub:subject,email,name:'Native company user'})
    if (mfa) {
      const challenge = new URL(result.location!)
      assert.equal(challenge.pathname,'/portal/sign-in'); assert.equal(challenge.searchParams.get('challenge'),'company'); assert.equal(challenge.searchParams.get('sig'),login.searchParams.get('sig'))
      await assert.rejects(sessionPrincipal(client.headers()),(e: any)=>e.code==='sign_in_required')
      const uri = await fixture.client.call('/two-factor/get-totp-uri',{password:fixture.password})
      const key = new URL(uri.data.totpURI).searchParams.get('secret')!
      result = await client.call('/two-factor/verify-totp',{code:totp(key),oauth_query:signedQuery})
    }
    const actor = await sessionPrincipal(client.headers())
    if (!mfa) userIds.push(actor.userId)
    let redirect = new URL(result.data?.url ?? result.location!,origin)
    assert.equal(redirect.pathname,'/portal/consent')
    const consent = await client.call('/oauth2/consent',{accept:true,oauth_query:redirect.search.slice(1)})
    redirect = new URL(consent.data.url)
    assert.equal(redirect.protocol,'com.hybes.sipper:'); assert.equal(redirect.searchParams.get('state'),state)
    const token = await getAuth().handler(new Request(`${origin}/api/auth/oauth2/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:'sipper-macos',redirect_uri:'com.hybes.sipper:/oauth/callback',code:redirect.searchParams.get('code')!,code_verifier:verifier})}))
    assert.equal(token.status,200,await token.clone().text())
    const tokens = await token.json() as any
    assert.ok(tokens.access_token); assert.ok(tokens.refresh_token)
    const replay = await getAuth().handler(new Request(`${origin}/api/auth/oauth2/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:'sipper-macos',redirect_uri:'com.hybes.sipper:/oauth/callback',code:redirect.searchParams.get('code')!,code_verifier:verifier})}))
    assert.equal(replay.status,400)
  }
})
test('provider disable rejects pending sign-ins; secret rotation keeps identity and tenant bindings intact', async () => {
  const client = authRequests(), email = fixture.email
  const pending = await start(client,email)
  await setCompanySignInEnabled(admin,organisation,{enabled:false})
  const disabled = await complete(client,pending,{sub:randomUUID(),email,name:'Disabled'})
  assert.match(disabled.location!,/company_sign_in_unavailable/)
  await assert.rejects(sessionPrincipal(client.headers()),(e: any)=>e.code==='sign_in_required')
  await setCompanySignInEnabled(admin,organisation,{enabled:true})
  acceptedSecret = 'rotated-fictional-secret'
  await saveCompanySignIn(admin,organisation,{...settings(),clientSecret:acceptedSecret})
  const newEmail = `rotated-${randomUUID()}@example.invalid`
  const rotated = await complete(client,await start(client,newEmail),{sub:randomUUID(),email:newEmail,name:'Rotated'})
  assert.equal(rotated.status,302)
  const rotatedActor = await sessionPrincipal(client.headers()); userIds.push(rotatedActor.userId)
  assert.equal(rotatedActor.email,newEmail)
  await assert.rejects(saveCompanySignIn(admin,organisation,{...settings(),clientId:'another-client'}),(e: any)=>e.code==='sso_identity_change')
  await assert.rejects(saveCompanySignIn(admin,organisation,{...settings(),issuer:'https://127.0.0.1/idp'}),(e: any)=>e.code==='oidc_discovery_failed')
  await assert.rejects(saveCompanySignIn(admin,organisation,{...settings(),issuer:'http://identity.example/idp'}))
  await assert.rejects(saveCompanySignIn(admin,organisation,{...settings(),domain:'*.example.invalid'}))
  const second = (await createOrganisation(admin,workspace,{name:'Other company'})).id
  const other = (await saveCompanySignIn(admin,second,{...settings(),domain:'other.example.invalid'})).provider!
  const foreignRef = (await rows('SELECT oidc_config FROM auth_sso_provider WHERE id=$1',[other.id]))[0]!.oidc_config
  await assert.rejects(transaction(async db => { await db.query('UPDATE auth_sso_provider SET oidc_config=$2 WHERE id=$1',[provider.id,foreignRef]) }), (e: any) => e.code==='23503')
})
