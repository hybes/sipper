export function statusLabel(value?: string | null) {
  if (!value) return 'Not recorded'
  const text = value.replaceAll('_', ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
export function platformLabel(value: string) {
  return ({ macos: 'macOS', ios: 'iOS', windows: 'Windows', android: 'Android' } as Record<string, string>)[value] ?? statusLabel(value)
}
export function activityDate(value?: string | null) {
  const date = value ? new Date(value) : null
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Not recorded'
}

export function activityAge(value: string | null | undefined, now = Date.now()) {
  const timestamp = value ? new Date(value).getTime() : NaN
  if (!Number.isFinite(timestamp)) return 'Not recorded'
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  const days = Math.floor(minutes / 1440)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

export function provisioningState(person: { user_id: string | null; active: boolean; controls_membership: boolean; membership_conflict: boolean; membership_status: string | null }) {
  if (person.membership_conflict || (person.user_id && !person.controls_membership)) return { label: 'Needs attention', color: 'warning' as const, detail: person.membership_status === 'removed' ? 'Removed in Sipper' : 'Membership managed in Sipper' }
  if (!person.active) return { label: 'Suspended', color: 'neutral' as const, detail: person.user_id ? 'Customer access paused' : 'Joining is paused' }
  return person.user_id ? { label: 'Active', color: 'success' as const, detail: 'Joined customer' } : { label: 'Pending', color: 'neutral' as const, detail: 'Awaiting verified sign-in' }
}
