import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { PushSender, type IncomingPush, type MessagePush } from '../server/lib/push-providers'

const apple = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = {
  SIPPER_APNS_KEY_ID: 'AAAAAAAAAA', SIPPER_APNS_TEAM_ID: 'BBBBBBBBBB', SIPPER_APNS_TOPIC: 'invalid.example.sipper.voip',
  SIPPER_APNS_MESSAGE_TOPIC: 'invalid.example.sipper',
  SIPPER_APNS_PRIVATE_KEY: apple.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), SIPPER_APNS_SANDBOX: 'true' as const,
  SIPPER_FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'sipper-fixture', client_email: 'fixture@sipper-fixture.iam.gserviceaccount.com', private_key: google.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), token_uri: 'https://untrusted.example.invalid/token' }),
  SIPPER_ANDROID_PACKAGE: 'invalid.example.sipper',
}
const push = (provider: 'apns' | 'fcm' = 'apns'): IncomingPush => ({ provider, token: provider === 'apns' ? 'a'.repeat(64) : 'fictional-fcm-token', callId: randomUUID(), deviceId: randomUUID(), notificationId: randomUUID(), expiresAt: new Date(Date.now() + 45_000).toISOString() })
const noFetch: typeof fetch = async () => { throw new Error('Unexpected network request') }
test('chat uses generic normal APNs alerts and FCM notifications without bodies or caller data',async()=>{
  const requests:any[]=[]
  const sender=new PushSender(config,{apns:async(origin,headers,body)=>{requests.push({origin,headers,body:JSON.parse(body)});return {status:200,body:null}},
    fetch:async(input,options={})=>String(input).endsWith('/token') ? Response.json({access_token:'fixture-access',expires_in:3600,token_type:'Bearer'})
      : (requests.push({url:String(input),body:JSON.parse(String(options.body))}),Response.json({name:'fixture-message'}))})
  const notice:MessagePush={provider:'apns',token:'d'.repeat(64),deviceId:randomUUID(),conversationId:randomUUID(),notificationId:randomUUID(),expiresAt:new Date(Date.now()+300_000).toISOString()}
  assert.equal(await sender.send(notice),'accepted')
  const apple=requests[0]
  assert.equal(apple.headers['apns-push-type'],'alert');assert.equal(apple.headers['apns-topic'],config.SIPPER_APNS_MESSAGE_TOPIC)
  assert.equal(apple.headers['apns-collapse-id'],'sipper-messages');assert.equal(apple.headers['apns-expiration'],String(Math.floor(Date.parse(notice.expiresAt)/1000)))
  assert.deepEqual(apple.body.aps.alert,{title:'Sipper',body:'New message'})
  assert.deepEqual(apple.body.sipper,{schemaVersion:1,type:'message',conversationId:notice.conversationId,deviceId:notice.deviceId,expiresAt:notice.expiresAt})
  assert.equal(await sender.send({...notice,provider:'fcm',token:'fictional-fcm-token'}),'accepted')
  const google=requests[1].body.message
  assert.deepEqual(google.notification,{title:'Sipper',body:'New message'})
  assert.equal(google.android.collapse_key,'sipper-messages');assert.equal(google.android.notification.channel_id,'messages')
  assert.equal(google.android.notification.visibility,'PRIVATE');assert.equal(google.data.type,'message');assert.equal(google.data.callId,undefined)
  assert.equal(google.data.conversationId,notice.conversationId);assert.match(google.android.ttl,/^(29\d|300)s$/)
  const missing=new PushSender({...config,SIPPER_APNS_MESSAGE_TOPIC:''},{fetch:noFetch,apns:async()=>{throw Error('Unexpected APNs')}})
  assert.equal(await missing.send(notice),'not_configured')
  const voip=new PushSender({...config,SIPPER_APNS_MESSAGE_TOPIC:config.SIPPER_APNS_TOPIC},{fetch:noFetch,apns:async()=>{throw Error('Unexpected APNs')}})
  assert.equal(await voip.send(notice),'credentials')
  assert.equal(await sender.send({...notice,expiresAt:new Date(Date.now()-1000).toISOString()}),'rejected');assert.equal(requests.length,2)
})
function claims(token: string, algorithm: 'ES256' | 'RS256') {
  const [header, payload, signature] = token.split('.') as [string, string, string]
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, algorithm)
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: algorithm === 'ES256' ? apple.publicKey : google.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')))
  return JSON.parse(Buffer.from(payload, 'base64url').toString())
}

