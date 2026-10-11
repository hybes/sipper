import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerStaleAfter, type WorkerKind } from '../shared/worker-status'

// No database credentials or network request are needed by the container check.
try {
  const kind = process.argv[2]
  if (kind !== 'email' && kind !== 'push' && kind !== 'meeting') throw new Error()
  const value = JSON.parse(await readFile(join(tmpdir(), `sipper-worker-${kind}.json`), 'utf8'))
  const age = Date.now() - value.progressedAt
  if (value.kind !== kind || typeof value.progressedAt !== 'number' || !Number.isFinite(age)
    || age < -5000 || age >= workerStaleAfter[kind as WorkerKind]) throw new Error()
} catch {
  console.error('Worker has no recent completed queue poll')
  process.exitCode = 1
}
