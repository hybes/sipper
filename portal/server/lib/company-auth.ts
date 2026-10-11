import { sso } from '@better-auth/sso'
import { APIError, createAuthMiddleware, addOAuthServerContext, getOAuthState } from 'better-auth/api'
import { twoFactor } from 'better-auth/plugins'
import { z } from 'zod'
import { rows } from './db'
import { getConfig } from './config'
import { readCompanyOidcConfig } from './company-sign-in'

export function companyAuth() {
  const plugin = sso({
    domainVerification: { enabled: true },
    organizationProvisioning: { disabled: true },
    schema: { ssoProvider: { modelName: 'auth_sso_provider', fields: {
      oidcConfig: 'oidc_config', samlConfig: 'saml_config', userId: 'user_id', providerId: 'provider_id', organizationId: 'organisation_id', domainVerified: 'domain_verified',
    }, additionalFields: {
      enabled: { type: 'boolean', required: true, defaultValue: false, input: false },
      clientId: { type: 'string', fieldName: 'client_id', required: true, input: false },
      verifiedAt: { type: 'date', fieldName: 'verified_at', required: false, input: false },
      verificationToken: { type: 'string', fieldName: 'verification_token', required: true, input: false, returned: false },
    } } },
    async resolveUser(identity, { database }) {
      const denied = { action: 'reject' as const, code: 'company_sign_in_unavailable', message: 'Company sign-in is unavailable for this identity.' }
      if (identity.protocol !== 'oidc' || identity.providerReference.source.type !== 'persisted') return denied
      // Runs with the plugin's provider lock, in the account/session transaction.
      const provider = await database.findOne<any>({ model: 'ssoProvider', where: [{ field: 'id', value: identity.providerReference.source.recordId }] })
      const email = identity.providerUser.email.toLowerCase()
      if (!provider?.enabled || !provider.domainVerified || provider.providerId !== identity.providerId || provider.issuer !== identity.accountKey.issuer || email.split('@')[1] !== provider.domain) return denied
      const account = await database.findOne<any>({ model: 'account', where: [{ field: 'providerId', value: identity.providerId }, { field: 'accountId', value: identity.accountKey.accountId }] })
      if (account) {
        const user = await database.findOne<any>({ model: 'user', where: [{ field: 'id', value: account.userId }] })
        // A changed subject's email must never silently move a global identity.
        return user?.email === email ? { action: 'link' as const, userId: user.id, profile: 'preserve' as const } : denied
      }
      const user = await database.findOne<any>({ model: 'user', where: [{ field: 'email', value: email }] })
      if (user) {
        if (!user.emailVerified) return denied
        const prior = await database.findOne({ model: 'account', where: [{ field: 'providerId', value: identity.providerId }, { field: 'userId', value: user.id }] })
        if (prior) return denied
      }
      return { action: 'continue' as const }
    },
  })
  plugin.schema.ssoProvider.fields.oidcConfig!.transform = { output: value => value === null || value === undefined ? value : readCompanyOidcConfig(value) }
  return {
    ...plugin,
    // Sipper owns tenant authority, DNS verification and encrypted configuration.
    // Expose neither the library's user-owned CRUD nor its unused SAML routes.
    init: undefined,
    endpoints: { signInSSO: plugin.endpoints.signInSSO, callbackSSO: plugin.endpoints.callbackSSO },
    hooks: { before: [{
      matcher: (ctx: { path?: string }) => ctx.path === '/sign-in/sso',
      handler: createAuthMiddleware(async ctx => {
        const body = z.object({ email: z.email().max(254), callbackURL: z.string().max(8192), errorCallbackURL: z.string().max(8192).optional(), oauth_query: z.string().max(8192).optional() }).strict().safeParse(ctx.body)
        if (!body.success) throw new APIError('BAD_REQUEST', { message: 'Enter your company email address.' })
        const provider = (await rows('SELECT provider_id FROM auth_sso_provider WHERE domain=$1 AND domain_verified=true AND enabled=true', [body.data.email.split('@')[1]!.toLowerCase()]))[0]
        if (!provider) throw new APIError('NOT_FOUND', { message: 'Company sign-in is not available for this email domain. Use your Sipper password or contact your administrator.' })
        if (body.data.oauth_query) {
          // oauthProvider runs before this hook and verifies the signed query.
          // Carry its 1.7.5 post-login context across the external OIDC redirect,
          // as that plugin does for social providers. Native PKCE/consent tests
          // cover this integration, including prompt=login and max_age=0.
          const query = new URLSearchParams(body.data.oauth_query), issuedAt = Number(query.get('ba_iat'))
          for (const key of ['sig', 'exp', 'ba_iat', 'ba_pl']) query.delete(key)
          await addOAuthServerContext({ query: query.toString(), signedQueryIssuedAtMs: issuedAt, sipperOAuthQuery: body.data.oauth_query })
        }
        return { context: { body: { ...body.data, providerId: provider.provider_id } } }
      }),
    }] },
  }
}

export function companyTwoFactor() {
  const plugin = twoFactor({ issuer: 'Sipper', allowPasswordless: true })
  const challenge = plugin.hooks.after[0]!
  const credentialMatcher = challenge.matcher
  challenge.matcher = ctx => credentialMatcher(ctx) || Boolean(ctx.path?.startsWith('/sso/callback/'))
  return { ...plugin, hooks: { after: [...plugin.hooks.after, {
    matcher: (ctx: { path?: string }) => Boolean(ctx.path?.startsWith('/sso/callback/')),
    handler: createAuthMiddleware(async ctx => {
      if (!(ctx.context.returned as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return
      const destination = ctx.context.responseHeaders?.get('location') ?? '/portal'
      const url = new URL('/portal/sign-in', getConfig().SIPPER_BASE_URL)
      const nativeQuery = (await getOAuthState())?.serverContext?.sipperOAuthQuery
      if (typeof nativeQuery === 'string') url.search = nativeQuery
      url.searchParams.set('challenge', 'company')
      const target = new URL(destination, getConfig().SIPPER_BASE_URL)
      url.searchParams.set('next', target.origin === new URL(getConfig().SIPPER_BASE_URL).origin && (target.pathname === '/portal' || target.pathname.startsWith('/portal/')) ? `${target.pathname}${target.search}` : '/portal')
      throw ctx.redirect(url.toString())
    }),
  }] } }
}
