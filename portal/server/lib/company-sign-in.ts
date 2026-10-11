import { randomBytes, randomUUID } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { domainToASCII } from 'node:url'
import { z } from 'zod'
import { computeDiscoveryUrl, fetchDiscoveryDocument, normalizeDiscoveryUrls, selectTokenEndpointAuthMethod, validateDiscoveryDocument } from '@better-auth/sso'
import { audit, lockManagedOrganisation, requireOrganisation, type Principal } from './access'
import { rows, transaction } from './db'
import { getConfig } from './config'
import { openSecret, sealSecret } from './crypto'
import { ServiceError, requireValue } from './errors'

const input = z.object({
  domain: z.string().trim().min(3).max(253).transform(value => domainToASCII(value.toLowerCase())).refine(value => value.includes('.') && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), 'Enter an email domain, without a URL or wildcard.'),
  issuer: z.url().max(2048).refine(value => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (getConfig().NODE_ENV === 'test' && url.origin === new URL(getConfig().SIPPER_BASE_URL).origin))
  }, 'Use an HTTPS issuer URL without credentials, a query or a fragment.'),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().min(1).max(4096),
}).strict()

function dnsName(provider: { id: string; domain: string }) { return `_sipper-sso-${provider.id}.${provider.domain}` }
function summary(provider: any) {
  if (!provider) return null
  return { id: provider.id, domain: provider.domain, issuer: provider.issuer, clientId: provider.client_id,
    enabled: provider.enabled, verifiedAt: provider.verified_at,
    callbackURL: `${getConfig().SIPPER_BASE_URL}/api/auth/sso/callback/${provider.provider_id}`,
    verification: { name: dnsName(provider), type: 'TXT', value: provider.verification_token } }
}

export async function companySignIn(actor: Principal, organisationId: string) {
  await requireOrganisation(actor, organisationId)
  return { provider: summary((await rows('SELECT * FROM auth_sso_provider WHERE organisation_id=$1', [organisationId]))[0]) }
}

export async function saveCompanySignIn(actor: Principal, organisationId: string, body: unknown) {
  await requireOrganisation(actor, organisationId)
  const value = input.parse(body)
  let discovered
  try {
    const trustedFixture = (url: string) => getConfig().NODE_ENV === 'test' && new URL(url).origin === new URL(getConfig().SIPPER_BASE_URL).origin
    const discoveryEndpoint = computeDiscoveryUrl(value.issuer)
    // Do not add tenant-supplied origins to Better Auth's browser/SSRF allowlist.
    const document = await fetchDiscoveryDocument(discoveryEndpoint, 8000, trustedFixture)
    validateDiscoveryDocument(document, value.issuer)
    const normalized = normalizeDiscoveryUrls(document, value.issuer, trustedFixture)
    if (document.token_endpoint_auth_methods_supported?.length && !document.token_endpoint_auth_methods_supported.some(method => ['client_secret_basic', 'client_secret_post'].includes(method))) throw new Error('Client secret authentication required')
    discovered = { issuer: value.issuer, discoveryEndpoint, authorizationEndpoint: normalized.authorization_endpoint, tokenEndpoint: normalized.token_endpoint, jwksEndpoint: normalized.jwks_uri, userInfoEndpoint: normalized.userinfo_endpoint, tokenEndpointAuthentication: selectTokenEndpointAuthMethod(document) }
    for (const url of [discovered.authorizationEndpoint, discovered.tokenEndpoint, discovered.jwksEndpoint, discovered.userInfoEndpoint].filter(Boolean)) {
      const endpoint = new URL(url!)
      if (endpoint.username || endpoint.password || endpoint.hash || (endpoint.protocol !== 'https:' && !trustedFixture(url!))) throw new Error('Secure endpoints required')
    }
  } catch {
    throw new ServiceError(400, 'oidc_discovery_failed', 'Could not verify this OIDC issuer. Check its discovery document and client-secret authentication support.')
  }
  return transaction(async db => {
    const organisation = await lockManagedOrganisation(actor, organisationId, db)
    const previous = (await rows('SELECT * FROM auth_sso_provider WHERE organisation_id=$1 FOR UPDATE', [organisationId], db))[0]
    // A provider ID permanently names an issuer/client/domain identity boundary.
    // Reusing it for another issuer would rebind existing subject IDs to new owners.
    if (previous && (previous.domain !== value.domain || previous.issuer !== value.issuer || previous.client_id !== value.clientId)) {
      throw new ServiceError(409, 'sso_identity_change', 'The domain, issuer and client ID cannot change on an existing connection. Disable it and contact the platform administrator to migrate identities.')
    }
    const id = previous?.id ?? randomUUID(), configId = randomUUID()
    const configuration = { ...discovered, clientId: value.clientId, clientSecret: value.clientSecret, pkce: true, scopes: ['openid', 'email', 'profile'], overrideUserInfo: false, allowIdpInitiated: false }
    if (!previous) await db.query(`INSERT INTO auth_sso_provider (id,issuer,domain,user_id,provider_id,organisation_id,client_id,verification_token,domain_verified,enabled,oidc_config)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,false,$9)`, [id,value.issuer,value.domain,actor.userId,`sipper-${id}`,organisationId,value.clientId,randomBytes(32).toString('base64url'),configId])
    await db.query('INSERT INTO sso_configurations (id,provider_id,envelope) VALUES ($1,$2,$3)', [configId,id,JSON.stringify(sealSecret(JSON.stringify(configuration), `sso:${id}:${configId}`))])
    if (previous) {
      await db.query('UPDATE auth_sso_provider SET oidc_config=$2 WHERE id=$1', [id,configId])
      await db.query('DELETE FROM sso_configurations WHERE id=$1', [previous.oidc_config])
    }
    await audit(db,actor,organisation.workspace_id,previous ? 'company_sign_in.updated' : 'company_sign_in.created',id,organisationId)
    return { provider: summary((await rows('SELECT * FROM auth_sso_provider WHERE id=$1',[id],db))[0]) }
  })
}

