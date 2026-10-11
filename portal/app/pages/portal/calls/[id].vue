<script setup lang="ts">
import { gatewayCallStatus } from '~~/shared/service-status'
definePageMeta({ layout: 'portal', middleware: 'auth' })
useHead({ title: 'Call activity · Sipper' })
const route = useRoute(), id = String(route.params.id), page = ref(0), cursors = ref<(string | undefined)[]>([undefined])
const reference = computed(() => route.query.call === undefined ? undefined : String(route.query.call))
const before = computed(() => reference.value !== undefined ? undefined : cursors.value[page.value])
const { data, error, refresh, status } = await useFetch<any>(`/api/platform/organisations/${id}/calls`, { query: { before, call: reference } })
const { busy, error: actionError, action } = usePortal()
const ending = ref<any>(null)
watch(reference, () => { page.value = 0; cursors.value = [undefined]; ending.value = null })
const endOpen = computed({ get: () => Boolean(ending.value), set: value => { if (!value) ending.value = null } })
function canEnd(call: any) { return !error.value && data.value?.canEndCalls && call.state !== 'ended' && !call.end_requested_at && gatewayCallStatus(call,now.value).label !== 'Expired' }
async function endCall() {
  if (!ending.value || busy.value) return
  const result = await action(() => $fetch(`/api/platform/organisations/${id}/calls/${ending.value.id}/end`, { method:'POST',body:{} }), 'Call end requested')
  if (result) { ending.value = null; await refresh() }
}
const now = ref(Date.now()), autoRefresh = ref(true)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); if (autoRefresh.value && page.value === 0 && document.visibilityState === 'visible' && status.value !== 'pending') refresh() }, 15_000) })
onBeforeUnmount(() => clearInterval(timer))
function older() { if (data.value?.nextCursor) { cursors.value = [...cursors.value.slice(0,page.value + 1),data.value.nextCursor]; page.value++ } }
async function latest() { if (reference.value !== undefined) await navigateTo({ path: route.path, query: {} }); else if (page.value) { page.value = 0; cursors.value = [undefined] } else await refresh() }
</script>
<template>
  <UButton :to="`/portal/organisations/${id}`" icon="i-lucide-arrow-left" variant="link" color="neutral" class="mb-4 -ml-2">Customer</UButton>
  <div class="page-heading"><div><h1 class="page-title">Call activity</h1><p class="page-description">{{ data?.organisationName ?? 'Customer' }} · Gateway calls</p></div><UButton icon="i-lucide-refresh-cw" variant="outline" color="neutral" :loading="status === 'pending'" @click="latest">{{ reference !== undefined ? 'All calls' : 'Latest calls' }}</UButton></div>
  <UAlert v-if="error" class="mt-6" color="error" title="Call activity unavailable" :description="(error.data as any)?.message" />
  <template v-if="data && !error">
    <div class="section-toolbar mt-6"><p class="text-xs text-muted">{{ page ? 'Viewing earlier calls. Auto-refresh resumes on the first page.' : `${reference !== undefined ? 'Viewing one call. ' : ''}Updated ${activityDate(data.sampledAt)}` }}</p><UCheckbox v-model="autoRefresh" label="Auto-refresh · 15s" /></div>
    <p class="mb-4 max-w-4xl text-sm leading-relaxed text-muted">These are incoming and outgoing calls reported by the Sipper gateway. Direct SIP calls are not included. Unconfirmed means the gateway cannot currently confirm a live state. A wake request does not prove that the phone rang.</p>
    <p class="mb-2 text-xs text-muted 2xl:hidden">Scroll sideways for more columns.</p>
    <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Gateway call activity table"><table class="management-table min-w-[1360px]">
      <caption class="sr-only">Gateway call activity</caption><thead><tr><th scope="col">Calling account</th><th scope="col">Direction</th><th scope="col">State</th><th v-if="data.canEndCalls" scope="col">Action</th><th scope="col">Started</th><th scope="col">Last change</th><th scope="col">Device / Person</th><th scope="col">Recipients / Wakes</th><th scope="col">Call reference</th></tr></thead>
      <tbody><tr v-for="call in data.calls" :key="call.id">
        <td><span class="table-person">{{ call.account_label }}</span></td><td>{{ call.direction === 'outgoing' ? 'Outgoing' : 'Incoming' }}</td>
        <td class="min-w-52"><UBadge variant="subtle" :color="gatewayCallStatus(call,now).color">{{ gatewayCallStatus(call,now).label }}</UBadge><span v-if="call.transferred_at" class="table-detail">Transferred {{ activityDate(call.transferred_at) }}</span><NuxtLink v-if="call.transferred_into" :to="{ path: route.path, query: { call: call.transferred_into } }" class="table-detail text-primary hover:underline">View continuing call</NuxtLink><span v-if="call.end_reason && !call.transferred_into" class="table-detail">{{ call.end_reason === 'admin_ended' ? 'Ended by administrator' : statusLabel(call.end_reason) }}</span><span v-else-if="call.end_requested_at" class="table-detail">Awaiting gateway confirmation</span><span v-else-if="gatewayCallStatus(call,now).label === 'Unconfirmed'" class="table-detail">Last reported: {{ statusLabel(call.state) }}</span><span v-if="call.end_requested_at" class="table-detail">Requested {{ activityDate(call.end_requested_at) }}</span></td>
        <td v-if="data.canEndCalls"><UButton v-if="canEnd(call)" color="error" variant="ghost" size="sm" class="whitespace-nowrap" :aria-label="`End call on ${call.account_label}`" @click="ending=call; actionError=''">End call</UButton><span v-else class="text-muted">—</span></td>
        <td class="whitespace-nowrap">{{ activityDate(call.created_at) }}</td><td class="whitespace-nowrap">{{ activityDate(call.updated_at) }}</td><td><span class="table-person">{{ call.device_name ?? 'Not assigned' }}</span><span class="table-detail">{{ call.person_name }}</span><span v-if="call.transferred_at" class="table-detail">Left call after transfer</span></td><td class="whitespace-nowrap">{{ call.direction === 'outgoing' ? 'Not applicable' : `${call.recipient_count} / ${call.wake_count}` }}</td><td class="font-mono text-xs"><NuxtLink :to="{ path: route.path, query: { call: call.id } }" class="hover:underline" :aria-label="`View call ${call.id}`">{{ call.id }}</NuxtLink></td>
      </tr></tbody>
    </table></div><p v-if="!data.calls.length" class="table-empty">No gateway calls in this history. Older records are removed according to the service retention policy.</p></div>
    <div v-if="reference === undefined" class="mt-4 flex flex-wrap items-center justify-between gap-3"><p class="text-xs text-muted">Page {{ page + 1 }} · {{ data.calls.length }} {{ data.calls.length === 1 ? 'call' : 'calls' }}</p><div class="flex gap-2"><UButton variant="outline" color="neutral" :disabled="!page || status === 'pending'" @click="page--">Newer</UButton><UButton variant="outline" color="neutral" :disabled="!data.nextCursor || status === 'pending'" @click="older">Older</UButton></div></div>
  </template>
  <UModal v-if="data?.canEndCalls && !error" v-model:open="endOpen" title="End this call?" description="This disconnects everyone on this gateway call. It does not change their licence or account access." :dismissible="!busy" :close="!busy">
    <template #body><div class="space-y-4"><UAlert v-if="actionError" color="error" :title="actionError" /><dl class="detail-list"><dt>Calling account</dt><dd>{{ ending?.account_label }}</dd><dt>Direction</dt><dd>{{ ending?.direction === 'outgoing' ? 'Outgoing' : 'Incoming' }}</dd><dt>Call reference</dt><dd class="font-mono text-xs break-all">{{ ending?.id }}</dd></dl><p v-if="ending?.transferred_at" class="text-sm">This call has been transferred. Ending it will disconnect the remote parties; the original device has already left.</p><p class="text-sm text-muted">The call stays marked End requested until the gateway confirms it has disconnected. If the gateway is unavailable, the request waits for it to reconnect.</p></div></template>
    <template #footer><div class="flex w-full justify-end gap-2"><UButton variant="outline" color="neutral" :disabled="busy" @click="ending=null">Cancel</UButton><UButton color="error" :loading="busy" @click="endCall">End call</UButton></div></template>
  </UModal>
</template>
