import { getPool, transaction } from '../server/lib/db'

const email = process.argv[2]?.trim().toLowerCase()
if (!email || !email.includes('@')) throw new Error('Usage: pnpm owner:grant verified-owner@example.com')
try {
  await transaction(async db => {
    const { rows } = await db.query('SELECT id, "emailVerified", "twoFactorEnabled" FROM auth_user WHERE lower(email) = $1', [email])
    const user = rows[0]
    if (!user?.emailVerified || !user.twoFactorEnabled) throw new Error('Owner must already have a verified account and enabled MFA')
    await db.query('INSERT INTO platform_owners (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id])
    await db.query("INSERT INTO audit_events (actor_id, action, target_id) VALUES ($1, 'platform.owner.granted', $1)", [user.id])
  })
  console.log('Platform owner granted. No password or secret was changed.')
} finally { await getPool().end() }
