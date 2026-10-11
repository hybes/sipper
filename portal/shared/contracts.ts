import { z } from 'zod'

const name = z.string().trim().min(1).max(160)
const noControl = z.string().max(512).refine(v => !/[\x00-\x1f\x7f]/.test(v), 'Control characters are not allowed')
const host = z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:[\]-]+$/, 'Enter a host name or IP address without a protocol or path')
export const workspaceInput = z.object({ name, kind: z.enum(['reseller', 'business']) }).strict()
export const organisationInput = z.object({ name }).strict()
export const invitationInput = z.object({ email: z.email().trim().toLowerCase().max(254), role: z.enum(['admin', 'user']).default('user') }).strict()
export const sipSettings = z.object({
  username: noControl.pipe(z.string().min(1)),
  authUsername: noControl.default(''),
  domain: host, server: host,
  port: z.number().int().min(1).max(65535).nullable().default(null),
  transport: z.enum(['udp', 'tcp', 'tls']).default('tls'),
  srtp: z.enum(['disabled', 'optional', 'required']).default('required'),
  displayName: noControl.default(''),
  voicemailNumber: noControl.default('*97'),
  useICE: z.boolean().default(true),
  stunServer: host.or(z.literal('')).default(''),
}).strict()
export const configurationInput = z.object({
  label: name, mode: z.enum(['direct', 'gateway']), settings: sipSettings,
  password: z.string().min(1).max(1024),
}).strict()
export const deviceInput = z.object({
  installationId: z.uuid(), name, platform: z.enum(['macos', 'windows', 'ios', 'android']),
  appVersion: z.string().min(1).max(40), osVersion: z.string().min(1).max(80),
}).strict()
export type SipSettings = z.infer<typeof sipSettings>
export type ConfigurationInput = z.infer<typeof configurationInput>
export type DeviceInput = z.infer<typeof deviceInput>
export interface ManagedConfiguration {
  schemaVersion: 1
  organisation: { id: string; name: string }
  deviceId: string
  revision: string
  expiresAt: string
  accounts: Array<{
    id: string; label: string; mode: 'direct' | 'gateway'; revision: number
    settings: SipSettings; password: string; doNotDisturb?: boolean
  }>
}