export async function verifyCompanyDomain(actor: Principal, organisationId: string) {
  await requireOrganisation(actor, organisationId)
  const provider = requireValue((await rows('SELECT * FROM auth_sso_provider WHERE organisation_id=$1', [organisationId]))[0])
  let records: string[][]
  try { records = await new Resolver({ timeout: 3000, tries: 1 }).resolveTxt(dnsName({ id: provider.id, domain: provider.domain })) }
  catch { throw new ServiceError(409, 'sso_dns_pending', 'The verification TXT record was not found. Check the record and try again after DNS has updated.') }
  if (!records.some(record => record.join('') === provider.verification_token)) throw new ServiceError(409, 'sso_dns_pending', 'The TXT record does not match this connection’s verification value.')
  return transaction(async db => {
    const organisation = await lockManagedOrganisation(actor, organisationId, db)
    const current = requireValue((await rows('SELECT * FROM auth_sso_provider WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [provider.id,organisationId],db))[0])
    if (current.verification_token !== provider.verification_token || current.domain !== provider.domain) throw new ServiceError(409, 'sso_changed', 'This connection changed. Reload it and verify the current record.')
    // Serialise claims without reserving unverified domains for the first registrant.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('sipper-sso-domain:'||$1))", [current.domain])
    if ((await rows('SELECT id FROM auth_sso_provider WHERE domain=$1 AND domain_verified=true AND id<>$2',[current.domain,current.id],db)).length) throw new ServiceError(409, 'sso_domain_in_use', 'This domain already has a verified Sipper connection. Contact the platform administrator.')
    await db.query('UPDATE auth_sso_provider SET domain_verified=true,verified_at=now() WHERE id=$1',[current.id])
    await audit(db,actor,organisation.workspace_id,'company_sign_in.domain_verified',current.id,organisationId)
    return { provider: summary((await rows('SELECT * FROM auth_sso_provider WHERE id=$1',[current.id],db))[0]) }
  })
}

export async function setCompanySignInEnabled(actor: Principal, organisationId: string, body: unknown) {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(body)
  return transaction(async db => {
    const organisation = await lockManagedOrganisation(actor,organisationId,db)
    const provider = requireValue((await rows('SELECT * FROM auth_sso_provider WHERE organisation_id=$1 FOR UPDATE',[organisationId],db))[0])
    if (enabled && !provider.domain_verified) throw new ServiceError(409, 'sso_domain_unverified', 'Verify the email domain before enabling company sign-in.')
    if (provider.enabled !== enabled) {
      await db.query('UPDATE auth_sso_provider SET enabled=$2 WHERE id=$1',[provider.id,enabled])
      await audit(db,actor,organisation.workspace_id,enabled ? 'company_sign_in.enabled' : 'company_sign_in.disabled',provider.id,organisationId)
    }
    return { provider: summary((await rows('SELECT * FROM auth_sso_provider WHERE id=$1',[provider.id],db))[0]) }
  })
}

// The library sees hydrated OIDC configuration; its provider table stores only an
// opaque reference. A deferred composite FK prevents a different tenant's secret
// from being substituted. New configurations are immutable and encrypted whole.
export async function readCompanyOidcConfig(reference: unknown) {
  if (typeof reference !== 'string' || !z.uuid().safeParse(reference).success) throw new Error('Invalid company sign-in configuration reference')
  const config = requireValue((await rows('SELECT provider_id,envelope FROM sso_configurations WHERE id=$1',[reference]))[0])
  return openSecret(config.envelope, `sso:${config.provider_id}:${reference}`)
}
