import { randomUUID } from 'node:crypto'
import { writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rows } from './db'
import type { WorkerKind } from '../../shared/worker-status'

export function workerProgressFile(kind: WorkerKind, directory = tmpdir()) {
  return join(directory, `sipper-worker-${kind}.json`)
}

// One worker process per container. A completed queue poll, including an empty
// one, advances progress. A separate timer must never make a stuck poll healthy.
export async function trackWorkerProgress(kind: WorkerKind, directory = tmpdir()) {
  const id = randomUUID(), file = workerProgressFile(kind, directory), pending = `${file}.${id}`
  await rm(file, { force: true })
  await rows("DELETE FROM worker_progress WHERE coalesce(progressed_at,started_at)<now()-interval '24 hours'")
  const started = (await rows('INSERT INTO worker_progress (id,kind) VALUES ($1,$2) RETURNING started_at', [id,kind]))[0]!.started_at
  let lastWrite = -Infinity, stopped = false
  return {
    id,
    async progressed() {
      if (stopped || performance.now() - lastWrite < 15_000) return
      // A process returning after retention cleanup must become visible again.
      await rows(`INSERT INTO worker_progress (id,kind,started_at,progressed_at) VALUES ($1,$2,$3,now())
        ON CONFLICT (id) DO UPDATE SET progressed_at=now() WHERE worker_progress.stopped_at IS NULL`, [id,kind,started])
      await writeFile(pending, JSON.stringify({ kind, id, progressedAt: Date.now() }), { mode: 0o600 })
      await rename(pending, file)
      lastWrite = performance.now()
    },
    async stop() {
      stopped = true
      await rm(file, { force: true })
      await rm(pending, { force: true })
      await rows('UPDATE worker_progress SET stopped_at=now() WHERE id=$1', [id])
    },
  }
}
