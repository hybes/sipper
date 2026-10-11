import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const database = process.env.SIPPER_TEST_DATABASE_URL ?? 'postgresql://sipper:sipper_local_only@127.0.0.1:5547/sipper_test'
if (!new URL(database).pathname.endsWith('_test')) throw new Error('Tests require a separate database whose name ends in _test')
const env = { ...process.env, DATABASE_URL: database, NODE_ENV: 'test', SIPPER_REQUIRE_ADMIN_MFA: 'true' }
if(process.argv[2] && process.argv[2]!=='--meetings')throw new Error('Unknown test selection')
const files=process.argv[2]==='--meetings' ? ['tests/integration/meetings.test.ts'] : readdirSync('tests').filter(f=>f.endsWith('.test.ts')).map(f=>`tests/${f}`)
for (const args of [
  ['--import', 'tsx', 'scripts/migrate.ts'],
  ['--import', 'tsx', '--test', '--test-concurrency=1', ...files],
]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
