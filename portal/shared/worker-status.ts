export type WorkerKind = 'email' | 'push' | 'meeting'
// Email can wait on SMTP; incoming pushes need a shorter progress window.
export const workerStaleAfter = { email: 180_000, push: 45_000, meeting:45_000 }
type Time = string | Date | null | undefined

export function workerStatus(worker: { kind: WorkerKind; started_at: Time; progressed_at: Time; stopped_at: Time }, now = Date.now()) {
  if (worker.stopped_at) return { label: 'Stopped', color: 'neutral' as const }
  const observed = new Date(worker.progressed_at ?? worker.started_at ?? '').getTime()
  if (!Number.isFinite(observed)) return { label: 'Not reported', color: 'neutral' as const }
  if (observed > now + 5000 || now - observed >= workerStaleAfter[worker.kind]) return { label: 'Stale', color: 'warning' as const }
  return worker.progressed_at ? { label: 'Polling', color: 'success' as const } : { label: 'Starting', color: 'neutral' as const }
}
