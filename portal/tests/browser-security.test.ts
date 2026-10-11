import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { authenticEdge, contentSecurityPolicy, edgeClientIP, portalPermissions } from '../server/lib/browser-security'

test('edge credentials and client addresses do not accept missing secrets or forwarded chains', () => {
  const key = 'fictional-edge-credential-'.repeat(3)
  assert.equal(authenticEdge(key, key), true)
  for (const value of [undefined, '', `${key} `, 'x'.repeat(1024)]) assert.equal(authenticEdge(value, key), false)
  assert.equal(authenticEdge('', ''), false)
  assert.equal(edgeClientIP('192.0.2.10'), '192.0.2.10')
  assert.equal(edgeClientIP('2001:db8::12'), '2001:db8::12')
  for (const value of [undefined, '192.0.2.1,192.0.2.2', 'localhost', '192.0.2.1:443', ' 192.0.2.1']) assert.equal(edgeClientIP(value), null)
})

test('the portal CSP permits only its generated inline scripts and retains form/frame restrictions', () => {
  const bootstrap = 'window.__NUXT__={config:{}};', hash = createHash('sha256').update(bootstrap).digest('base64')
  const csp = contentSecurityPolicy([`<script>${bootstrap}</script><script src="/_nuxt/app.js"></script>`])
  assert.ok(csp.includes(`script-src 'self' 'sha256-${hash}'`))
  assert.ok(csp.includes("form-action 'self'")); assert.ok(csp.includes("frame-ancestors 'none'"))
  assert.ok(csp.includes("script-src-attr 'none'"))
  assert.ok(!csp.includes('unsafe-eval'))
  assert.ok(!csp.split(';').find(part => part.trim().startsWith('script-src '))?.includes('unsafe-inline'))
  assert.ok(!contentSecurityPolicy().includes('sha256-'))
})

test('meeting origins and capture permissions are scoped without weakening script, form or frame policy',()=>{
  const csp=contentSecurityPolicy([], 'wss://meet.example.invalid')
  assert.ok(csp.includes("connect-src 'self' wss://meet.example.invalid https://meet.example.invalid"))
  assert.ok(csp.includes("media-src 'self' blob:"))
  assert.ok(!csp.includes('unsafe-eval'));assert.ok(csp.includes("frame-ancestors 'none'"))
  for(const url of ['https://meet.example.invalid','wss://user:pass@meet.example.invalid','wss://meet.example.invalid/path','wss://meet.example.invalid?x=1','wss://meet.example.invalid#x'])assert.throws(()=>contentSecurityPolicy([],url))
  for(const path of ['/portal','/portal/messages','/portal/meeting/id/id'])assert.ok(portalPermissions(path).includes('microphone=(self)'))
  for(const path of ['/','/sign-in','/api/client','/portalish'])assert.ok(portalPermissions(path).includes('microphone=()'))
})
