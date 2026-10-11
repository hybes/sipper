import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SIPPER_BASE_URL: z.url().default('http://localhost:3100'),
  DATABASE_URL: z.string().startsWith('postgres'),
  BETTER_AUTH_SECRET: z.string().min(32),
  SIPPER_ENCRYPTION_KEYS: z.string().min(1),
  SIPPER_ENCRYPTION_KEY_ID: z.string().default('v1'),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PRICE_MONTHLY: z.string().default(''),
  STRIPE_PRICE_ANNUAL: z.string().default(''),
  SIPPER_BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(0),
  SIPPER_ALLOW_TEST_BILLING: z.enum(['true', 'false']).default('false'),
  SIPPER_REQUIRE_ADMIN_MFA: z.enum(['true', 'false']).default('true'),
  SIPPER_NATIVE_REDIRECTS: z.string().default('sipper://oauth/callback,com.hybes.sipper:/oauth/callback'),
  SIPPER_CONFIG_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  SIPPER_TRUSTED_PROXY_IPS: z.string().default(''),
  SIPPER_EDGE_SHARED_SECRET: z.string().regex(/^(?:[A-Za-z0-9+/_=-]{32,512})?$/).default(''),
  SIPPER_GATEWAY_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('primary'),
  SIPPER_GATEWAY_API_KEY: z.string().default(''),
  SIPPER_GATEWAY_PUBLIC_HOST: z.string().regex(/^(?:[a-zA-Z0-9.:[\]-]{1,253})?$/).default(''),
  SIPPER_GATEWAY_PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).default(5061),
  SIPPER_APNS_KEY_ID: z.string().default(''),
  SIPPER_APNS_TEAM_ID: z.string().default(''),
  SIPPER_APNS_PRIVATE_KEY: z.string().default(''),
  SIPPER_APNS_TOPIC: z.string().default(''),
  SIPPER_APNS_MESSAGE_TOPIC: z.string().default(''),
  SIPPER_APNS_SANDBOX: z.enum(['true', 'false']).default('false'),
  SIPPER_FCM_SERVICE_ACCOUNT: z.string().default(''),
  SIPPER_ANDROID_PACKAGE: z.string().default('com.hybes.sipper.android'),
  SIPPER_CALL_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  SIPPER_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  SIPPER_MEETING_PUBLIC_URL: z.string().default(''),
  SIPPER_MEETING_INTERNAL_URL: z.string().default(''),
  SIPPER_MEETING_API_KEY: z.string().regex(/^(?:[A-Za-z0-9_-]{8,128})?$/).default(''),
  SIPPER_MEETING_API_SECRET: z.string().default(''),
  SIPPER_MEETING_ADMISSION_KEY: z.string().default(''),
})

export type Config = z.infer<typeof envSchema>
let cached: Config | undefined

export function getConfig(): Config {
  if (cached) return cached
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    // Never put values, connection strings or keys into configuration errors.
    throw new Error(`Missing or invalid configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`)
  }
  const value = parsed.data
  const meetingFields = [value.SIPPER_MEETING_PUBLIC_URL, value.SIPPER_MEETING_INTERNAL_URL, value.SIPPER_MEETING_API_KEY, value.SIPPER_MEETING_API_SECRET, value.SIPPER_MEETING_ADMISSION_KEY]
  if (meetingFields.some(Boolean)) {
    if (!meetingFields.every(Boolean) || value.SIPPER_MEETING_API_SECRET.length < 32 || value.SIPPER_MEETING_ADMISSION_KEY.length < 32) throw new Error('Configure all meeting settings with separate secrets of at least 32 characters')
    const publicUrl = new URL(value.SIPPER_MEETING_PUBLIC_URL), internalUrl = new URL(value.SIPPER_MEETING_INTERNAL_URL)
    if (![publicUrl, internalUrl].every(url => !url.username && !url.password && !url.search && !url.hash && url.pathname === '/')) throw new Error('Meeting URLs must be origins without credentials')
    if (!['ws:', 'wss:'].includes(publicUrl.protocol) || !['http:', 'https:'].includes(internalUrl.protocol) || publicUrl.host === internalUrl.host) throw new Error('Use separate public signalling and private media service origins')
    if (value.NODE_ENV === 'production' && publicUrl.protocol !== 'wss:') throw new Error('Production meetings require WSS')
    if (value.SIPPER_MEETING_API_SECRET === value.SIPPER_MEETING_ADMISSION_KEY) throw new Error('Use separate meeting API and admission secrets')
  }
  if (value.SIPPER_GATEWAY_API_KEY && value.SIPPER_GATEWAY_API_KEY.length < 32) throw new Error('SIPPER_GATEWAY_API_KEY must have at least 32 characters')
  if (value.NODE_ENV === 'production') {
    if (value.SIPPER_EDGE_SHARED_SECRET.length < 32) throw new Error('Production requires SIPPER_EDGE_SHARED_SECRET')
    if (!value.SIPPER_BASE_URL.startsWith('https://')) throw new Error('Production requires an HTTPS base URL')
    if (value.SIPPER_ALLOW_TEST_BILLING === 'true') throw new Error('Test billing is forbidden in production')
    if (value.SIPPER_REQUIRE_ADMIN_MFA !== 'true') throw new Error('Administrator MFA is required in production')
    if (/replace|example|local.only/i.test(value.BETTER_AUTH_SECRET)) throw new Error('Set a production authentication secret')
  }
  cached = value
  return value
}
