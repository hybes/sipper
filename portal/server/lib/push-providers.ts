import { createPrivateKey, sign } from 'node:crypto'
import { connect, type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2'
import { z } from 'zod'
import { getConfig, type Config } from './config'

export type PushOutcome = 'accepted' | 'invalid_token' | 'credentials' | 'retry' | 'rejected' | 'not_configured'
export interface IncomingPush { provider: 'apns' | 'fcm'; token: string; callId: string; deviceId: string; notificationId: string; expiresAt: string }
export interface MessagePush extends Omit<IncomingPush,'callId'> { conversationId: string }
type PushConfig = Pick<Config, 'SIPPER_APNS_KEY_ID' | 'SIPPER_APNS_TEAM_ID' | 'SIPPER_APNS_PRIVATE_KEY' | 'SIPPER_APNS_TOPIC' | 'SIPPER_APNS_MESSAGE_TOPIC' | 'SIPPER_APNS_SANDBOX' | 'SIPPER_FCM_SERVICE_ACCOUNT' | 'SIPPER_ANDROID_PACKAGE'>
type ProviderReply = { status: number; body: unknown }
type APNSRequest = (origin: string, headers: OutgoingHttpHeaders, body: string) => Promise<ProviderReply>
const connections = new Map<string, ClientHttp2Session>()

// Reuse HTTP/2 connections; all destinations below are fixed provider origins, never token data.
export const apnsRequest: APNSRequest = async (origin, headers, body) => {
  let session = connections.get(origin)
  if (!session || session.closed || session.destroyed) {
    session = connect(origin)
    connections.set(origin, session)
    session.on('error', () => {}) // Stream errors reject the individual request below.
    session.on('goaway', () => session?.close())
    session.setTimeout(60_000, () => session?.close())
    session.unref()
  }
  return new Promise((resolve, reject) => {
    const request = session!.request(headers)
    let status = 0, length = 0
    const chunks: Buffer[] = []
    request.setTimeout(5000, () => request.destroy(new Error('Push request timed out')))
    request.on('response', value => { status = Number(value[':status']) })
    request.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 65_536) request.destroy(new Error('Push response exceeded limit'))
      else chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      let value: unknown = null
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
      resolve({ status, body: value })
    })
    request.end(body)
  })
}
export function closePushConnections() { for (const session of connections.values()) session.close(); connections.clear() }

async function json(response: Response): Promise<any> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty provider response')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break
      length += next.value.byteLength
      if (length > 65_536) throw new Error('Provider response exceeded limit')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

