import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { authRequests, createVerifiedLocalUser, totp } from './auth-helper'
import { getPool } from '../server/lib/db'
import { sessionPrincipal } from '../server/lib/http'
import { createWorkspace } from '../server/lib/platform'

const ids: string[] = []
after(async () => { await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [ids]); await getPool().end() })
test('real email verification and MFA prevent old password-only sessions gaining administration', async () => {
  const fixture = await createVerifiedLocalUser(); ids.push(fixture.userId)
  const { client, email, password } = fixture
  const before = await sessionPrincipal(client.headers())
  assert.equal(before.verified, true); assert.equal(before.mfa, false)
  await assert.rejects(createWorkspace(before, { name: 'Blocked', kind: 'business' }), (e: any) => e.code === 'mfa_required')
  const oldBrowser = authRequests()
  assert.equal((await oldBrowser.call('/sign-in/email', { email, password })).status, 200)
  const enabled = await client.call('/two-factor/enable', { password })
  assert.equal(enabled.status, 200)
  const secret = new URL(enabled.data.totpURI).searchParams.get('secret')!
  assert.equal((await client.call('/two-factor/verify-totp', { code: totp(secret) })).status, 200)
  assert.equal((await sessionPrincipal(client.headers())).mfa, true)
  await assert.rejects(sessionPrincipal(oldBrowser.headers()), (e: any) => e.code === 'sign_in_required')
  const challenge = authRequests()
  const login = await challenge.call('/sign-in/email', { email, password })
  assert.equal(login.status, 200); assert.equal(login.data.twoFactorRedirect, true)
  await assert.rejects(sessionPrincipal(challenge.headers()), (e: any) => e.code === 'sign_in_required')
  assert.equal((await challenge.call('/two-factor/verify-backup-code', { code: enabled.data.backupCodes[0] })).status, 200)
  assert.equal((await sessionPrincipal(challenge.headers())).mfa, true)
  const replay = authRequests()
  await replay.call('/sign-in/email', { email, password })
  assert.equal((await replay.call('/two-factor/verify-backup-code', { code: enabled.data.backupCodes[0] })).status, 401)
})