test('APNs sends signed VoIP HTTP/2 requests with zero retention and opaque call references', async () => {
  const notification = push(), requests: any[] = []
  const sender = new PushSender(config, { fetch: noFetch, apns: async (origin, headers, body) => {
    requests.push({ origin, headers, body }); return { status: 200, body: null }
  } })
  assert.equal(await sender.send(notification), 'accepted')
  const { origin, headers, body } = requests[0]
  assert.equal(origin, 'https://api.sandbox.push.apple.com')
  assert.equal(headers[':path'], `/3/device/${notification.token}`)
  assert.equal(headers['apns-push-type'], 'voip'); assert.equal(headers['apns-expiration'], '0')
  assert.equal(headers['apns-priority'], '10'); assert.equal(headers['apns-topic'], config.SIPPER_APNS_TOPIC)
  assert.equal(headers['apns-id'], notification.notificationId)
  assert.equal(claims(headers.authorization.slice(7), 'ES256').iss, config.SIPPER_APNS_TEAM_ID)
  assert.deepEqual(JSON.parse(body), { aps: {}, sipper: { schemaVersion: 1, callId: notification.callId, deviceId: notification.deviceId, expiresAt: notification.expiresAt } })
  await sender.send(push()); assert.equal(requests[1].headers.authorization, headers.authorization, 'provider token is reused, not signed for every call')
})

test('APNs distinguishes invalid tokens, credentials, temporary failure and other rejections', async () => {
  for (const [status, reason, expected] of [[410, 'Unregistered', 'invalid_token'], [400, 'BadDeviceToken', 'invalid_token'],
    [400, 'DeviceTokenNotForTopic', 'credentials'], [403, 'InvalidProviderToken', 'credentials'], [503, 'ServiceUnavailable', 'retry'],
    [429, 'TooManyRequests', 'retry'], [400, 'BadPayload', 'rejected']] as const) {
    const sender = new PushSender(config, { fetch: noFetch, apns: async () => ({ status, body: { reason } }) })
    assert.equal(await sender.send(push()), expected)
  }
})

test('FCM exchanges a signed service assertion at a fixed origin and sends short-lived high-priority data', async () => {
  const requests: { url: string; options: RequestInit }[] = []
  const fetch: typeof globalThis.fetch = async (input, options = {}) => {
    const url = String(input); requests.push({ url, options })
    assert.equal(options.redirect, 'error'); assert.ok(options.signal)
    return url.endsWith('/token') ? Response.json({ access_token: 'fixture-access', expires_in: 3600, token_type: 'Bearer' }) : Response.json({ name: 'fixture-message' })
  }
  const sender = new PushSender(config, { fetch, apns: async () => { throw new Error('Unexpected APNs') } })
  const notification = push('fcm')
  assert.equal(await sender.send(notification), 'accepted')
  assert.equal(requests[0]!.url, 'https://oauth2.googleapis.com/token', 'service-account token_uri cannot redirect secrets')
  const assertion = new URLSearchParams(String(requests[0]!.options.body)).get('assertion')!
  const parsed = claims(assertion, 'RS256')
  assert.equal(parsed.scope, 'https://www.googleapis.com/auth/firebase.messaging'); assert.equal(parsed.exp - parsed.iat, 3600)
  assert.equal(requests[1]!.url, 'https://fcm.googleapis.com/v1/projects/sipper-fixture/messages:send')
  const body = JSON.parse(String(requests[1]!.options.body))
  assert.deepEqual(body.message.android, { priority: 'HIGH', ttl: '0s', restricted_package_name: config.SIPPER_ANDROID_PACKAGE })
  assert.deepEqual(body.message.data, { type: 'incoming_call', schemaVersion: '1', callId: notification.callId, deviceId: notification.deviceId, expiresAt: notification.expiresAt })
  await sender.send(push('fcm')); assert.equal(requests.length, 3, 'OAuth access token is reused until refresh is needed')
})

test('FCM only invalidates tokens for the specific unregistered-token response', async () => {
  for (const [status, body, expected] of [
    [404, { error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, 'invalid_token'],
    [404, { error: { message: 'Unknown project' } }, 'rejected'],
    [400, { error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }] } }, 'rejected'],
    [401, { error: {} }, 'credentials'], [429, { error: {} }, 'retry'], [503, { error: {} }, 'retry'],
  ] as const) {
    const sender = new PushSender(config, { fetch: async input => String(input).endsWith('/token')
      ? Response.json({ access_token: 'fixture-access', expires_in: 3600, token_type: 'Bearer' }) : Response.json(body, { status }),
    apns: async () => { throw new Error('Unexpected APNs') } })
    assert.equal(await sender.send(push('fcm')), expected)
  }
})

test('missing keys and expired calls never become successful delivery or cause network requests', async () => {
  const sender = new PushSender({ ...config, SIPPER_APNS_PRIVATE_KEY: '', SIPPER_FCM_SERVICE_ACCOUNT: '' }, { fetch: noFetch, apns: async () => { throw new Error('Unexpected APNs') } })
  assert.equal(await sender.send(push()), 'not_configured')
  assert.equal(await sender.send(push('fcm')), 'not_configured')
  assert.equal(await sender.send({ ...push(), expiresAt: new Date(Date.now() - 1).toISOString() }), 'rejected')
  const broken = new PushSender({ ...config, SIPPER_APNS_PRIVATE_KEY: 'not-a-key' }, { fetch: noFetch, apns: async () => { throw new Error('Unexpected APNs') } })
  assert.equal(await broken.send(push()), 'credentials')
})
