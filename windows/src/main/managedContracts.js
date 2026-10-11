// Responses from the management service are validated before they reach the SIP engine.
import { z } from 'zod';

const text = z.string().max(512).refine(v => !/[\x00-\x1f\x7f]/.test(v));
const name = text.pipe(z.string().min(1).max(160));
const host = z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:[\]-]+$/);
export const uuid = z.uuid().transform(value => value.toLowerCase());
export const availabilityValue = z.enum(['unset', 'available', 'away', 'busy']);
export const identityResponse = z.object({
  user: z.object({ id: z.string().min(1).max(128), email: z.email() }),
  organisations: z.array(z.object({ id: uuid, name, status: z.enum(['active', 'suspended']), licensed: z.boolean(), doNotDisturb: z.boolean().optional(), availability: availabilityValue.optional() })).max(10000),
});
export const configurationResponse = z.object({
  schemaVersion: z.literal(1),
  organisation: z.object({ id: uuid, name }),
  deviceId: uuid,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime({ offset: true }),
  accounts: z.array(z.object({
    id: uuid, label: name, mode: z.enum(['direct', 'gateway']), revision: z.number().int().positive(),
    password: z.string().min(1).max(1024), doNotDisturb: z.boolean().optional(),
    settings: z.object({
      username: text.pipe(z.string().min(1)), authUsername: text.default(''),
      domain: host, server: host, port: z.number().int().min(1).max(65535).nullable(),
      transport: z.enum(['udp', 'tcp', 'tls']), srtp: z.enum(['disabled', 'optional', 'required']),
      displayName: text.default(''), voicemailNumber: text.default('*97'),
      useICE: z.boolean(), stunServer: host.or(z.literal('')),
    }),
  }).refine(account => account.mode !== 'gateway' || (account.settings.transport === 'tls' && account.settings.srtp === 'required'))).max(100),
}).refine(c => new Set(c.accounts.map(a => a.id.toLowerCase())).size === c.accounts.length);
export const deviceResponse = z.object({ id: uuid, name, platform: z.literal('windows') });
export function validateConfiguration(input, organisationId, deviceId, now = Date.now()) {
  const result = configurationResponse.parse(input);
  if (result.organisation.id !== uuid.parse(organisationId) || result.deviceId !== uuid.parse(deviceId)
      || Date.parse(result.expiresAt) <= now || Date.parse(result.expiresAt) > now + 86400_000 + 60_000) {
    throw new Error('Invalid managed configuration binding or expiry.');
  }
  return result;
}

export const callResponse = z.object({
  id: uuid, configurationId: uuid, state: z.enum(['ringing', 'answering', 'answered', 'ended']),
  version: z.number().int().min(1).max(2147483647), expiresAt: z.iso.datetime({ offset: true }),
  claimedByThisDevice: z.boolean(),
  caller: z.object({ name: text.pipe(z.string().max(160)), number: text.pipe(z.string().max(160)) }).optional(),
}).refine(call => call.caller || !['ringing', 'answering'].includes(call.state));

export function callUnavailable(call, now = Date.now()) {
  return call.state === 'ended' || (['answering', 'answered'].includes(call.state) && !call.claimedByThisDevice)
    || (['ringing', 'answering'].includes(call.state) && Date.parse(call.expiresAt) <= now);
}

const directoryText = z.string().max(160).refine(value => value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value));
const directoryContact = z.object({
  id: uuid, name: directoryText.pipe(z.string().min(1)), company: directoryText,
  revision: z.number().int().min(1).max(2147483647), updatedAt: z.iso.datetime({ offset: true }),
  numbers: z.array(z.object({ label: directoryText.pipe(z.string().min(1).max(32)), number: z.string().regex(/^\+?[0-9*#]{1,64}$/) })).min(1).max(5)
    .refine(numbers => new Set(numbers.map(n => n.number)).size === numbers.length),
});
const directoryFields = {
  organisation: z.object({ id: uuid, name: directoryText.pipe(z.string().min(1)) }), deviceId: uuid,
  revision: uuid, expiresAt: z.iso.datetime({ offset: true }),
};
export const directoryResponse = z.object({ ...directoryFields, contacts: z.array(directoryContact).max(10000) })
  .refine(value => new Set(value.contacts.map(c => c.id)).size === value.contacts.length);
export const directoryPageResponse = z.object({ ...directoryFields, contacts: z.array(directoryContact).max(100), nextCursor: uuid.nullable() })
  .refine(value => value.nextCursor === null || (value.contacts.length === 100 && value.nextCursor === value.contacts.at(-1).id));
export function validateDirectory(input, organisationId, deviceId, now = Date.now()) {
  const value = directoryResponse.parse(input);
  if (value.organisation.id !== uuid.parse(organisationId) || value.deviceId !== uuid.parse(deviceId)
    || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + 86460_000) throw new Error('Invalid directory binding or expiry.');
  return value;
}
