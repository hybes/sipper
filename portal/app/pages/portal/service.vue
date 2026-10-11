<script setup lang="ts">
import { gatewayStatus } from '~~/shared/service-status'
import { workerStatus } from '~~/shared/worker-status'
definePageMeta({ layout: 'portal', middleware: 'auth' })
useHead({ title: 'Service status · Sipper' })
const { data, error, refresh, status } = await useFetch<any>('/api/platform/service')
const page = ref(0), cursors = ref<(string | undefined)[]>([undefined]), before = computed(() => cursors.value[page.value])
const { data: failures, error: failuresError, refresh: refreshFailures, status: failuresStatus } = await useFetch<any>('/api/platform/service/email-failures', { query: { before } })
const { busy, error: actionError, action } = usePortal()
const retrying = ref<any>(null)
const retryOpen = computed({ get: () => Boolean(retrying.value), set: value => { if (!value && !busy.value) retrying.value = null } })
function canRetry(job: any) { return !error.value && !failuresError.value && failuresStatus.value !== 'pending' && !busy.value && job.canRetry && Date.parse(job.invitation?.expiresAt) > now.value }
function older() { if (failures.value?.nextCursor) { cursors.value = [...cursors.value.slice(0,page.value + 1),failures.value.nextCursor]; page.value++ } }
async function latestFailures() { page.value = 0; cursors.value = [undefined]; await refreshFailures() }
async function refreshService() { await Promise.all([refresh(), refreshFailures()]) }
async function retryEmail() {
  if (!retrying.value || !canRetry(retrying.value)) return
  const result = await action(() => $fetch(`/api/platform/service/email-failures/${retrying.value.id}/retry`, { method: 'POST', body: {} }), 'Invitation queued for delivery')
  if (result) { retrying.value = null; await refreshService() }
}
const now = ref(Date.now()), autoRefresh = ref(true)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => {
  now.value = Date.now()
  if (autoRefresh.value && !retrying.value && document.visibilityState === 'visible') {
    if (status.value !== 'pending') refresh()
    if (page.value === 0 && failuresStatus.value !== 'pending') refreshFailures()
  }
}, 15_000) })
onBeforeUnmount(() => clearInterval(timer))
const providers = [{ key: 'gateway', label: 'SIP gateway' }, { key: 'apns', label: 'Apple call push' }, { key: 'messageApns', label: 'Apple message push' }, { key: 'fcm', label: 'Android push' }, { key: 'billing', label: 'Stripe billing' }, { key: 'meetings', label: 'Meetings' }]
const queues = computed(() => ['email', 'call_push', 'message_push', 'meeting_control'].map(kind => data.value?.queues.find((item: any) => item.kind === kind) ?? { kind, ready: 0, processing: 0, scheduled: 0, exhausted: 0, completed_24h: 0, failed_24h: 0, skipped_24h: 0 }))
const workers = computed(() => ['email', 'push', 'meeting'].flatMap(kind => {
  const reported = data.value?.workers?.filter((item: any) => item.kind === kind) ?? []
  return reported.length ? reported : [{ kind, id: null, started_at: null, progressed_at: null, stopped_at: null }]
}))
</script>
<template>
  <UButton to="/portal" icon="i-lucide-arrow-left" variant="link" color="neutral" class="mb-4 -ml-2">All workspaces</UButton>
  <div class="page-heading"><div><h1 class="page-title">Service status</h1><p class="page-description">Gateway availability and background delivery across Sipper.</p></div><UButton icon="i-lucide-refresh-cw" variant="outline" color="neutral" :loading="status === 'pending' || failuresStatus === 'pending'" @click="refreshService">Refresh</UButton></div>
  <UAlert v-if="error" class="mt-6" color="error" title="Service status unavailable" :description="(error.data as any)?.message" />
  <template v-if="data && !error">
    <div class="section-toolbar mt-6"><p class="text-xs text-muted">Updated {{ activityDate(data.sampledAt) }}</p><UCheckbox v-model="autoRefresh" label="Auto-refresh · 15s" /></div>
    <section aria-label="Gateways"><h2 class="mb-3 text-lg font-semibold">Gateways</h2><p class="mb-4 max-w-3xl text-sm text-muted">Ready means the controller has a current lease and is accepting new calls. Eligible accounts are authorised device accounts, not confirmed SIP registrations.</p>
      <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Gateway service table"><table class="management-table min-w-[880px]"><caption class="sr-only">Gateway controller health</caption><thead><tr><th scope="col">Gateway</th><th scope="col">Availability</th><th scope="col">Last heartbeat</th><th scope="col">Controller lease</th><th scope="col">Ready until</th><th scope="col">Eligible accounts</th></tr></thead><tbody><tr v-for="node in data.gateways" :key="node.id"><td><span class="table-person" :title="node.id">{{ node.id }}</span><span class="table-detail">{{ node.host }}:{{ node.port }}</span></td><td><UBadge variant="subtle" :color="gatewayStatus(node, now).color">{{ gatewayStatus(node, now).label }}</UBadge></td><td class="whitespace-nowrap">{{ activityDate(node.last_heartbeat_at) }}</td><td class="whitespace-nowrap">{{ activityDate(node.controller_expires_at) }}</td><td class="whitespace-nowrap">{{ activityDate(node.ready_until) }}</td><td>{{ node.eligible_accounts }}</td></tr></tbody></table></div><p v-if="!data.gateways.length" class="table-empty">No gateway has reported to this service.</p></div>
    </section>
    <section class="mt-8" aria-label="Background workers">
      <h2 class="mb-3 text-lg font-semibold">Background workers</h2>
      <p class="mb-4 max-w-3xl text-sm text-muted">Polling means a queue check completed recently, even if there was no work. It does not confirm delivery. Push and meeting workers become stale after 45 seconds without progress; email workers after 3 minutes.</p>
      <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Background worker table">
        <table class="management-table min-w-[760px]"><caption class="sr-only">Background worker progress</caption>
          <thead><tr><th scope="col">Worker</th><th scope="col">Progress</th><th scope="col">Started</th><th scope="col">Last queue check</th><th scope="col">Stopped</th></tr></thead>
          <tbody><tr v-for="worker in workers" :key="worker.id ?? worker.kind">
            <td><span class="whitespace-nowrap font-medium">{{ worker.kind === 'email' ? 'Invitations and email' : worker.kind === 'meeting' ? 'Meeting controls' : 'Mobile notifications' }}</span><span v-if="worker.id" class="table-detail font-mono" :title="worker.id">{{ worker.id.slice(0, 8) }}</span></td>
            <td><UBadge variant="subtle" :color="workerStatus(worker, now).color">{{ workerStatus(worker, now).label }}</UBadge></td>
            <td class="whitespace-nowrap">{{ activityDate(worker.started_at) }}</td><td class="whitespace-nowrap">{{ activityDate(worker.progressed_at) }}</td><td class="whitespace-nowrap">{{ activityDate(worker.stopped_at) }}</td>
          </tr></tbody>
        </table>
      </div><p v-if="!data.workers.length" class="table-empty">No workers have reported in the last 24 hours.</p></div>
    </section>
    <section class="mt-8" aria-label="Delivery queues"><h2 class="mb-3 text-lg font-semibold">Delivery queues</h2><p class="mb-4 max-w-3xl text-sm text-muted">Exhausted email jobs need operator attention. Skipped work belongs to unusable invitations, read messages or calls and recipients that are no longer available.</p><div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Delivery queue table"><table class="management-table min-w-[1000px]"><caption class="sr-only">Background delivery queues</caption><thead><tr><th scope="col">Queue</th><th scope="col">Ready</th><th scope="col">Processing</th><th scope="col">Scheduled</th><th scope="col">Exhausted</th><th scope="col">Oldest ready</th><th scope="col">Completed · 24h</th><th scope="col">Failed · 24h</th><th scope="col">Skipped · 24h</th></tr></thead><tbody><tr v-for="queue in queues" :key="queue.kind"><td class="whitespace-nowrap font-medium">{{ queue.kind === 'email' ? 'Invitations and email' : queue.kind === 'message_push' ? 'Message notifications' : queue.kind === 'meeting_control' ? 'Meeting controls' : 'Incoming call push' }}</td><td>{{ queue.ready }}</td><td>{{ queue.processing }}</td><td>{{ queue.scheduled }}</td><td :class="queue.exhausted ? 'font-semibold text-warning' : ''">{{ queue.exhausted }}</td><td class="whitespace-nowrap">{{ activityDate(queue.oldest_ready_at) }}</td><td>{{ queue.completed_24h }}</td><td :class="queue.failed_24h ? 'font-semibold text-warning' : ''">{{ queue.failed_24h }}</td><td>{{ queue.skipped_24h }}</td></tr></tbody></table></div></div></section>
    <section class="mt-8" aria-label="Invitation delivery failures">
      <h2 class="mb-3 text-lg font-semibold">Invitation delivery failures</h2>
      <p class="mb-4 max-w-3xl text-sm text-muted">These emails stopped after ten attempts. Fix the delivery problem before retrying. Retries keep the original invitation and expiry. Invitations that expire, are accepted or are revoked are removed on the worker's next cleanup.</p>
      <UAlert v-if="failuresError" color="error" title="Delivery failures unavailable" :description="(failuresError.data as any)?.message"><template #actions><UButton color="neutral" variant="outline" :loading="failuresStatus === 'pending'" @click="latestFailures">Reload latest failures</UButton></template></UAlert>
      <template v-else-if="failures">
        <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Invitation delivery failure table">
          <table class="management-table min-w-[1000px]"><caption class="sr-only">Invitation emails awaiting recovery</caption>
            <thead><tr><th scope="col">Recipient</th><th scope="col">Workspace / customer</th><th scope="col">Queued</th><th scope="col">Last attempt</th><th scope="col">Attempts</th><th scope="col">Invitation expires</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody><tr v-for="job in failures.failures" :key="job.id">
              <td><span class="table-person" :title="job.invitation?.email">{{ job.invitation?.email ?? 'Invitation unavailable' }}</span><span class="table-detail">{{ job.invitation?.kind === 'workspace' ? 'Workspace staff' : job.invitation ? 'Customer member' : 'No invitation found' }}</span></td>
              <td><span class="table-person" :title="job.invitation?.workspaceName">{{ job.invitation?.workspaceName ?? 'Unavailable' }}</span><span v-if="job.invitation?.customerName" class="table-detail" :title="job.invitation.customerName">{{ job.invitation.customerName }}</span></td>
              <td class="whitespace-nowrap">{{ activityDate(job.createdAt) }}</td><td class="whitespace-nowrap">{{ activityDate(job.lastAttemptAt) }}</td><td>{{ job.attempts }}</td><td class="whitespace-nowrap">{{ activityDate(job.invitation?.expiresAt) }}</td>
              <td><UButton v-if="job.canRetry && Date.parse(job.invitation?.expiresAt) > now" color="neutral" variant="outline" :disabled="!canRetry(job)" :aria-label="`Retry invitation to ${job.invitation.email}`" class="min-h-11 whitespace-nowrap sm:min-h-8" @click="actionError='';retrying=job">Retry delivery</UButton><UBadge v-else color="neutral" variant="subtle">Unavailable</UBadge></td>
            </tr></tbody>
          </table>
        </div><p v-if="!failures.failures.length" class="table-empty">{{ failuresStatus === 'pending' ? 'Loading delivery failures…' : 'No exhausted invitation emails on this page.' }}</p></div>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-3"><p class="text-xs text-muted">Page {{ page + 1 }} · {{ failures.failures.length }} {{ failures.failures.length === 1 ? 'email' : 'emails' }}</p><div class="flex gap-2"><UButton v-if="page" color="neutral" variant="link" :disabled="failuresStatus === 'pending' || busy" @click="latestFailures">Latest</UButton><UButton color="neutral" variant="outline" class="min-h-11 sm:min-h-8" :disabled="!page || failuresStatus === 'pending' || busy" @click="page--">Newer</UButton><UButton color="neutral" variant="outline" class="min-h-11 sm:min-h-8" :disabled="!failures.nextCursor || failuresStatus === 'pending' || busy" @click="older">Older</UButton></div></div>
      </template>
    </section>
    <section class="mt-8" aria-label="Mobile push"><h2 class="mb-3 text-lg font-semibold">Mobile push</h2><p class="mb-4 max-w-3xl text-sm text-muted">A registered token or provider acceptance does not prove that a phone rang. Wake requests are recorded when the app contacts Sipper about a call.</p><div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Push service table"><table class="management-table min-w-[700px]"><caption class="sr-only">Mobile push activity</caption><thead><tr><th scope="col">Provider</th><th scope="col">Registered tokens</th><th scope="col">Disabled tokens</th><th scope="col">Last provider attempt</th><th scope="col">Last wake request</th></tr></thead><tbody><tr v-for="row in data.push" :key="`${row.kind}:${row.provider}`"><td>{{ row.provider === 'apns' ? 'Apple' : 'Google' }} · {{ row.kind === 'message' ? 'Messages' : 'Calls' }}</td><td>{{ row.registered }}</td><td>{{ row.disabled }}</td><td class="whitespace-nowrap">{{ activityDate(row.last_push_at) }}</td><td class="whitespace-nowrap">{{ activityDate(row.last_wake_at) }}</td></tr></tbody></table></div><p v-if="!data.push.length" class="table-empty">No mobile push tokens have been registered.</p></div></section>
    <section class="mt-8" aria-label="Provider configuration"><h2 class="mb-3 text-lg font-semibold">Provider configuration</h2><p class="mb-4 text-sm text-muted">These checks confirm settings are present. They do not test provider credentials or delivery.</p><div class="table-panel"><table class="management-table"><caption class="sr-only">Provider configuration presence</caption><thead><tr><th scope="col">Service</th><th scope="col">Configuration</th></tr></thead><tbody><tr v-for="provider in providers" :key="provider.key"><td class="whitespace-nowrap">{{ provider.label }}</td><td><UBadge variant="subtle" :color="data.configuration[provider.key] ? 'neutral' : 'warning'">{{ data.configuration[provider.key] ? 'Settings present' : 'Not configured' }}</UBadge></td></tr></tbody></table></div></section>
  </template>
  <UModal v-if="data && !error" v-model:open="retryOpen" title="Retry invitation delivery?" description="This queues the original email again. It does not extend the invitation or confirm inbox delivery." :dismissible="!busy" :close="!busy" :ui="{ close: 'size-11 sm:size-8' }">
    <template #body><div class="space-y-4"><UAlert v-if="actionError" color="error" :title="actionError" /><dl class="detail-list"><dt>Recipient</dt><dd class="break-all">{{ retrying?.invitation?.email }}</dd><dt>Workspace</dt><dd>{{ retrying?.invitation?.workspaceName }}</dd><template v-if="retrying?.invitation?.customerName"><dt>Customer</dt><dd>{{ retrying.invitation.customerName }}</dd></template><dt>Expires</dt><dd>{{ activityDate(retrying?.invitation?.expiresAt) }}</dd></dl><p class="text-sm text-muted">If an earlier email reached the recipient but its delivery response was lost, they may receive another copy.</p></div></template>
    <template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" class="min-h-11 sm:min-h-8" :disabled="busy" @click="retrying=null">Cancel</UButton><UButton class="min-h-11 sm:min-h-8" :loading="busy" :disabled="!retrying || !canRetry(retrying)" @click="retryEmail">Queue retry</UButton></div></template>
  </UModal>
</template>
