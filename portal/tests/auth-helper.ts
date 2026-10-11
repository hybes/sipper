import { createHmac, randomUUID, randomInt } from 'node:crypto'
import { getAuth } from '../server/lib/auth'
import { getConfig } from '../server/lib/config'

export function totp(secret: string) {
  const bits = [...secret.toUpperCase()].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('')
  const key = Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)))
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const hash = createHmac('sha1', key).update(counter).digest()
  const offset = hash[hash.length - 1]! & 15
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0')
}
export function authRequests() {
  const cookies = new Map<string, string>()
  const testIp = `192.0.2.${randomInt(1,255)}`
  return {
    // Direct auth-handler tests model the trusted header created by the HTTP
    // middleware. Real HTTP requests cannot choose it: middleware overwrites it.
    headers: () => new Headers({ 'x-sipper-verified-ip': testIp, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }),
    async call(path: string, body?: unknown) {
      const c = getConfig(), headers = this.headers()
      headers.set('origin', c.SIPPER_BASE_URL)
      if (body) headers.set('content-type', 'application/json')
      const response = await getAuth().handler(new Request(`${c.SIPPER_BASE_URL}/api/auth${path}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }))
      for (const cookie of response.headers.getSetCookie()) {
        const part = cookie.split(';')[0]!, equal = part.indexOf('=')
        cookies.set(part.slice(0, equal), part.slice(equal + 1))
      }
      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch { data = null }
      return { status: response.status, data, location: response.headers.get('location') }
    },
  }
}
export async function createVerifiedLocalUser(label = 'Test operator') {
  const c = getConfig()
  if (c.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(c.SMTP_HOST) || !['localhost', '127.0.0.1'].includes(new URL(c.SIPPER_BASE_URL).hostname)) throw new Error('Local fixtures require localhost and local Mailpit')
  const email = `sipper-${randomUUID()}@example.invalid`, password = 'Local-fixture-only-8!6-Sipper'
  const client = authRequests()
  const created = await client.call('/sign-up/email', { name: label, email, password, callbackURL: '/portal/sign-in?verified=1' })
  if (created.status !== 200) throw new Error(`Local signup failed (${created.status})`)
  const messages = await (await fetch(`http://127.0.0.1:8030/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json() as any
  if (!messages.messages?.[0]) throw new Error('Verification message did not reach local Mailpit')
  const mail = await (await fetch(`http://127.0.0.1:8030/api/v1/message/${messages.messages[0].ID}`)).json() as any
  const link = String(mail.Text).split(/\s+/).find(s => s.startsWith(`${c.SIPPER_BASE_URL}/api/auth/verify-email?`))
  if (!link) throw new Error('Verification email contained no local link')
  const response = await getAuth().handler(new Request(link))
  if (response.status !== 302) throw new Error(`Email verification failed (${response.status})`)
  const signedIn = await client.call('/sign-in/email', { email, password })
  if (signedIn.status !== 200) throw new Error(`Could not sign in with the verified fixture (${signedIn.status}, ${signedIn.data?.code ?? 'unknown'})`)
  return { email, password, userId: created.data.user.id as string, client }
}
