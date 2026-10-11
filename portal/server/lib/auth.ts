import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import { oauthProvider } from '@better-auth/oauth-provider'
import { getConfig } from './config'
import { getPool } from './db'
import { sendMail } from './mail'
import { companyAuth, companyTwoFactor } from './company-auth'

export function authOptions() {
  const c = getConfig()
  return {
    appName: 'Sipper',
    baseURL: c.SIPPER_BASE_URL,
    basePath: '/api/auth',
    secret: c.BETTER_AUTH_SECRET,
    // Provider errors may contain decoded ID-token claims or database values.
    // Retain a failure signal without writing identities or credentials to logs.
    logger: { level: 'warn', log: level => { console.warn(JSON.stringify({ component: 'authentication', level, event: 'authentication_diagnostic' })) } },
    database: getPool(),
    trustedOrigins: [c.SIPPER_BASE_URL],
    advanced: { ipAddress: { ipAddressHeaders: ['x-sipper-verified-ip'] } },
    user: { modelName: 'auth_user' },
    session: { modelName: 'auth_session', expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    account: { modelName: 'auth_account', encryptOAuthTokens: true },
    verification: { modelName: 'auth_verification' },
    emailAndPassword: {
      enabled: true, minPasswordLength: 12, requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendMail(user.email, 'Reset your Sipper password', `Reset your password using this link:\n\n${url}\n\nIf you did not request this, you can ignore this email.`)
      },
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail(user.email, 'Verify your Sipper email', `Verify your email to use Sipper management:\n\n${url}\n\nIf you did not create this account, you can ignore this email.`)
      },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    disabledPaths: ['/token'],
    databaseHooks: {
      user: { create: { before: async (user, ctx) => {
        // companyAuth's transactional resolver has already checked the verified
        // DNS domain, issuer and signed subject. This grants identity, not access.
        if (ctx?.path?.startsWith('/sso/callback/')) return { data: { ...user, emailVerified: true } }
      } } },
      account: {
        create: { before: async (account, ctx) => {
          if (ctx?.path?.startsWith('/sso/callback/')) return { data: { ...account, accessToken: null, refreshToken: null, idToken: null } }
        } },
        update: { before: async (account, ctx) => {
          if (ctx?.path?.startsWith('/sso/callback/')) return { data: { ...account, accessToken: null, refreshToken: null, idToken: null } }
        } },
      },
    },
    plugins: [
      companyTwoFactor(),
      jwt({ jwt: { issuer: c.SIPPER_BASE_URL } }),
      oauthProvider({
        loginPage: '/portal/sign-in', consentPage: '/portal/consent',
        grantTypes: ['authorization_code', 'refresh_token'],
        scopes: ['openid', 'email', 'profile', 'offline_access', 'sipper:client'],
        resources: [{ identifier: `${c.SIPPER_BASE_URL}/api/client`, allowedScopes: ['sipper:client'], accessTokenTtl: 300 }],
        accessTokenExpiresIn: 300, codeExpiresIn: 600,
        clientPrivileges: async () => false,
      }),
      companyAuth(),
    ],
  } satisfies BetterAuthOptions
}
function createAuth() { return betterAuth(authOptions()) }
let instance: ReturnType<typeof createAuth> | undefined
export function getAuth() { return instance ??= createAuth() }
