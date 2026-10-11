import { mkdir, writeFile } from 'node:fs/promises'
import { createVerifiedLocalUser, totp } from '../tests/auth-helper'
import { getConfig } from '../server/lib/config'
import { getPool } from '../server/lib/db'

if (getConfig().NODE_ENV !== 'development') throw new Error('Browser fixtures are restricted to local development')
const fixture = await createVerifiedLocalUser('Demo administrator')
const enabled = await fixture.client.call('/two-factor/enable', { password: fixture.password })
if (enabled.status !== 200) throw new Error('Local MFA setup failed')
const secret = new URL(enabled.data.totpURI).searchParams.get('secret')!
const verified = await fixture.client.call('/two-factor/verify-totp', { code: totp(secret) })
if (verified.status !== 200) throw new Error('Local MFA verification failed')
await mkdir('.data', { recursive: true })
await writeFile('.data/browser-fixture.json', JSON.stringify({ email: fixture.email, password: fixture.password, userId: fixture.userId, totpSecret: secret }), { mode: 0o600 })
console.log(`Verified local demo account created: ${fixture.email}`)
await getPool().end()
