import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { getConfig } from './config'

interface Envelope { version: 1; keyId: string; wrappedKey: string; wrappingIV: string; wrappingTag: string; iv: string; tag: string; data: string }

function encryptionKey(keyId: string): Buffer {
  let keys: Record<string, string>
  try { keys = JSON.parse(getConfig().SIPPER_ENCRYPTION_KEYS) } catch { throw new Error('Invalid SIPPER_ENCRYPTION_KEYS JSON') }
  const encoded = keys[keyId]
  const key = Buffer.from(encoded ?? '', 'base64')
  if (key.length !== 32) throw new Error(`A 32-byte encryption key is required for key ID ${keyId}`)
  return key
}
function encrypt(key: Buffer, plaintext: Buffer, context: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context))
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}
function decrypt(key: Buffer, value: { iv: string; tag: string; data: string }, context: string) {
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
  cipher.setAAD(Buffer.from(context))
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()])
}
export function sealSecret(value: string, context: string): Envelope {
  const keyId = getConfig().SIPPER_ENCRYPTION_KEY_ID
  const dataKey = randomBytes(32)
  try {
    const wrapped = encrypt(encryptionKey(keyId), dataKey, `key:${context}`)
    return { version: 1, keyId, wrappedKey: wrapped.data, wrappingIV: wrapped.iv, wrappingTag: wrapped.tag, ...encrypt(dataKey, Buffer.from(value), context) }
  } finally { dataKey.fill(0) }
}
export function openSecret(envelope: Envelope, context: string): string {
  if (envelope.version !== 1) throw new Error('Unknown encrypted secret version')
  const dataKey = decrypt(encryptionKey(envelope.keyId), { iv: envelope.wrappingIV, tag: envelope.wrappingTag, data: envelope.wrappedKey }, `key:${context}`)
  try { return decrypt(dataKey, envelope, context).toString() } finally { dataKey.fill(0) }
}
