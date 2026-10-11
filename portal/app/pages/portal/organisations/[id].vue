<script setup lang="ts">
import { registrationState } from '~~/shared/registration-status'
import { pushEndpointLabel } from '~~/shared/service-status'
import { sortRows, type SortDirection } from '~~/shared/table-sort'
import { BULK_LIMIT, type BulkResult } from '~~/shared/bulk'
definePageMeta({ layout: 'portal', middleware: 'auth' })
const route = useRoute(), id = String(route.params.id), base = `/api/platform/organisations/${id}`
const { data, error: loadError, refresh, status: fetchStatus } = await useFetch<any>(base)
const { data: overview } = await useFetch<any>('/api/platform/overview')
const { busy, error, action } = usePortal()
const loadMessage = computed(() => (loadError.value?.data as { message?: string } | undefined)?.message)
const tab = ref('people'), search = ref(''), inviteOpen = ref(false), configOpen = ref(false), groupOpen = ref(false)
const statusFilter = ref('current'), personFilter = ref('all'), autoRefresh = ref(true), refreshInterval = ref(30), importOpen = ref(false)
const page = ref(1), pageSize = ref(25)
const sort = reactive<Record<string, { key: string; direction: SortDirection }>>({
  people: { key: 'name', direction: 'ascending' },
  devices: { key: 'last_request_at', direction: 'descending' },
  registrations: { key: 'observedAt', direction: 'descending' },
  accounts: { key: 'label', direction: 'ascending' },
  groups: { key: 'name', direction: 'ascending' },
  invitations: { key: 'expires_at', direction: 'descending' },
})
function sortDirection(key: string) { return sort[tab.value]?.key === key ? sort[tab.value]?.direction : undefined }
function sortBy(key: string) {
  sort[tab.value] = { key, direction: sortDirection(key) === 'descending' || (!sortDirection(key) && ['name', 'status', 'label', 'email'].includes(key)) ? 'ascending' : 'descending' }
  page.value = 1
}
function ordered<T extends Record<string, any>>(rows: T[], section: string) {
  const selection = sort[section]!
  return sortRows(rows, row => {
    if (selection.key === 'name') return row.name ?? row.account?.label
    if (selection.key === 'status') return typeof row.status === 'string' ? statusLabel(row.status) : row.status.label
    if (['label', 'email'].includes(selection.key)) return row[selection.key]
    const date = selection.key === 'observedAt' ? row.report?.observedAt : (row.device ?? row)[selection.key]
    return date ? new Date(date).getTime() : null
  }, selection.direction)
}
const statusOptions = computed(() => {
  const labels = ({ people: ['Active', 'Suspended', 'Removed'], devices: ['Enrolled', 'Revoked'], accounts: ['Registered', 'Failed', 'Unregistered', 'Stale', 'Not reported', 'Direct SIP'], registrations: ['Registered', 'Failed', 'Unregistered', 'Stale', 'Not reported', 'Unknown', 'Unassigned', 'Revoked'] } as Record<string, string[]>)[tab.value]
  return labels ? [...(tab.value === 'people' ? [{ label: 'Current people', value: 'current' }] : []), { label: 'All statuses', value: 'all' }, ...labels.map(label => ({ label, value: label }))] : []
})
const hasStatus = (status: string) => statusFilter.value === 'all' || (statusFilter.value === 'current' ? status !== 'Removed' : statusFilter.value === status)
const inviteEmail = ref(''), inviteRole = ref('user'), editingConfig = ref<string | null>(null), editingGroup = ref<string | null>(null)
const groupName = ref(''), groupUsers = ref<string[]>([]), groupConfigs = ref<string[]>([])
const groupCreationId = ref(''), groupRevision = ref(''), editingScimGroup = ref(false)
let groupEditor = 0
const confirmation = ref<{ title: string; description: string; execute: () => Promise<void> } | null>(null)
const confirmationOpen = computed({ get: () => Boolean(confirmation.value), set: value => { if (!value) confirmation.value = null } })
const tabs = [{ value: 'people', label: 'People', icon: 'i-lucide-users' }, { value: 'accounts', label: 'Calling accounts', icon: 'i-lucide-phone' }, { value: 'registrations', label: 'Registrations', icon: 'i-lucide-radio' }, { value: 'groups', label: 'Groups', icon: 'i-lucide-folder' }, { value: 'devices', label: 'Devices', icon: 'i-lucide-monitor-smartphone' }, { value: 'invitations', label: 'Invitations', icon: 'i-lucide-mail' }]
const canManage = computed(() => !loadError.value && data.value?.permissions?.manage === true)
const hasWorkspace = computed(() => overview.value?.platformOwner || overview.value?.workspaces.some((w: any) => w.id === data.value?.organisation.workspace_id))
const canBill = computed(() => overview.value?.platformOwner || overview.value?.workspaces.some((w: any) => w.id === data.value?.organisation.workspace_id && ['owner', 'admin'].includes(w.role)))
const currentPeople = computed(() => data.value?.members.filter((member: any) => member.status !== 'removed') ?? [])
const people = computed(() => ordered(data.value?.members.filter((m: any) => matches(m.name, m.email, m.last_request_ip) && hasStatus(statusLabel(m.status))) ?? [], 'people'))
const configOptions = computed(() => data.value?.configurations.map((c: any) => ({ label: c.label, value: c.id })) ?? [])
const userOptions = computed(() => data.value?.members.filter((m: any) => m.status !== 'removed').map((m: any) => ({ label: `${m.name} · ${m.email}`, value: m.user_id })) ?? [])
const emptyConfig = () => ({ label: '', mode: 'direct', password: '', settings: { username: '', authUsername: '', domain: '', server: '', port: null as number | null, transport: 'tls', srtp: 'required', displayName: '', voicemailNumber: '*97', useICE: true, stunServer: '' } })
const config = ref(emptyConfig())
const configRevision = ref<number | null>(null)
let configEditor = 0
watch(configOpen, open => { if (!open) { configEditor++; config.value.password = '' } })
function assignments(userId: string) { return data.value?.assignments.filter((a: any) => a.user_id === userId).map((a: any) => data.value.configurations.find((c: any) => c.id === a.configuration_id)).filter(Boolean) ?? [] }
function personName(userId: string) { return data.value?.members.find((m: any) => m.user_id === userId)?.name ?? 'Unknown user' }
const now = ref(Date.now()), refreshedAt = ref(new Date().toISOString())
let clock: ReturnType<typeof setInterval> | undefined, refreshTimer: ReturnType<typeof setInterval> | undefined
function scheduleRefresh() { clearInterval(refreshTimer); refreshTimer = setInterval(refreshVisible, refreshInterval.value * 1000) }
watch(refreshInterval, scheduleRefresh)
function refreshVisible() {
  if (autoRefresh.value && document.visibilityState === 'visible' && !busy.value && !configOpen.value && !groupOpen.value && !inviteOpen.value) void refresh({ dedupe: 'defer' })
}
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now() }, 15_000)
  scheduleRefresh()
  document.addEventListener('visibilitychange', refreshVisible)
})
onUnmounted(() => {
  clearInterval(clock)
  clearInterval(refreshTimer)
  document.removeEventListener('visibilitychange', refreshVisible)
})
watch(data, () => { refreshedAt.value = new Date().toISOString() })
watch(tab, () => { search.value = ''; statusFilter.value = tab.value === 'people' ? 'current' : 'all'; personFilter.value = 'all' }, { flush: 'sync' })
const matches = (...values: unknown[]) => values.join(' ').toLowerCase().includes(search.value.toLowerCase())
const enrolledDevices = computed(() => data.value?.devices.filter((d: any) => !d.revoked_at) ?? [])
function deviceCalls(deviceId: string) { return (data.value?.activeCalls ?? []).filter((call: any) => call.device_id === deviceId) }
function personCalls(userId: string) {
  const devices = new Set(userDevices(userId).map((device: any) => device.id))
  return (data.value?.activeCalls ?? []).filter((call: any) => devices.has(call.device_id))
}
function userDevices(userId: string) { return data.value?.devices.filter((d: any) => d.user_id === userId) ?? [] }
function directReports(devices: any[]) {
  return devices.flatMap(device => {
    const report = device.status.directCalls
    if (!report) return []
    const current = new Set(effectiveAccounts(device.user_id).filter((account: any) => account.mode === 'direct').map((account: any) => account.id))
    const accounts = report.accounts.filter((account: any) => current.has(account.accountId))
    if (!accounts.length) return []
    const member = data.value?.members.find((person: any) => person.user_id === device.user_id)
    return [{ ...report, accounts, withdrawn: Boolean(device.revoked_at || member?.status !== 'active' || !member?.licensed) }]
  })
}
function hasGatewayAccounts(userId: string) { return effectiveAccounts(userId).some((account: any) => account.mode === 'gateway') }
function hasDirectAccounts(userId: string) { return effectiveAccounts(userId).some((account: any) => account.mode === 'direct') }
function personGroups(userId: string) { return data.value?.groups.filter((g: any) => g.user_ids.includes(userId)) ?? [] }
function effectiveAccounts(userId: string) {
  const ids = new Set([...assignments(userId).map((c: any) => c.id), ...personGroups(userId).flatMap((g: any) => g.configuration_ids)])
  return data.value?.configurations.filter((c: any) => ids.has(c.id)) ?? []
}
function availableAccounts(userId: string) { return configOptions.value.filter((c: any) => !assignments(userId).some((a: any) => a.id === c.value)) }
const registrations = computed(() => (data.value?.devices ?? []).flatMap((device: any) => {
  const reports = device.status.registrations ?? []
  const accounts = effectiveAccounts(device.user_id)
  const removed = reports.filter((r: any) => !accounts.some((c: any) => c.id === r.accountId)).map((r: any) => ({ id: r.accountId, label: 'Previously assigned account' }))
  return [...accounts, ...removed].map((account: any) => {
    const appReport = reports.find((r: any) => r.accountId === account.id)
    const gateway = account.mode === 'gateway'
    const report = gateway ? { ...data.value?.gatewayRegistrations?.find((r: any) => r.device_id === device.id && r.configuration_id === account.id), source: 'gateway' } : appReport
    return { key: `${device.id}:${account.id}`, device, account, report, appReport, source: gateway ? 'Gateway observed' : 'App reported', ip: gateway ? report.ip : device.last_request_ip, status: device.revoked_at || account.settings ? registrationState(report, device.revoked_at, now.value) : { label: 'Unassigned', color: 'neutral' as const } }
  })
}))
function deviceRegistrations(id: string) { return registrations.value.filter((r: any) => r.device.id === id) }
function registeredCount(id: string) { return deviceRegistrations(id).filter((r: any) => r.status.label === 'Registered').length }
function personRegistrations(userId: string) { return registrations.value.filter((r: any) => r.device.user_id === userId && !r.device.revoked_at && r.account.settings) }
function personRegisteredCount(userId: string) { return personRegistrations(userId).filter((r: any) => r.status.label === 'Registered').length }
const personFilterOptions = computed(() => [{ label: 'All people', value: 'all' }, ...(data.value?.members ?? []).map((m: any) => ({ label: m.name, value: m.user_id }))])
const hasPerson = (userId: string) => personFilter.value === 'all' || personFilter.value === userId
function showPersonActivity(userId: string, section: 'registrations' | 'devices') {
  tab.value = section
  search.value = ''
  statusFilter.value = 'all'
  personFilter.value = userId
  selectedPersonId.value = null
}
const filteredRegistrations = computed(() => ordered(registrations.value.filter((r: any) => hasPerson(r.device.user_id) && hasStatus(r.status.label) && matches(r.account.label, r.account.settings?.username, r.account.settings?.server, r.account.settings?.domain, r.device.name, personName(r.device.user_id), r.status.label, r.ip, r.source, r.report?.sipCode)), 'registrations'))
const filteredDevices = computed(() => ordered(data.value?.devices.filter((d: any) => hasPerson(d.user_id) && hasStatus(d.revoked_at ? 'Revoked' : 'Enrolled') && matches(d.name, personName(d.user_id), platformLabel(d.platform), d.last_request_ip, d.revoked_at ? 'Revoked' : 'Enrolled')) ?? [], 'devices'))
const upstreamReports = computed(() => new Map<string, any>((data.value?.upstreamRegistrations ?? []).map((report: any) => [report.configuration_id, report])))
const filteredConfigurations = computed(() => ordered((data.value?.configurations ?? []).map((c: any) => {
  const report = upstreamReports.value.get(c.id)
  return { ...c, report, status: c.mode === 'gateway' ? registrationState(report, null, now.value) : { label: 'Direct SIP', color: 'neutral' as const } }
}).filter((c: any) => hasStatus(c.status.label) && matches(c.label, c.settings.username, c.settings.domain, c.settings.server, c.status.label)), 'accounts'))
const filteredGroups = computed(() => ordered(data.value?.groups.filter((g: any) => matches(g.name)) ?? [], 'groups'))
const filteredInvitations = computed(() => ordered(data.value?.invitations.filter((i: any) => matches(i.email, i.role)) ?? [], 'invitations'))
const rowCount = computed(() => ({ people: people.value, devices: filteredDevices.value, accounts: filteredConfigurations.value, groups: filteredGroups.value, invitations: filteredInvitations.value, registrations: filteredRegistrations.value } as Record<string, any[]>)[tab.value]?.length ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(rowCount.value / pageSize.value)))
watch([tab, search, statusFilter, personFilter, pageSize], () => { page.value = 1 })
watch(pageCount, value => { page.value = Math.min(page.value, value) })
function visibleRows<T>(rows: T[]) { return rows.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) }
const selectedPersonId = ref<string | null>(null), selectedDeviceId = ref<string | null>(null)
const selectedPerson = computed(() => !loadError.value && data.value?.members.find((m: any) => m.user_id === selectedPersonId.value))
const selectedDevice = computed(() => !loadError.value && data.value?.devices.find((d: any) => d.id === selectedDeviceId.value))
const personOpen = computed({ get: () => Boolean(selectedPerson.value), set: value => { if (!value) selectedPersonId.value = null } })
const deviceOpen = computed({ get: () => Boolean(selectedDevice.value), set: value => { if (!value) selectedDeviceId.value = null } })
const selectedIds = ref<string[]>([]), bulkOperation = ref('suspend'), bulkAccount = ref('')
const bulkResults = ref<Array<BulkResult['results'][number] & { name: string }>>([])
const bulkResultLabel = ref('')
const bulkOptions = computed(() => [
  { label: 'Suspend people', value: 'suspend' }, { label: 'Resume people', value: 'resume' },
  { label: 'Assign calling account', value: 'assign_account' },
  ...(canBill.value ? [{ label: 'Assign licences', value: 'assign_seat' }, { label: 'Release licences', value: 'release_seat' }] : []),
])
const pageSelection = computed<boolean | 'indeterminate'>({
  get: () => {
    const ids = visibleRows(people.value).filter((person: any) => person.status !== 'removed').map((person: any) => person.user_id)
    const count = ids.filter((id: string) => selectedIds.value.includes(id)).length
    return count && count === ids.length ? true : count ? 'indeterminate' : false
  },
  set: value => {
    const ids = visibleRows(people.value).filter((person: any) => person.status !== 'removed').map((person: any) => person.user_id)
    selectedIds.value = value === true ? [...new Set([...selectedIds.value, ...ids])].slice(0, BULK_LIMIT) : selectedIds.value.filter(id => !ids.includes(id))
  },
})
function selectPerson(id: string, value: boolean | 'indeterminate') {
  selectedIds.value = value === true ? [...new Set([...selectedIds.value, id])].slice(0, BULK_LIMIT) : selectedIds.value.filter(selected => selected !== id)
}
watch([tab, search, statusFilter], () => { selectedIds.value = []; bulkResults.value = [] })
watch(data, () => { selectedIds.value = selectedIds.value.filter(id => data.value?.members.some((person: any) => person.user_id === id && person.status !== 'removed')) })
const releaseLicenceDescription = 'Managed access will stop across this workspace, including other customers and devices. Your subscription quantity will stay the same.'
function confirmBulk() {
  const ids = [...selectedIds.value], operation = bulkOperation.value, configurationId = bulkAccount.value
  const labels = ids.map(personName)
  const label = bulkOptions.value.find(item => item.value === operation)?.label ?? 'Update people'
  const description = operation === 'release_seat' ? releaseLicenceDescription
    : operation === 'suspend' ? 'Managed access to this customer will be suspended. Licences and billing stay the same. Revoke direct SIP credentials at the phone system for immediate enforcement.'
    : operation === 'assign_seat' ? 'Each person uses one licence across this workspace. If capacity runs out, successful assignments are kept and the remaining people are listed.'
    : operation === 'assign_account' ? `“${configOptions.value.find((account: any) => account.value === configurationId)?.label ?? 'Selected calling account'}” will be assigned to these people on their next managed settings refresh.`
    : 'Managed access to this customer will resume for people with a valid licence.'
  confirm(`${label} (${ids.length})?`, description, async () => {
    const response = await action(() => $fetch<BulkResult>(`${base}/bulk`, { method: 'POST', body: { action: operation, userIds: ids, ...(operation === 'assign_account' ? { configurationId } : {}) } }))
    if (response) {
      bulkResultLabel.value = label
      bulkResults.value = response.results.map(row => ({ ...row, name: labels[row.index] ?? 'Person' }))
      selectedIds.value = response.results.filter(row => !row.ok).map(row => ids[row.index]!)
      if (operation === 'suspend' && !canBill.value && response.results.some(row => row.ok && ids[row.index] === overview.value?.user.id)) await navigateTo('/portal')
      else await refresh()
    }
  })
}
function dateLabel(date?: string | null) { return date ? new Date(date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' }) : 'Not recorded' }
function requestLabel(action?: string) { return ({ enrolment: 'Device enrolment', configuration: 'Configuration request', report: 'Device report', sign_out: 'Sign out', push_token: 'Push token update', call: 'Call activity', directory: 'Directory request', messages: 'Messages request', meetings: 'Meeting request' } as Record<string, string>)[action ?? ''] ?? 'Not recorded' }
function changeSeat(member: any) {
  if (member.licensed) confirm('Release this licence?', releaseLicenceDescription, async () => { await seat(member) })
  else seat(member)
}
function changeStatus(member: any) {
  confirm(member.status === 'active' ? 'Suspend this person?' : 'Resume this person?', member.status === 'active' ? 'Managed access will be suspended. Their licence and bill stay the same. Revoke direct SIP credentials at the phone system for immediate enforcement.' : 'Their assigned managed accounts will become available again if they have a valid licence.', async () => {
    const status = member.status === 'active' ? 'suspended' : 'active'
    const result = await action(() => $fetch(`${base}/members/${member.user_id}/status`, { method: 'PATCH', body: { status } }))
    if (!result) return
    if (status === 'suspended' && member.user_id === overview.value?.user.id && !canBill.value) await navigateTo('/portal')
    else await refresh()
  })
}
function revokeSelectedDevice(device: any) {
  confirm('Revoke this device?', 'This installation will stop receiving managed settings. Revoke direct SIP credentials at the phone system for immediate enforcement.', async () => { await mutate(`${base}/devices/${device.id}`, 'DELETE') })
}
async function mutate(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown = {}, success?: string) { const result = await action(() => $fetch<any>(path, { method, ...(method === 'DELETE' ? {} : { body: body as Record<string, unknown> }) }), success); if (result) await refresh(); return result }
function reinvitePerson(member: any) { inviteEmail.value = member.email; inviteRole.value = 'user'; selectedPersonId.value = null; inviteOpen.value = true }
async function invite() { if (await mutate(`${base}/invitations`, 'POST', { email: inviteEmail.value, role: inviteRole.value }, 'Invitation queued')) { inviteOpen.value = false; inviteEmail.value = '' } }
async function seat(member: any) { await mutate(`/api/platform/workspaces/${data.value.organisation.workspace_id}/seats/${member.user_id}`, member.licensed ? 'DELETE' : 'PUT', {}, member.licensed ? 'Licence released' : 'Licence assigned') }
function confirm(title: string, description: string, execute: () => Promise<void>) { confirmation.value = { title, description, execute } }
async function confirmAction() { const task = confirmation.value; if (task) { await task.execute(); confirmation.value = null } }
function editConfiguration(item?: any) { configEditor++; error.value = ''; editingConfig.value = item?.id ?? null; configRevision.value = item?.revision ?? null; config.value = item ? { label: item.label, mode: item.mode, settings: { ...item.settings }, password: '' } : emptyConfig(); configOpen.value = true }
async function saveConfiguration() {
  const editor = configEditor, value: any = { ...config.value, settings: { ...config.value.settings } }
  if (editingConfig.value) { value.revision = configRevision.value; if (!value.password) delete value.password }
  if (await mutate(editingConfig.value ? `${base}/configurations/${editingConfig.value}` : `${base}/configurations`, editingConfig.value ? 'PATCH' : 'POST', value, 'Calling account saved') && editor === configEditor) configOpen.value = false
}
async function reloadConfiguration() {
  const editor = configEditor, configurationId = editingConfig.value
  await refresh()
  if (editor !== configEditor || loadError.value) return
  const item = data.value?.configurations.find((account: any) => account.id === configurationId)
  if (item) editConfiguration(item)
  else error.value = 'This calling account is no longer available. Close this form and reload the customer.'
}
function editGroup(item?: any) { groupEditor++; error.value = ''; editingGroup.value = item?.id ?? null; groupCreationId.value = item?.id ?? crypto.randomUUID(); groupRevision.value = item?.revision ?? ''; editingScimGroup.value = Boolean(item?.scim_managed); groupName.value = item?.name ?? ''; groupUsers.value = [...(item?.user_ids ?? [])]; groupConfigs.value = [...(item?.configuration_ids ?? [])]; groupOpen.value = true }
async function saveGroup() {
  const editor = groupEditor
  const value = { configurationIds: [...groupConfigs.value], ...(!editingScimGroup.value ? { name: groupName.value, userIds: [...groupUsers.value] } : {}) }
  if (await mutate(editingGroup.value ? `${base}/groups/${editingGroup.value}` : `${base}/groups`, editingGroup.value ? 'PATCH' : 'POST',
    { ...value, ...(editingGroup.value ? { revision: groupRevision.value } : { id: groupCreationId.value }) }, 'Group saved') && editor === groupEditor) groupOpen.value = false
}
async function reloadGroup() {
  await refresh()
  if (loadError.value) return
  const item = data.value?.groups.find((group: any) => group.id === (editingGroup.value ?? groupCreationId.value))
  if (item) editGroup(item)
  else error.value = 'No saved group was found. Review the details and retry, or close this form.'
}

</script>
<template>
  <UButton :to="hasWorkspace && data ? `/portal/workspaces/${data.organisation.workspace_id}` : '/portal'" icon="i-lucide-arrow-left" variant="link" color="neutral" class="mb-4 -ml-2">{{ hasWorkspace ? 'Workspace' : 'Home' }}</UButton>
  <UAlert v-if="loadError" color="error" :title="loadMessage ?? 'Could not load this customer'" :actions="[{ label: 'Try again', onClick: () => refresh() }]" />
  <template v-if="data && !loadError">
    <div class="page-heading sm:flex-col sm:items-start xl:flex-row xl:items-center">
      <div class="min-w-0"><h1 class="page-title">{{ data.organisation.name }}</h1><p class="page-description">{{ canManage ? 'Manage people, calling accounts and devices.' : 'Read-only support access to people, calling accounts and devices.' }}</p></div>
      <div class="flex flex-wrap gap-2"><UButton v-if="canManage" :to="`/portal/directory/${id}`" variant="outline" color="neutral">Directory</UButton><UButton :to="`/portal/calls/${id}`" icon="i-lucide-phone-incoming" variant="outline" color="neutral">Call activity</UButton><UDropdownMenu :items="[{ label: 'Meeting activity', to: `/portal/meetings/${id}` }, ...(canManage ? [{ label: 'Company sign-in', to: `/portal/company-sign-in/${id}` }, { label: 'User provisioning', to: `/portal/provisioning/${id}` }, { label: 'Import CSV', onSelect: () => { importOpen = true } }] : [])]"><UButton trailing-icon="i-lucide-chevron-down" variant="outline" color="neutral">More</UButton></UDropdownMenu><UButton icon="i-lucide-refresh-cw" variant="outline" color="neutral" :loading="fetchStatus === 'pending'" @click="refresh()">Refresh</UButton><UButton v-if="canManage" icon="i-lucide-user-round-plus" @click="inviteOpen = true">Invite person</UButton></div>
    </div>
    <div class="my-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
      <span><strong class="font-semibold text-highlighted">{{ currentPeople.length }}</strong> {{ currentPeople.length === 1 ? 'person' : 'people' }}</span>
      <span><strong class="font-semibold text-highlighted">{{ currentPeople.filter((m: any) => m.licensed).length }}</strong> licensed</span>
      <button class="hover:text-primary hover:underline" @click="tab = 'devices'; personFilter = 'all'; statusFilter = 'all'; search = ''"><strong class="font-semibold text-highlighted">{{ enrolledDevices.length }}</strong> {{ enrolledDevices.length === 1 ? 'device' : 'devices' }}</button>
      <button class="hover:text-primary hover:underline" @click="tab = 'registrations'; personFilter = 'all'; statusFilter = 'all'; search = ''"><strong class="font-semibold text-highlighted">{{ registrations.filter((r: any) => r.status.label === 'Registered').length }}</strong> registered</button>
    </div>
    <nav aria-label="Customer sections" class="mb-5 border-b border-default">
      <div class="hidden gap-1 md:flex"><button v-for="item in tabs" :key="item.value" :aria-current="tab === item.value ? 'page' : undefined" class="flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors" :class="tab === item.value ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-highlighted'" @click="tab = item.value"><UIcon :name="item.icon" class="hidden size-4 lg:block" />{{ item.label }}</button></div>
      <USelect v-model="tab" :items="tabs" aria-label="Customer section" class="mb-4 w-full md:hidden" />
    </nav>
    <div class="section-toolbar">
      <div class="flex w-full flex-wrap gap-2 sm:w-auto">
        <UInput v-model="search" icon="i-lucide-search" :placeholder="`Search ${tabs.find(t => t.value === tab)?.label.toLowerCase()}…`" :aria-label="`Search ${tab}`" class="w-full sm:w-64" />
        <USelect v-if="statusOptions.length" v-model="statusFilter" :items="statusOptions" aria-label="Filter by status" class="w-full sm:w-40" />
        <USelect v-if="['devices', 'registrations'].includes(tab)" v-model="personFilter" :items="personFilterOptions" aria-label="Filter by person" class="w-full sm:w-48" />
      </div>
      <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
        <p class="text-xs text-muted" role="status">{{ rowCount }} {{ rowCount === 1 ? 'result' : 'results' }}<span class="hidden sm:inline" :title="dateLabel(refreshedAt)"> · Updated {{ activityAge(refreshedAt, now) }}</span></p>
        <UCheckbox v-model="autoRefresh" label="Auto-refresh" :ui="{ label: 'text-xs text-muted' }" />
        <USelect v-model="refreshInterval" :items="[{ label: 'Every 30s', value: 30 }, { label: 'Every 5s', value: 5 }]" aria-label="Refresh interval" :disabled="!autoRefresh" size="sm" class="w-28" />
      </div>
    </div>
    <p class="mb-2 text-xs text-muted xl:hidden">Scroll sideways for more columns. Select a name for details.</p>

    <div v-if="canManage && tab === 'people' && selectedIds.length" class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-default bg-muted p-3" aria-label="Bulk people actions">
      <span class="text-sm font-medium" role="status">{{ selectedIds.length }} selected</span>
      <USelect v-model="bulkOperation" :items="bulkOptions" aria-label="Bulk action" :disabled="busy" class="w-full sm:w-52" :ui="{ base: 'min-h-11 sm:min-h-0', item: 'min-h-11 sm:min-h-0' }" />
      <USelect v-if="bulkOperation === 'assign_account'" v-model="bulkAccount" :items="configOptions" placeholder="Choose calling account" aria-label="Bulk calling account" :disabled="busy" class="w-full sm:w-60" :ui="{ base: 'min-h-11 sm:min-h-0', item: 'min-h-11 sm:min-h-0' }" />
      <UButton :loading="busy" class="min-h-11 sm:min-h-0" :disabled="bulkOperation === 'assign_account' && !bulkAccount" @click="confirmBulk">Apply to selected</UButton>
      <UButton variant="ghost" color="neutral" class="min-h-11 sm:min-h-0" :disabled="busy" @click="selectedIds = []">Clear selection</UButton>
      <span v-if="selectedIds.length === BULK_LIMIT" class="text-xs text-muted">Maximum {{ BULK_LIMIT }} per batch</span>
    </div>
    <div v-if="bulkResults.length" class="mb-4 rounded-lg border border-default p-4" aria-live="polite">
      <div class="flex items-center justify-between gap-3"><p class="text-sm font-medium">{{ bulkResultLabel }}: {{ bulkResults.filter(row => row.ok).length }} updated · {{ bulkResults.filter(row => !row.ok).length }} not updated</p><UButton icon="i-lucide-x" aria-label="Dismiss bulk results" variant="ghost" color="neutral" size="sm" class="size-11 sm:size-auto shrink-0" @click="bulkResults = []" /></div>
      <ul v-if="bulkResults.some(row => !row.ok)" class="mt-3 space-y-2 text-sm"><li v-for="row in bulkResults.filter(row => !row.ok)" :key="row.index"><strong class="font-medium">{{ row.name }}</strong> · {{ row.message }}</li></ul>
    </div>

    <section v-if="tab === 'people'" aria-label="People" class="table-panel">
      <div class="table-scroll" tabindex="0" aria-label="People table, scroll for more columns"><table class="management-table min-w-[1190px]" :class="{ 'has-selection': canManage }">
        <caption class="sr-only">People and managed app activity</caption>
        <thead><tr><th v-if="canManage" scope="col"><UCheckbox v-model="pageSelection" aria-label="Select people on this page" :disabled="busy || !visibleRows(people).some((person: any) => person.status !== 'removed')" /></th><ManagementSortHeader label="Person" :direction="sortDirection('name')" @sort="sortBy('name')" /><ManagementSortHeader label="Status" :direction="sortDirection('status')" @sort="sortBy('status')" /><th scope="col">Accounts / Devices</th><th scope="col">Registrations</th><th scope="col">Availability / Calls</th><ManagementSortHeader label="Last login" :direction="sortDirection('last_login_at')" @sort="sortBy('last_login_at')" /><ManagementSortHeader label="Last request" :direction="sortDirection('last_request_at')" @sort="sortBy('last_request_at')" /><th scope="col">IP address</th><th scope="col"><span class="sr-only">Details</span></th></tr></thead>
        <tbody><tr v-for="member in visibleRows(people)" :key="member.user_id">
          <td v-if="canManage"><UCheckbox :model-value="selectedIds.includes(member.user_id)" :aria-label="`Select ${member.name}`" :disabled="busy || member.status === 'removed' || (selectedIds.length >= BULK_LIMIT && !selectedIds.includes(member.user_id))" @update:model-value="value => selectPerson(member.user_id, value)" /></td>
          <td><button class="table-person text-left hover:underline" @click="selectedPersonId = member.user_id">{{ member.name }}</button><span class="table-detail" :title="member.email">{{ member.email }}</span></td>
          <td><UBadge :color="member.status === 'active' ? 'success' : member.status === 'removed' ? 'neutral' : 'warning'" variant="subtle" size="sm">{{ statusLabel(member.status) }}</UBadge><span class="table-detail" :class="member.licensed ? 'text-primary' : 'text-muted'">{{ member.licensed ? 'Licensed' : 'Unlicensed' }}</span><span v-if="member.role === 'admin' && member.status !== 'removed'" class="table-detail">Admin</span></td>
          <td class="whitespace-nowrap">{{ effectiveAccounts(member.user_id).length }} {{ effectiveAccounts(member.user_id).length === 1 ? 'account' : 'accounts' }}<button class="table-detail hover:text-primary hover:underline" :aria-label="`View devices for ${member.name}`" @click="showPersonActivity(member.user_id, 'devices')">{{ userDevices(member.user_id).filter((d: any) => !d.revoked_at).length }} {{ userDevices(member.user_id).filter((d: any) => !d.revoked_at).length === 1 ? 'device' : 'devices' }}</button></td>
          <td class="whitespace-nowrap"><button v-if="personRegistrations(member.user_id).length" class="text-left hover:text-primary hover:underline" :aria-label="`View registrations for ${member.name}`" @click="showPersonActivity(member.user_id, 'registrations')">{{ personRegisteredCount(member.user_id) }} / {{ personRegistrations(member.user_id).length }} registered<span class="table-detail">Across enrolled devices</span></button><span v-else class="text-xs text-muted">{{ userDevices(member.user_id).some((d: any) => !d.revoked_at) ? 'No assigned accounts' : 'No enrolled devices' }}</span></td>
          <td><p v-if="member.availability && member.availability !== 'unset'" class="mb-2 text-sm">{{ statusLabel(member.availability) }} <span class="text-muted">· Set by user</span></p><div v-if="member.do_not_disturb" class="mb-2"><UBadge color="warning" variant="subtle" size="sm">Do Not Disturb</UBadge></div><GatewayCallStatus v-if="hasGatewayAccounts(member.user_id) || !hasDirectAccounts(member.user_id) || personCalls(member.user_id).length" :calls="personCalls(member.user_id)" :now="now" :organisation-id="id" /><DirectCallStatus v-if="hasDirectAccounts(member.user_id)" :reports="directReports(userDevices(member.user_id))" :now="now" /></td>
          <td class="whitespace-nowrap tabular-nums" :title="dateLabel(member.last_login_at)">{{ activityDate(member.last_login_at) }}<span v-if="member.last_login_at" class="table-detail">{{ activityAge(member.last_login_at, now) }}</span></td>
          <td class="whitespace-nowrap tabular-nums" :title="dateLabel(member.last_request_at)">{{ activityDate(member.last_request_at) }}<span v-if="member.last_request_action" class="table-detail">{{ requestLabel(member.last_request_action) }}</span></td>
          <td class="whitespace-nowrap font-mono text-xs">{{ member.last_request_ip ?? 'Not recorded' }}</td>
          <td><UButton size="sm" variant="ghost" color="neutral" :aria-label="`View ${member.name}`" icon="i-lucide-chevron-right" @click="selectedPersonId = member.user_id" /></td>
        </tr></tbody>
      </table></div><p v-if="!people.length" class="table-empty">{{ data.members.length ? 'No people match your filters.' : 'No people in this customer yet.' }}</p>
    </section>

    <section v-if="tab === 'accounts'" aria-label="Calling accounts">
      <div class="section-toolbar"><p class="text-sm text-muted">SIP settings and assignments. Passwords stay hidden.</p><UButton v-if="canManage" icon="i-lucide-plus" @click="editConfiguration()">Add calling account</UButton></div>
      <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Calling accounts table"><table class="management-table min-w-[1080px]">
        <caption class="sr-only">Calling accounts</caption><thead><tr><ManagementSortHeader label="Calling account" :direction="sortDirection('label')" @sort="sortBy('label')" /><th scope="col">Username</th><th scope="col">Domain</th><th scope="col">Connection</th><ManagementSortHeader label="PBX registration" :direction="sortDirection('status')" @sort="sortBy('status')" /><ManagementSortHeader label="Last observed" :direction="sortDirection('observedAt')" @sort="sortBy('observedAt')" /><th scope="col">Revision</th><th v-if="canManage" scope="col">Actions</th></tr></thead>
        <tbody><tr v-for="account in visibleRows(filteredConfigurations)" :key="account.id"><td><button v-if="canManage" class="table-person text-left hover:underline" @click="editConfiguration(account)">{{ account.label }}</button><span v-else class="table-person">{{ account.label }}</span></td><td>{{ account.settings.username }}</td><td><span class="table-person font-normal" :title="account.settings.domain">{{ account.settings.domain }}</span></td><td class="whitespace-nowrap">{{ account.mode === 'gateway' ? 'Gateway' : 'Direct SIP' }} · {{ account.settings.transport.toUpperCase() }}<span class="table-detail">SRTP · {{ statusLabel(account.settings.srtp) }}</span></td><td class="whitespace-nowrap"><template v-if="account.mode === 'gateway'"><UBadge :color="account.status.color" variant="subtle" size="sm">{{ account.status.label }}</UBadge><span class="table-detail">Gateway observed<template v-if="account.status.label === 'Stale'"> · Last: {{ statusLabel(account.report?.state) }}</template></span></template><span v-else class="text-xs text-muted">Reported by devices</span></td><td class="whitespace-nowrap" :title="dateLabel(account.report?.observedAt)">{{ account.mode === 'gateway' ? activityDate(account.report?.observedAt) : '—' }}<span v-if="account.report?.observedAt" class="table-detail">{{ activityAge(account.report.observedAt, now) }}</span></td><td>{{ account.revision }}</td><td v-if="canManage"><div class="flex gap-1"><UButton size="sm" variant="ghost" color="neutral" @click="editConfiguration(account)">Edit</UButton><UButton size="sm" variant="ghost" color="error" @click="confirm('Delete this calling account?', 'It will be removed from all assigned people and groups when their devices refresh.', async () => { await mutate(`${base}/configurations/${account.id}`, 'DELETE') })">Delete</UButton></div></td></tr></tbody>
      </table></div><p v-if="!filteredConfigurations.length" class="table-empty">{{ data.configurations.length ? 'No calling accounts match your search.' : 'No calling accounts yet.' }}</p></div>
    </section>

    <section v-if="tab === 'registrations'" aria-label="Registrations" class="table-panel">
      <div class="table-scroll" tabindex="0" aria-label="Registrations table"><table class="management-table min-w-[1100px]">
        <caption class="sr-only">Registration reports and managed device activity</caption>
        <thead><tr>
          <ManagementSortHeader label="Calling account" :direction="sortDirection('name')" @sort="sortBy('name')" />
          <ManagementSortHeader label="Registration" :direction="sortDirection('status')" @sort="sortBy('status')" />
          <th scope="col">Person / Device</th>
          <th scope="col">IP address</th>
          <ManagementSortHeader label="Last report" :direction="sortDirection('observedAt')" @sort="sortBy('observedAt')" />
          <ManagementSortHeader label="Last login" :direction="sortDirection('last_login_at')" @sort="sortBy('last_login_at')" />
          <ManagementSortHeader label="Last request" :direction="sortDirection('last_request_at')" @sort="sortBy('last_request_at')" />
        </tr></thead>
        <tbody><tr v-for="row in visibleRows(filteredRegistrations)" :key="row.key">
          <td><button class="table-person text-left hover:underline" :title="row.account.label" @click="selectedDeviceId = row.device.id">{{ row.account.label }}</button><span class="table-detail" :title="row.account.settings?.server">{{ row.account.settings ? `${row.account.settings.username} · ${row.account.settings.server}` : 'No longer assigned' }}</span></td>
          <td class="whitespace-nowrap"><UBadge :color="row.status.color" variant="subtle" size="sm">{{ row.status.label }}</UBadge><span class="table-detail">{{ row.source }}</span><span v-if="row.report?.sipCode" class="table-detail">SIP {{ row.report.sipCode }}</span><span v-if="row.status.label === 'Stale'" class="table-detail">Last: {{ statusLabel(row.report?.state) }}</span></td>
          <td><span class="table-person">{{ personName(row.device.user_id) }}</span><button class="table-detail hover:underline" @click="selectedDeviceId = row.device.id">{{ row.device.name }}</button></td>
          <td class="whitespace-nowrap font-mono text-xs">{{ row.ip ?? 'Not recorded' }}<span class="table-detail font-sans">{{ row.report?.source === 'gateway' ? 'SIP peer' : 'Sipper request' }}</span></td>
          <td class="whitespace-nowrap tabular-nums" :title="dateLabel(row.report?.observedAt)">{{ activityDate(row.report?.observedAt) }}<span v-if="row.report?.observedAt" class="table-detail">{{ activityAge(row.report.observedAt, now) }}</span></td>
          <td class="whitespace-nowrap tabular-nums" :title="dateLabel(row.device.last_login_at)">{{ activityDate(row.device.last_login_at) }}</td>
          <td class="whitespace-nowrap tabular-nums" :title="dateLabel(row.device.last_request_at)">{{ activityDate(row.device.last_request_at) }}<span v-if="row.device.last_request_action" class="table-detail">{{ requestLabel(row.device.last_request_action) }}</span></td>
        </tr></tbody>
      </table></div><p v-if="!filteredRegistrations.length" class="table-empty">{{ registrations.length ? 'No registrations match your filters.' : 'Assigned accounts will appear here when a device is enrolled.' }}</p>
    </section>

    <section v-if="tab === 'devices'" aria-label="Devices" class="table-panel">
      <div class="table-scroll" tabindex="0" aria-label="Devices table"><table class="management-table min-w-[1230px]">
        <caption class="sr-only">Devices and server-observed activity</caption><thead><tr><ManagementSortHeader label="Device / Person" :direction="sortDirection('name')" @sort="sortBy('name')" /><th scope="col">Access</th><th scope="col">Registrations</th><th scope="col">Calls</th><th scope="col">Push</th><th scope="col">IP address</th><ManagementSortHeader label="Last login" :direction="sortDirection('last_login_at')" @sort="sortBy('last_login_at')" /><ManagementSortHeader label="Last request" :direction="sortDirection('last_request_at')" @sort="sortBy('last_request_at')" /><th scope="col">App / OS</th><th scope="col">Details</th></tr></thead>
        <tbody><tr v-for="device in visibleRows(filteredDevices)" :key="device.id"><td><button class="table-person text-left hover:underline" @click="selectedDeviceId = device.id">{{ device.name }}</button><span class="table-detail">{{ personName(device.user_id) }} · {{ platformLabel(device.platform) }}</span></td><td><UBadge :color="device.revoked_at ? 'neutral' : 'primary'" variant="subtle" size="sm">{{ device.revoked_at ? 'Revoked' : 'Enrolled' }}</UBadge></td><td><span class="whitespace-nowrap">{{ registeredCount(device.id) }} / {{ deviceRegistrations(device.id).length }} registered</span><span class="table-detail">{{ deviceRegistrations(device.id).filter((r: any) => r.status.label === 'Stale').length }} stale</span></td><td><GatewayCallStatus v-if="hasGatewayAccounts(device.user_id) || !hasDirectAccounts(device.user_id) || deviceCalls(device.id).length" :calls="deviceCalls(device.id)" :now="now" :organisation-id="id" /><DirectCallStatus v-if="hasDirectAccounts(device.user_id)" :reports="directReports([device])" :now="now" /></td><td class="whitespace-nowrap text-xs">{{ pushEndpointLabel(device) }}</td><td class="font-mono text-xs whitespace-nowrap">{{ device.last_request_ip ?? 'Not recorded' }}</td><td class="whitespace-nowrap" :title="dateLabel(device.last_login_at)">{{ activityDate(device.last_login_at) }}<span v-if="device.last_login_at" class="table-detail">{{ activityAge(device.last_login_at, now) }}</span></td><td class="whitespace-nowrap" :title="dateLabel(device.last_request_at)">{{ activityDate(device.last_request_at) }}<span v-if="device.last_request_action" class="table-detail">{{ requestLabel(device.last_request_action) }}</span></td><td class="whitespace-nowrap">{{ device.app_version }}<span class="table-detail">{{ platformLabel(device.platform) }} {{ device.os_version }}</span></td><td><UButton variant="ghost" color="neutral" size="sm" @click="selectedDeviceId = device.id">View</UButton></td></tr></tbody>
      </table></div><p v-if="!filteredDevices.length" class="table-empty">{{ data.devices.length ? 'No devices match your filters.' : 'Devices appear when a licensed person signs in to Sipper.' }}</p>
    </section>

    <section v-if="tab === 'groups'" aria-label="Groups">
      <div class="section-toolbar"><p class="text-sm text-muted">Group membership and calling account assignments.</p><UButton v-if="canManage" icon="i-lucide-plus" @click="editGroup()">New group</UButton></div>
      <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Groups table"><table class="management-table min-w-[560px]">
        <caption class="sr-only">Groups</caption><thead><tr><ManagementSortHeader label="Group" :direction="sortDirection('name')" @sort="sortBy('name')" /><th scope="col">People</th><th scope="col">Calling accounts</th><th v-if="canManage" scope="col">Actions</th></tr></thead><tbody><tr v-for="group in visibleRows(filteredGroups)" :key="group.id"><td><button v-if="canManage" class="table-person text-left hover:underline" @click="editGroup(group)">{{ group.name }}</button><span v-else class="table-person">{{ group.name }}</span><span v-if="group.scim_managed" class="table-detail">SCIM managed</span></td><td>{{ group.user_ids.length }}</td><td>{{ group.configuration_ids.length }}</td><td v-if="canManage"><div class="flex gap-1"><UButton size="sm" variant="ghost" color="neutral" @click="editGroup(group)">Manage</UButton><UButton v-if="!group.scim_managed" size="sm" variant="ghost" color="error" @click="confirm('Delete this group?', 'People remain in this customer. Calling accounts assigned only through this group will be removed on their next refresh.', async () => { await mutate(`${base}/groups/${group.id}`, 'DELETE') })">Delete</UButton></div></td></tr></tbody>
      </table></div><p v-if="!filteredGroups.length" class="table-empty">{{ data.groups.length ? 'No groups match your search.' : 'No groups yet.' }}</p></div>
    </section>

    <section v-if="tab === 'invitations'" aria-label="Invitations" class="table-panel">
      <div class="table-scroll" tabindex="0" aria-label="Invitations table"><table class="management-table min-w-[760px]">
        <caption class="sr-only">Invitations</caption><thead><tr><ManagementSortHeader label="Email address" :direction="sortDirection('email')" @sort="sortBy('email')" /><th scope="col">Access</th><th scope="col">Status</th><ManagementSortHeader label="Expires" :direction="sortDirection('expires_at')" @sort="sortBy('expires_at')" /><th v-if="canManage" scope="col">Actions</th></tr></thead><tbody><tr v-for="invite in visibleRows(filteredInvitations)" :key="invite.id"><td><span class="table-person" :title="invite.email">{{ invite.email }}</span></td><td>{{ invite.role === 'admin' ? 'Administrator' : 'User' }}</td><td><UBadge variant="subtle" :color="invite.accepted_at ? 'success' : 'neutral'" size="sm">{{ invite.accepted_at ? 'Accepted' : invite.revoked_at ? 'Revoked' : new Date(invite.expires_at).getTime() < now ? 'Expired' : 'Pending' }}</UBadge></td><td class="whitespace-nowrap">{{ dateLabel(invite.expires_at) }}</td><td v-if="canManage"><UButton v-if="!invite.accepted_at && !invite.revoked_at" color="neutral" variant="ghost" size="sm" @click="mutate(`${base}/invitations/${invite.id}`, 'DELETE', {}, 'Invitation revoked')">Revoke</UButton></td></tr></tbody>
      </table></div><p v-if="!filteredInvitations.length" class="table-empty">{{ data.invitations.length ? 'No invitations match your search.' : 'No invitations have been sent yet.' }}</p>
    </section>
    <div v-if="rowCount" class="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-muted" role="status">Showing {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, rowCount) }} of {{ rowCount }}</p>
      <div class="flex flex-wrap items-center gap-4">
        <USelect v-model="pageSize" :items="[25, 50, 100].map(value => ({ label: `${value} per page`, value }))" aria-label="Rows per page" size="sm" />
        <UPagination v-if="pageCount > 1" v-model:page="page" :total="rowCount" :items-per-page="pageSize" :sibling-count="0" :show-edges="false" size="sm" />
      </div>
    </div>
    <details v-if="['people', 'devices', 'registrations', 'accounts'].includes(tab)" class="mt-5 max-w-4xl text-xs leading-relaxed text-muted">
      <summary class="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">About activity data</summary>
      <div class="mt-3 space-y-2">
        <p v-if="tab !== 'accounts'">Last login is the sign-in used by a managed app for this customer. Last request is the latest managed-app request received by Sipper. People and device IPs come from these requests.</p>
        <p v-if="tab === 'registrations'">Gateway observations become stale after 45 seconds or when the gateway is unavailable. App reports become stale after 3 minutes. Each IP is labelled as a SIP peer or a Sipper request address.</p>
        <p v-if="tab === 'accounts'">PBX registration is the gateway’s connection to your phone system. It becomes stale after 45 seconds or when the gateway is unavailable. Device connections appear under Registrations. A registered account does not confirm audio or push delivery.</p>
        <p v-if="tab === 'people' || tab === 'devices'">Incoming and outgoing calls are reported by the Sipper gateway. Direct SIP calls are not included. None reported does not confirm availability; Unconfirmed means the gateway cannot currently confirm the call state.</p>
      </div>
    </details>
  </template>

  <BulkInvitations v-if="canManage || importOpen" v-model:open="importOpen" :organisation-id="id" :can-manage="canManage" @completed="refresh()" @reload="refresh({ dedupe: 'defer' })" />
  <ManagedSetupLink :organisation-id="id" :can-manage="canManage" :now="now" @opened="selectedPersonId = null" @changed="refresh()" @reload="refresh({ dedupe: 'defer' })">
  <template #default="{ create: createSetupLink, revoke: revokeSetupLink, busy: setupBusy }">
  <USlideover v-model:open="personOpen" :title="selectedPerson?.name ?? 'Person'" description="This person’s access, activity and assigned calling accounts.">
    <template #body><div v-if="selectedPerson" class="space-y-7">
      <div><p class="break-all text-sm text-muted">{{ selectedPerson.email }}</p><div class="mt-3 flex gap-2"><UBadge variant="subtle" :color="selectedPerson.status === 'active' ? 'success' : selectedPerson.status === 'removed' ? 'neutral' : 'warning'">{{ statusLabel(selectedPerson.status) }}</UBadge><UBadge color="neutral" variant="subtle">{{ selectedPerson.licensed ? 'Licensed' : 'Unlicensed' }}</UBadge><UBadge v-if="selectedPerson.role === 'admin' && selectedPerson.status !== 'removed'" color="neutral" variant="subtle">Administrator</UBadge></div></div>
      <p v-if="selectedPerson.scim_user_id" class="text-sm leading-relaxed text-muted">Provisioned through SCIM. The next provider sync can change their suspension status. Administrator roles and manual removals take priority. <NuxtLink v-if="canManage" :to="`/portal/provisioning/${id}`" class="text-primary underline">User provisioning</NuxtLink></p>
      <div><div class="mb-4 flex items-center justify-between gap-3"><h2 class="font-semibold">Managed app activity</h2><UButton size="sm" variant="link" @click="showPersonActivity(selectedPerson.user_id, 'registrations')">Registrations</UButton></div><dl class="detail-list"><dt>Last login</dt><dd>{{ dateLabel(selectedPerson.last_login_at) }}</dd><dt>Last request</dt><dd>{{ dateLabel(selectedPerson.last_request_at) }}<span v-if="selectedPerson.last_request_action" class="table-detail">{{ requestLabel(selectedPerson.last_request_action) }}</span></dd><dt>IP address</dt><dd class="font-mono text-xs">{{ selectedPerson.last_request_ip ?? 'Not recorded' }}</dd></dl></div>
      <div><h2 class="mb-3 font-semibold">Calling status</h2><dl class="detail-list mb-4"><dt>Stated availability</dt><dd>{{ selectedPerson.availability === 'unset' ? 'Not set' : statusLabel(selectedPerson.availability) }}</dd><dt>Do Not Disturb</dt><dd>{{ selectedPerson.do_not_disturb ? 'On' : 'Off' }}</dd><dt>Preference changed</dt><dd>{{ dateLabel(selectedPerson.calling_preference_updated_at) }}</dd></dl><GatewayCallStatus v-if="hasGatewayAccounts(selectedPerson.user_id) || !hasDirectAccounts(selectedPerson.user_id) || personCalls(selectedPerson.user_id).length" :calls="personCalls(selectedPerson.user_id)" :now="now" :organisation-id="id" /><DirectCallStatus v-if="hasDirectAccounts(selectedPerson.user_id)" :reports="directReports(userDevices(selectedPerson.user_id))" :now="now" /><p class="mt-3 text-xs leading-relaxed text-muted">Availability is set by this person and stays until they change or clear it. It does not confirm reachability or alter call handling. Do Not Disturb is set by this person. It stops new gateway calls immediately; direct PBX accounts apply it after settings refresh in a supported app. Calls already ringing or connected continue. Gateway activity comes from the calling service. Direct activity is an app snapshot, refreshed on state changes while the app runs, with at least five seconds between attempts. Reports older than three minutes are unconfirmed; neither source confirms availability.</p></div>
      <section v-if="canManage && selectedPerson.status !== 'removed'">
        <h2 class="mb-3 font-semibold">Device setup</h2>
        <p class="mb-3 text-sm text-muted">Create a link or QR code for this person to connect a device. It expires in 15 minutes and can be used once.</p>
        <UButton icon="i-lucide-qr-code" variant="outline" color="neutral" class="min-h-11 sm:min-h-0" :disabled="selectedPerson.status !== 'active' || !selectedPerson.licensed" :loading="setupBusy" @click="createSetupLink(selectedPerson)">Create setup link</UButton>
        <p v-if="selectedPerson.status !== 'active' || !selectedPerson.licensed" class="mt-2 text-xs text-muted">An active membership and assigned licence are required.</p>
        <p v-else class="mt-2 text-xs text-muted">A new link replaces any unused link for this person.</p>
        <ul class="mt-3 divide-y divide-default"><li v-for="link in (data.setupLinks ?? []).filter((link: any) => link.user_id === selectedPerson.user_id)" :key="link.id" class="flex items-center justify-between gap-3 py-3 text-xs"><span>{{ link.used_at ? 'Used' : link.revoked_at ? 'Revoked' : new Date(link.expires_at).getTime() <= now ? 'Expired' : 'Expires' }} · {{ activityDate(link.used_at ?? link.revoked_at ?? link.expires_at) }}</span><UButton v-if="!link.used_at && !link.revoked_at" variant="ghost" color="neutral" size="xs" class="min-h-11 sm:min-h-0" :loading="setupBusy" @click="revokeSetupLink(link.id)">Revoke</UButton></li></ul>
      </section>
      <div><h2 class="mb-3 font-semibold">Direct calling accounts</h2><ul class="divide-y divide-default"><li v-for="account in assignments(selectedPerson.user_id)" :key="account.id" class="flex items-center justify-between gap-3 py-3"><span class="min-w-0 break-words text-sm">{{ account.label }}</span><UButton v-if="canManage" variant="ghost" color="neutral" icon="i-lucide-x" size="sm" :aria-label="`Remove ${account.label}`" class="size-11 sm:size-auto shrink-0" :loading="busy" @click="mutate(`${base}/configurations/${account.id}/users/${selectedPerson.user_id}`, 'DELETE')" /></li></ul><p v-if="!assignments(selectedPerson.user_id).length" class="mb-3 text-sm text-muted">No direct assignments.</p><USelect v-if="canManage" :model-value="null" :ui="{ base: 'min-h-11 sm:min-h-0', item: 'min-h-11 sm:min-h-0' }" :items="availableAccounts(selectedPerson.user_id)" placeholder="Assign calling account" aria-label="Assign calling account" class="mt-3 w-full" :disabled="selectedPerson.status === 'removed' || !availableAccounts(selectedPerson.user_id).length || busy" @update:model-value="value => mutate(`${base}/configurations/${value}/users/${selectedPerson.user_id}`, 'PUT')" /></div>
      <div><h2 class="mb-3 font-semibold">Groups</h2><div class="flex flex-wrap gap-2"><UBadge v-for="group in personGroups(selectedPerson.user_id)" :key="group.id" color="neutral" variant="subtle">{{ group.name }}</UBadge></div><p v-if="!personGroups(selectedPerson.user_id).length" class="text-sm text-muted">Not in a group.</p></div>
      <div><h2 class="mb-3 font-semibold">Devices</h2><ul class="divide-y divide-default"><li v-for="device in userDevices(selectedPerson.user_id)" :key="device.id" class="py-3"><button class="text-left text-sm text-primary hover:underline" @click="selectedPersonId = null; selectedDeviceId = device.id">{{ device.name }}</button><p class="mt-1 text-xs text-muted">{{ platformLabel(device.platform) }} · {{ device.revoked_at ? 'Revoked' : 'Enrolled' }}</p></li></ul><p v-if="!userDevices(selectedPerson.user_id).length" class="text-sm text-muted">No devices enrolled.</p></div>
      <div v-if="canManage" class="flex flex-wrap gap-2 border-t border-default pt-5"><UButton v-if="canBill && (selectedPerson.status !== 'removed' || selectedPerson.licensed)" variant="outline" color="neutral" :loading="busy" @click="changeSeat(selectedPerson)">{{ selectedPerson.licensed ? 'Release licence' : 'Assign licence' }}</UButton><UButton v-if="selectedPerson.status !== 'removed'" variant="soft" :color="selectedPerson.status === 'active' ? 'warning' : 'primary'" :loading="busy" @click="changeStatus(selectedPerson)">{{ selectedPerson.status === 'active' ? 'Suspend person' : 'Resume person' }}</UButton></div>
      <CustomerMemberAccess v-if="canManage" :key="selectedPerson.user_id" :organisation-id="id" :person="selectedPerson" :viewer-id="overview?.user.id" :workspace-admin="Boolean(canBill)" @changed="refresh()" @invite="reinvitePerson(selectedPerson)" />
    </div></template>
  </USlideover>
  </template>
  </ManagedSetupLink>
  <USlideover v-model:open="deviceOpen" :title="selectedDevice?.name ?? 'Device'" description="Activity recorded for this managed installation.">
    <template #body><div v-if="selectedDevice" class="space-y-7">
      <div><p class="text-sm text-muted">{{ personName(selectedDevice.user_id) }} · {{ platformLabel(selectedDevice.platform) }}</p><UBadge class="mt-3" variant="subtle" :color="selectedDevice.revoked_at ? 'neutral' : 'primary'">{{ selectedDevice.revoked_at ? 'Revoked' : 'Enrolled' }}</UBadge></div>
      <dl class="detail-list"><dt>IP address</dt><dd class="font-mono text-xs">{{ selectedDevice.last_request_ip ?? 'Not recorded' }}</dd><dt>Last login</dt><dd>{{ dateLabel(selectedDevice.last_login_at) }}</dd><dt>Last request</dt><dd>{{ dateLabel(selectedDevice.last_request_at) }}<span v-if="selectedDevice.last_request_action" class="table-detail">{{ requestLabel(selectedDevice.last_request_action) }}</span></dd><dt>Last configuration</dt><dd>{{ dateLabel(selectedDevice.last_configuration_at) }}</dd><dt>Last device report</dt><dd>{{ dateLabel(selectedDevice.last_report_at) }}</dd><dt>Enrolled</dt><dd>{{ dateLabel(selectedDevice.enrolled_at) }}</dd><dt>App version</dt><dd>{{ selectedDevice.app_version }}</dd><dt>Operating system</dt><dd>{{ platformLabel(selectedDevice.platform) }} {{ selectedDevice.os_version }}</dd><dt>Configuration</dt><dd>{{ selectedDevice.applied_revision ? 'Acknowledged' : 'Not acknowledged' }}<span v-if="selectedDevice.applied_revision" class="mt-1 block font-mono text-xs text-muted">{{ selectedDevice.applied_revision }}</span></dd><template v-if="selectedDevice.status.configurationError"><dt>Configuration error</dt><dd>{{ statusLabel(selectedDevice.status.configurationError) }}</dd></template><dt>Device ID</dt><dd class="font-mono text-xs">{{ selectedDevice.id }}</dd></dl>
      <div><h2 class="mb-3 font-semibold">Registration reports</h2><ul class="divide-y divide-default"><li v-for="row in deviceRegistrations(selectedDevice.id)" :key="row.key" class="py-3"><div class="flex items-start justify-between gap-3"><span class="min-w-0 break-words text-sm font-medium">{{ row.account.label }}</span><UBadge :color="row.status.color" variant="subtle" size="sm">{{ row.status.label }}</UBadge></div><p class="mt-2 text-xs text-muted">{{ row.source }} · {{ row.report?.sipCode ? `SIP ${row.report.sipCode} · ` : '' }}{{ dateLabel(row.report?.observedAt) }}</p><p v-if="row.report?.source === 'gateway'" class="mt-1 text-xs text-muted">SIP peer: {{ row.ip ?? 'Not recorded' }} · App report: {{ registrationState(row.appReport, row.device.revoked_at, now).label }}</p><p v-if="row.status.label === 'Stale'" class="mt-1 text-xs text-muted">Last reported state: {{ statusLabel(row.report?.state) }}</p></li></ul><p v-if="!deviceRegistrations(selectedDevice.id).length" class="text-sm text-muted">No calling accounts assigned.</p><p class="mt-3 text-xs leading-relaxed text-muted">Last login is the sign-in session used for this customer’s managed app access. Activity from other customers is excluded.</p><p class="mt-3 text-xs leading-relaxed text-muted">Gateway status confirms a device contact on Sipper, not the upstream PBX registration. Direct SIP status comes from the app. Request and SIP IPs may differ.</p></div>
      <div><h2 class="mb-3 font-semibold">Call activity</h2><GatewayCallStatus v-if="hasGatewayAccounts(selectedDevice.user_id) || !hasDirectAccounts(selectedDevice.user_id) || deviceCalls(selectedDevice.id).length" :calls="deviceCalls(selectedDevice.id)" :now="now" :organisation-id="id" /><DirectCallStatus v-if="hasDirectAccounts(selectedDevice.user_id)" :reports="directReports([selectedDevice])" :now="now" /><p class="mt-3 text-xs leading-relaxed text-muted">Direct activity contains call counts only, with no caller names or numbers. While the app runs, it checks for changes every few seconds and sends a heartbeat each minute. Reports become unconfirmed after three minutes or when the app cannot confirm its managed configuration. Background or offline apps may not report. Gateway activity is observed separately; neither source confirms availability.</p></div>
      <DevicePushDetails :device="selectedDevice" />
      <UButton v-if="canManage && !selectedDevice.revoked_at" color="error" variant="outline" :loading="busy" @click="revokeSelectedDevice(selectedDevice)">Revoke device</UButton>
    </div></template>
  </USlideover>
  <UModal v-if="canManage" v-model:open="inviteOpen" title="Invite someone" description="They’ll receive an email with a link to join this customer."><template #body><form class="space-y-5" @submit.prevent="invite"><UAlert v-if="error" :title="error" color="error" /><UFormField label="Email address"><UInput v-model="inviteEmail" type="email" required autofocus class="w-full" placeholder="person@example.com" /></UFormField><UFormField label="Access"><USelect v-model="inviteRole" :items="[{ label: 'User — their own calling accounts', value: 'user' }, { label: 'Admin — manage this customer', value: 'admin' }]" class="w-full" /></UFormField><p class="text-sm text-stone-500">After they accept, assign a user licence if they need managed calling. Admin access itself does not consume a licence.</p><UButton type="submit" block :loading="busy">Send invitation</UButton></form></template></UModal>
  <UModal v-if="canManage" v-model:open="configOpen" :title="editingConfig ? 'Edit calling account' : 'Add calling account'" description="Use the SIP details supplied by your telephone provider." :dismissible="!busy" :close="!busy" :ui="{ close: 'size-11 sm:size-8', wrapper: 'pr-12 sm:pr-9' }">
    <template #body>
      <form @submit.prevent="saveConfiguration">
        <fieldset :disabled="busy" class="space-y-5">
          <UAlert v-if="error" :title="error" color="error" />
          <div v-if="error && editingConfig" class="space-y-1">
            <UButton variant="outline" color="neutral" class="min-h-11 sm:min-h-0" :disabled="busy || fetchStatus === 'pending'" @click="reloadConfiguration">Reload saved account</UButton>
            <p class="text-xs text-muted">Reload replaces your unsaved details and clears the new password.</p>
          </div>
          <UFormField label="Account label"><UInput v-model="config.label" required maxlength="160" class="w-full" placeholder="Main extension" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
          <UFormField label="Connection mode"><USelect v-model="config.mode" :disabled="busy" :items="[{ label: 'Direct SIP', value: 'direct' }, { label: 'Sipper gateway', value: 'gateway' }]" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0', item: 'min-h-11 sm:min-h-0' }" /></UFormField>
          <UAlert v-if="config.mode === 'gateway'" color="warning" title="Gateway service required" description="This account will only be provisioned when the gateway service is configured. Upstream passwords are never sent to devices in this mode." />
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="SIP username"><UInput v-model="config.settings.username" required class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
            <UFormField label="Authentication username" help="Leave blank to use the SIP username."><UInput v-model="config.settings.authUsername" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
          </div>
          <UFormField :label="editingConfig ? 'New password (optional)' : 'SIP password'" :help="editingConfig ? 'Leave blank to keep the stored password.' : undefined"><UInput v-model="config.password" type="password" autocomplete="new-password" :required="!editingConfig" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
          <UFormField label="SIP domain"><UInput v-model="config.settings.domain" required placeholder="pbx.example.com" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
          <UFormField label="SIP server"><UInput v-model="config.settings.server" required placeholder="sip.example.com" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
          <div class="grid grid-cols-2 gap-4">
            <UFormField label="Transport"><USelect v-model="config.settings.transport" :disabled="busy" :items="[{ label: 'TLS', value: 'tls' }, { label: 'TCP', value: 'tcp' }, { label: 'UDP', value: 'udp' }]" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0', item: 'min-h-11 sm:min-h-0' }" /></UFormField>
            <UFormField label="Port" help="Blank uses the standard port."><UInput :model-value="config.settings.port ?? undefined" type="number" :min="1" :max="65535" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" @update:model-value="v => config.settings.port = String(v) === '' ? null : Number(v)" /></UFormField>
            <UFormField label="Media encryption"><USelect v-model="config.settings.srtp" :disabled="busy" :items="[{ label: 'Required', value: 'required' }, { label: 'Optional', value: 'optional' }, { label: 'Disabled', value: 'disabled' }]" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0', item: 'min-h-11 sm:min-h-0' }" /></UFormField>
            <UFormField label="Display name"><UInput v-model="config.settings.displayName" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
          </div>
          <details>
            <summary class="cursor-pointer text-sm text-sipper-600">More settings</summary>
            <div class="mt-4 space-y-4">
              <UFormField label="Voicemail number"><UInput v-model="config.settings.voicemailNumber" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
              <UFormField label="STUN server"><UInput v-model="config.settings.stunServer" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" /></UFormField>
              <UCheckbox v-model="config.settings.useICE" :disabled="busy" label="Use ICE for connectivity" />
            </div>
          </details>
          <UButton type="submit" block :loading="busy" :disabled="busy" class="min-h-11 sm:min-h-0">Save calling account</UButton>
        </fieldset>
      </form>
    </template>
  </UModal>
  <UModal v-if="canManage" v-model:open="groupOpen" :title="editingGroup ? 'Manage group' : 'Create a group'" description="Group members receive every calling account assigned here." :ui="{ close: 'size-11 sm:size-8' }">
    <template #body>
      <form class="space-y-5" @submit.prevent="saveGroup">
        <UAlert v-if="error" :title="error" color="error" />
        <div v-if="error" class="space-y-1">
          <UButton variant="outline" color="neutral" class="min-h-11 sm:min-h-0" :disabled="busy || fetchStatus === 'pending'" @click="reloadGroup">Reload group</UButton>
          <p class="text-xs text-muted">Reload replaces your unsaved changes with any saved group.</p>
        </div>
        <UFormField label="Group name" :help="editingScimGroup ? 'Name and people are managed in your identity provider.' : undefined">
          <UInput v-model="groupName" :disabled="editingScimGroup || busy" required maxlength="160" class="w-full" :ui="{ base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' }" />
        </UFormField>
        <UFormField label="People">
          <USelectMenu v-model="groupUsers" :disabled="editingScimGroup || busy" multiple value-key="value" :items="userOptions" class="w-full" placeholder="Choose people" :ui="{ base: 'min-h-11 sm:min-h-0', item: 'min-h-11 sm:min-h-0' }" :search-input="{ ui: { base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' } }">
            <span class="truncate" :class="{ 'text-muted': !groupUsers.length }">{{ groupUsers.length === 1 ? personName(groupUsers[0]!) : groupUsers.length ? `${groupUsers.length} people selected` : 'Choose people' }}</span>
          </USelectMenu>
        </UFormField>
        <UFormField label="Calling accounts">
          <USelectMenu v-model="groupConfigs" :disabled="busy" multiple value-key="value" :items="configOptions" class="w-full" placeholder="Choose accounts" :ui="{ base: 'min-h-11 sm:min-h-0', item: 'min-h-11 sm:min-h-0' }" :search-input="{ ui: { base: 'min-h-11 sm:min-h-0 text-base sm:text-sm' } }">
            <span class="truncate" :class="{ 'text-muted': !groupConfigs.length }">{{ groupConfigs.length === 1 ? configOptions.find((item: any) => item.value === groupConfigs[0])?.label ?? '1 calling account selected' : groupConfigs.length ? `${groupConfigs.length} calling accounts selected` : 'Choose accounts' }}</span>
          </USelectMenu>
        </UFormField>
        <UButton type="submit" :loading="busy" :disabled="busy" block class="min-h-11 sm:min-h-0">Save group</UButton>
      </form>
    </template>
  </UModal>
  <UModal v-if="canManage" v-model:open="confirmationOpen" :title="confirmation?.title" :description="confirmation?.description" :dismissible="!busy" :close="!busy" :ui="{ close: 'size-11 sm:size-8', description: '[overflow-wrap:anywhere]' }"><template #footer><div class="flex w-full justify-end gap-3"><UButton color="neutral" variant="outline" class="min-h-11 sm:min-h-0" :disabled="busy" @click="confirmation = null">Cancel</UButton><UButton color="warning" class="min-h-11 sm:min-h-0" :loading="busy" @click="confirmAction">Confirm</UButton></div></template></UModal>
</template>
