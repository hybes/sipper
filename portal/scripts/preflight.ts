import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { getPool } from '../server/lib/db'
import { getConfig } from '../server/lib/config'
import { sealSecret, openSecret } from '../server/lib/crypto'

// Container startup checks the exact schema bundled in this image before serving
// requests or processing jobs. Migrations remain an explicit, separate command.
try {
  getConfig()
  const probe = randomBytes(32).toString('base64')
  if (openSecret(sealSecret(probe, 'startup'), 'startup') !== probe) throw new Error('Encryption check failed')
  const directory = new URL('../server/db/', import.meta.url)
  const expected = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).map(async name => ({
    name, checksum: createHash('sha256').update(await readFile(new URL(name, directory))).digest('hex'),
  })))
  const actual = (await getPool().query<{ name: string; checksum: string }>('SELECT name,checksum FROM sipper_migrations')).rows
  if (actual.length !== expected.length || expected.some(migration => !actual.some(row => row.name === migration.name && row.checksum === migration.checksum))) {
    throw new Error('Schema does not match this image')
  }
  const recovery = (await getPool().query('SELECT restored_at,released_at FROM service_recovery WHERE singleton')).rows
  if (recovery.length !== 1) throw new Error('Recovery state missing')
  if (recovery[0].restored_at && !recovery[0].released_at) {
    console.error('Database recovery hold is active. Complete the restore reconciliation and release procedure before starting services.')
    throw new Error('Recovery hold')
  }
  console.log('Configuration, encryption and schema checks passed')
} catch {
  // Database drivers and secret parsers can echo values: keep container logs safe.
  console.error('Startup checks failed. Check configuration, encryption keys, database access and migrations for this image.')
  process.exitCode = 1
} finally {
  // A configuration error may prevent the pool being created in the first place.
  try { await getPool().end() } catch { /* already reported above */ }
}
