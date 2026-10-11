import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getMigrations } from 'better-auth/db/migration'
import { authOptions } from '../server/lib/auth'
import { seedNativeClients } from '../server/lib/native-auth'
import { getPool } from '../server/lib/db'
import { createHash } from 'node:crypto'

const pool = getPool()
const db = await pool.connect()
try {
  await db.query("SELECT pg_advisory_lock(hashtext('sipper-schema'))")
  const authMigrations = await getMigrations(authOptions())
  await authMigrations.runMigrations()
  await db.query('CREATE TABLE IF NOT EXISTS sipper_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
  const directory = fileURLToPath(new URL('../server/db/', import.meta.url))
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
    const sql = await readFile(`${directory}/${name}`, 'utf8')
    const checksum = createHash('sha256').update(sql).digest('hex')
    const existing = await db.query('SELECT checksum FROM sipper_migrations WHERE name = $1', [name])
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration was edited: ${name}`)
      continue
    }
    await db.query('BEGIN')
    try {
      await db.query(sql)
      await db.query('INSERT INTO sipper_migrations (name, checksum) VALUES ($1, $2)', [name, checksum])
      await db.query('COMMIT')
      console.log(`Applied ${name}`)
    } catch (error) { await db.query('ROLLBACK'); throw error }
  }
  await seedNativeClients()
} finally {
  await db.query("SELECT pg_advisory_unlock(hashtext('sipper-schema'))")
  db.release()
  await pool.end()
}
