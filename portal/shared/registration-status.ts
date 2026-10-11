export const REGISTRATION_FRESHNESS_MS = 3 * 60 * 1000
export function registrationState(report: { state: string; observedAt?: string; source?: string; ready?: boolean; readyUntil?: string | null } | undefined, revokedAt: string | null, now = Date.now()) {
  if (revokedAt) return { label: 'Revoked', color: 'neutral' as const }
  if (!report?.observedAt) return { label: 'Not reported', color: 'neutral' as const }
  const observed = new Date(report.observedAt).getTime()
  const gateway = report.source === 'gateway'
  if (!Number.isFinite(observed) || observed > now + 60_000 || now - observed > (gateway ? 45_000 : REGISTRATION_FRESHNESS_MS)
    || (gateway && (report.ready !== true || !(new Date(report.readyUntil ?? '').getTime() > now)))) return { label: 'Stale', color: 'warning' as const }
  if (report.state === 'registered') return { label: 'Registered', color: 'success' as const }
  if (report.state === 'failed') return { label: 'Failed', color: 'error' as const }
  if (report.state === 'unregistered') return { label: 'Unregistered', color: 'neutral' as const }
  return { label: 'Unknown', color: 'neutral' as const }
}
