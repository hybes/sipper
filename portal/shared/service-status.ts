type Time = string | Date | null | undefined
function future(value: Time, now: number) { return value != null && new Date(value).getTime() > now }

export function gatewayStatus(node: { controller_expires_at: Time; ready_until: Time; last_heartbeat_at: Time }, now = Date.now()) {
  if (!node.last_heartbeat_at) return { label: 'Not reported', color: 'neutral' as const }
  if (!future(node.controller_expires_at, now)) return { label: 'Offline', color: 'warning' as const }
  // Both dates come from the same database clock. An explicit not-ready
  // heartbeat must stay not ready even if the browser clock is slightly behind.
  if (!node.ready_until || new Date(node.ready_until).getTime() <= new Date(node.last_heartbeat_at).getTime()) return { label: 'Not ready', color: 'warning' as const }
  return future(node.ready_until, now) ? { label: 'Ready', color: 'success' as const } : { label: 'Not ready', color: 'warning' as const }
}

export function gatewayCallStatus(call: { state: string; direction?: string; end_requested_at?: Time; expires_at: Time; claim_until: Time; controller_expires_at: Time; ready_until: Time; last_heartbeat_at?: Time }, now = Date.now()) {
  if (call.state === 'ended') return { label: 'Ended', color: 'neutral' as const }
  if (call.end_requested_at) return { label: 'End requested', color: 'warning' as const }
  if (['ringing', 'answering'].includes(call.state) && !future(call.expires_at, now)) return { label: 'Expired', color: 'neutral' as const }
  if (!future(call.controller_expires_at, now) || !future(call.ready_until, now)) return { label: 'Unconfirmed', color: 'warning' as const }
  if (call.last_heartbeat_at && new Date(call.ready_until!).getTime() <= new Date(call.last_heartbeat_at).getTime()) return { label: 'Unconfirmed', color: 'warning' as const }
  if (call.state === 'answered') return { label: 'Connected', color: 'success' as const }
  if (call.state === 'answering' && future(call.claim_until, now)) return { label: 'Answer pending', color: 'primary' as const }
  return { label: call.direction === 'outgoing' ? 'Dialling' : 'Ringing', color: 'primary' as const }
}

export type GatewayCallObservation = Parameters<typeof gatewayCallStatus>[0] & { id: string; device_id: string }
export function gatewayCallSummary(calls: GatewayCallObservation[], now = Date.now()) {
  const priority = ['Connected', 'End requested', 'Answer pending', 'Ringing', 'Dialling', 'Unconfirmed']
  const unique = new Map<string, ReturnType<typeof gatewayCallStatus>>()
  for (const call of calls) {
    const state = gatewayCallStatus(call, now), previous = unique.get(call.id)
    if (!priority.includes(state.label)) continue
    if (!previous || priority.indexOf(state.label) < priority.indexOf(previous.label)) unique.set(call.id, state)
  }
  const state = priority.map(label => [...unique.values()].find(state => state.label === label)).find(Boolean)
  return { label: state?.label === 'Connected' ? 'In a call' : state?.label ?? 'None reported', color: state?.color ?? 'neutral' as const, count: unique.size }
}

export type DirectCallCounts = { accountId: string; ringing: number; dialling: number; connected: number; held: number }
export type DirectCallObservation = { accounts: DirectCallCounts[]; observedAt: string; source: string; withdrawn?: boolean; confirmed?: boolean }
export function directCallSummary(reports: DirectCallObservation[], now = Date.now()) {
  const totals = { ringing: 0, dialling: 0, connected: 0, held: 0 }
  let stale = false
  for (const report of reports) {
    const at = Date.parse(report.observedAt)
    if (report.withdrawn || report.confirmed === false || report.source !== 'device' || !Number.isFinite(at) || at > now + 60_000 || now - at > 180_000) { stale = true; continue }
    for (const account of report.accounts) for (const key of ['ringing', 'dialling', 'connected', 'held'] as const) totals[key] += account[key]
  }
  const count = Object.values(totals).reduce((a, b) => a + b, 0)
  const label = totals.connected ? 'In a call' : totals.held ? 'On hold' : totals.ringing ? 'Ringing' : totals.dialling ? 'Dialling' : stale ? 'Unconfirmed' : reports.length ? 'No active calls reported' : 'Not reported'
  return { label, count, stale, color: count ? 'primary' as const : stale ? 'warning' as const : 'neutral' as const }
}

export function pushOutcomeLabel(value?: string | null) {
  return ({ accepted: 'Accepted by provider', invalid_token: 'Invalid token', credentials: 'Provider credentials rejected', retry: 'Retry requested', rejected: 'Rejected by provider', not_configured: 'Provider not configured' } as Record<string, string>)[value ?? ''] ?? 'Not recorded'
}

export function pushEndpointLabel(device: { platform?: string; revoked_at?: Time; push_provider?: string | null; push_disabled_at?: Time }) {
  if (!device.platform) return 'Not recorded'
  if (!['ios', 'android'].includes(device.platform)) return 'Not applicable'
  if (device.revoked_at) return 'Revoked'
  if (!device.push_provider) return 'No token'
  return device.push_disabled_at ? 'Disabled' : 'Token registered'
}
