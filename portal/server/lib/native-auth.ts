import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import { getAuth } from './auth'
import { getConfig } from './config'
import { rows } from './db'
import { ServiceError } from './errors'
import type { Principal } from './access'
import { claimProvisionedMemberships } from './scim-members'

export const nativeClients = ['sipper-macos', 'sipper-windows', 'sipper-ios', 'sipper-android'] as const
export function clientResource() { return `${getConfig().SIPPER_BASE_URL}/api/client` }

export async function seedNativeClients() {
  const context = await getAuth().$context
  const resource = await context.adapter.findOne<{ id: string }>({ model: 'oauthResource', where: [{ field: 'identifier', value: clientResource() }] })
  if (!resource) throw new Error('Native client API resource was not initialised')
  const redirectUris = getConfig().SIPPER_NATIVE_REDIRECTS.split(',').map(s => s.trim()).filter(Boolean)
  for (const uri of redirectUris) {
    const url = new URL(uri)
    if (url.hash || url.username || url.password || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Invalid native OAuth redirect URI')
  }
  for (const clientId of nativeClients) {
    const existing = await context.adapter.findOne<{ id: string }>({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] })
    const data = { clientId, name: `Sipper ${clientId.slice(7)}`, redirectUris, tokenEndpointAuthMethod: 'none', applicationType: 'native',
      grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], scopes: ['openid', 'email', 'profile', 'offline_access', 'sipper:client'],
      requirePKCE: true, skipConsent: false, enableEndSession: true, disabled: false, updatedAt: new Date() }
    if (existing) await context.adapter.update({ model: 'oauthClient', where: [{ field: 'id', value: existing.id }], update: data })
    else await context.adapter.create({ model: 'oauthClient', data: { ...data, createdAt: new Date() } })
    const linked = await context.adapter.findOne({ model: 'oauthClientResource', where: [{ field: 'clientId', value: clientId }, { field: 'resourceId', value: clientResource() }] })
    if (!linked) await context.adapter.create({ model: 'oauthClientResource', data: { clientId, resourceId: clientResource(), createdAt: new Date() } })
  }
}

export async function nativePrincipal(request: Request): Promise<Principal> {
  let actor: Principal
  try {
    const auth = getAuth(), base = getConfig().SIPPER_BASE_URL
    const claims = await oauthProviderResourceClient(auth).getActions().verifyAccessTokenRequest(request, {
      jwksUrl: `${base}/api/auth/jwks`, verifyOptions: { issuer: base, audience: clientResource() }, requiredScopes: ['sipper:client'],
    })
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || !nativeClients.includes(claims.client_id as typeof nativeClients[number])) throw new Error('Invalid native token')
    // Checking the linked session makes logout, password resets and MFA transitions effective immediately.
    const user = (await rows(`SELECT u.id,u.email,u."emailVerified",s."createdAt" AS session_created_at FROM auth_user u JOIN auth_session s ON s."userId"=u.id
      WHERE u.id=$1 AND s.id=$2 AND s."expiresAt">now()`, [claims.sub, claims.sid]))[0]
    if (!user) throw new Error('Session revoked')
    // Native tokens never authorise portal administration, even for an administrator's identity.
    actor = { userId: user.id, email: user.email, verified: user.emailVerified, mfa: false, sessionCreatedAt: user.session_created_at, sessionId: claims.sid }
  } catch { throw new ServiceError(401, 'invalid_access_token', 'Sign in again to refresh managed access.') }
  await claimProvisionedMemberships(actor)
  return actor
}