function jwt(header: object, claims: object, pem: string, algorithm: 'ES256' | 'RS256') {
  const body = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  const key = createPrivateKey(pem.replaceAll('\\n', '\n'))
  if ((algorithm === 'ES256' && (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'))
    || (algorithm === 'RS256' && key.asymmetricKeyType !== 'rsa')) throw new Error('Invalid push signing key')
  const signature = sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' })
  return `${body}.${signature.toString('base64url')}`
}

const serviceAccount = z.object({ project_id: z.string().regex(/^[a-z0-9][a-z0-9-]{3,62}$/),
  client_email: z.email().endsWith('.gserviceaccount.com'), private_key: z.string().min(1) })

export class PushSender {
  private apnsToken?: { value: string; issued: number }
  private fcmToken?: { value: string; expires: number }
  constructor(private config: PushConfig, private transport = { fetch: globalThis.fetch, apns: apnsRequest }, private now = Date.now) {}

  async send(push: IncomingPush | MessagePush): Promise<PushOutcome> {
    // Stale calls and messages must not alert after a delayed worker recovers.
    if (!Number.isFinite(Date.parse(push.expiresAt)) || Date.parse(push.expiresAt) <= this.now()) return 'rejected'
    try { return push.provider === 'apns' ? await this.apple(push) : await this.firebase(push) }
    catch { return 'retry' } // Never expose a provider exception, token, key or response body.
  }

  private async apple(push: IncomingPush | MessagePush): Promise<PushOutcome> {
    const c = this.config
    const message='conversationId' in push, topic=message ? c.SIPPER_APNS_MESSAGE_TOPIC : c.SIPPER_APNS_TOPIC
    if (!c.SIPPER_APNS_KEY_ID || !c.SIPPER_APNS_TEAM_ID || !c.SIPPER_APNS_PRIVATE_KEY || !topic) return 'not_configured'
    if (!/^[A-Z0-9]{10}$/.test(c.SIPPER_APNS_KEY_ID) || !/^[A-Z0-9]{10}$/.test(c.SIPPER_APNS_TEAM_ID)
      || (message ? !/^[a-zA-Z0-9.-]+$/.test(topic) || topic.endsWith('.voip') : !/^[a-zA-Z0-9.-]+\.voip$/.test(topic))) return 'credentials'
    const now = Math.floor(this.now() / 1000)
    if (!this.apnsToken || this.apnsToken.issued > now || now - this.apnsToken.issued >= 1800) {
      try { this.apnsToken = { issued: now, value: jwt({ alg: 'ES256', kid: c.SIPPER_APNS_KEY_ID }, { iss: c.SIPPER_APNS_TEAM_ID, iat: now }, c.SIPPER_APNS_PRIVATE_KEY, 'ES256') } }
      catch { return 'credentials' }
    }
    const result = await this.transport.apns(c.SIPPER_APNS_SANDBOX === 'true' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com', {
      ':method': 'POST', ':path': `/3/device/${push.token}`, authorization: `bearer ${this.apnsToken.value}`,
      'apns-topic': topic, 'apns-push-type': message ? 'alert' : 'voip', 'apns-priority': '10',
      'apns-expiration': message ? String(Math.floor(Date.parse(push.expiresAt)/1000)) : '0', 'apns-id': push.notificationId,
      ...(message ? {'apns-collapse-id':'sipper-messages'} : {}),
      'content-type': 'application/json',
    }, JSON.stringify(message
      ? {aps:{alert:{title:'Sipper',body:'New message'},sound:'default','thread-id':'sipper-messages'},sipper:{schemaVersion:1,type:'message',conversationId:push.conversationId,deviceId:push.deviceId,expiresAt:push.expiresAt}}
      : {aps:{},sipper:{schemaVersion:1,callId:push.callId,deviceId:push.deviceId,expiresAt:push.expiresAt}}))
    const reason = (result.body as { reason?: string } | null)?.reason
    if (result.status === 200) return 'accepted'
    if (result.status === 410 || (result.status === 400 && reason === 'BadDeviceToken')) return 'invalid_token'
    if (result.status === 403 || reason === 'DeviceTokenNotForTopic') { this.apnsToken = undefined; return 'credentials' }
    return result.status === 429 || result.status >= 500 ? 'retry' : 'rejected'
  }

  private async firebase(push: IncomingPush | MessagePush): Promise<PushOutcome> {
    if (!this.config.SIPPER_FCM_SERVICE_ACCOUNT) return 'not_configured'
    let account: z.infer<typeof serviceAccount>
    try { account = serviceAccount.parse(JSON.parse(this.config.SIPPER_FCM_SERVICE_ACCOUNT)) } catch { return 'credentials' }
    if (!this.fcmToken || this.fcmToken.expires <= this.now() + 60_000) {
      let assertion: string
      try {
        const issued = Math.floor(this.now() / 1000)
        assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
          aud: 'https://oauth2.googleapis.com/token', iat: issued, exp: issued + 3600 }, account.private_key, 'RS256')
      } catch { return 'credentials' }
      const response = await this.transport.fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
      if (!response.ok) return response.status >= 500 || response.status === 429 ? 'retry' : 'credentials'
      const result = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive().max(3600), token_type: z.literal('Bearer') }).safeParse(await json(response))
      if (!result.success) return 'credentials'
      this.fcmToken = { value: result.data.access_token, expires: this.now() + result.data.expires_in * 1000 }
    }
    const message='conversationId' in push
    const response = await this.transport.fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${this.fcmToken.value}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: push.token,
        ...(message ? {notification:{title:'Sipper',body:'New message'}} : {}),
        android: { priority:'HIGH',ttl:message ? `${Math.max(1,Math.min(300,Math.floor((Date.parse(push.expiresAt)-this.now())/1000)))}s` : '0s',restricted_package_name:this.config.SIPPER_ANDROID_PACKAGE,
          ...(message ? {collapse_key:'sipper-messages',notification:{channel_id:'messages',tag:'sipper-messages',visibility:'PRIVATE',local_only:true,icon:'ic_phone'}} : {}) },
        data: message ? {type:'message',schemaVersion:'1',conversationId:push.conversationId,deviceId:push.deviceId,expiresAt:push.expiresAt}
          : {type:'incoming_call',schemaVersion:'1',callId:push.callId,deviceId:push.deviceId,expiresAt:push.expiresAt} } }),
    })
    if (response.ok) return 'accepted'
    const result = await json(response).catch(() => null)
    if (result?.error?.details?.some((detail: any) => detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && detail.errorCode === 'UNREGISTERED')) return 'invalid_token'
    if (response.status === 401 || response.status === 403) { this.fcmToken = undefined; return 'credentials' }
    return response.status === 429 || response.status >= 500 ? 'retry' : 'rejected'
  }
}
let sender: PushSender | undefined
export const getPushSender = () => sender ??= new PushSender(getConfig())
