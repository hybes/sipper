<script setup lang="ts">
definePageMeta({ layout: 'portal', middleware: 'auth' })
const search = ref(''), query = ref(''), state = ref('all'), cursors = ref<string[]>([])
const filters = computed(() => ({ q: query.value, state: state.value, after: cursors.value.at(-1) }))
const { data, error: loadError, status, refresh } = await useFetch<any>('/api/platform/me/devices', { query: filters })
const { busy, error, action } = usePortal()
const selected = ref<any>(null), revokeOpen = ref(false)
const detailOpen = computed({ get: () => selected.value !== null, set: (open: boolean) => { if (!open) selected.value = null } })
watch(state, () => { cursors.value = [] })
function find() { cursors.value = []; query.value = search.value.trim() }
async function revoke() {
  const device = selected.value
  if (!device) return
  const result = await action(() => $fetch(`/api/platform/me/devices/${device.id}`, { method: 'DELETE' }), 'Device access revoked')
  if (result) { revokeOpen.value = false; selected.value = null; await refresh() }
}
</script>
<template>
  <div class="page-heading"><div><h1 class="page-title">My devices</h1><p class="page-description">Review the devices connected to your managed calling accounts.</p></div><UButton icon="i-lucide-refresh-cw" variant="outline" color="neutral" :loading="status === 'pending'" @click="refresh()">Refresh</UButton></div>
  <p class="mb-6 max-w-3xl text-sm text-muted">Each row is one device’s connection to a customer. Personal SIP accounts and browser sessions are separate.</p>
  <form class="section-toolbar" @submit.prevent="find"><div class="flex w-full flex-wrap gap-2 sm:w-auto"><UInput v-model="search" icon="i-lucide-search" placeholder="Device, customer or IP address…" aria-label="Search your devices" maxlength="160" class="w-full sm:w-80" /><UButton type="submit" variant="outline" color="neutral">Search</UButton><USelect v-model="state" :items="[{label:'All devices',value:'all'}, {label:'Enrolled',value:'enrolled'}, {label:'Revoked',value:'revoked'}]" aria-label="Device access" class="w-full sm:w-40" /></div><p class="text-xs text-muted">Newest enrolments first</p></form>
  <UAlert v-if="loadError" color="error" title="Could not load your devices" :description="(loadError.data as any)?.message" class="my-4" :actions="[{ label: 'Try again', onClick: () => refresh() }]" />
  <div v-if="status === 'pending' && !data" class="space-y-2" role="status" aria-label="Loading your devices"><USkeleton v-for="row in 4" :key="row" class="h-12" /></div>
  <section v-if="data" aria-label="Your managed devices" class="table-panel" :aria-busy="status === 'pending'">
    <div class="table-scroll" tabindex="0" aria-label="Your devices table"><table class="management-table min-w-[1000px]">
      <caption class="sr-only">Your devices and managed app activity</caption>
      <thead><tr><th scope="col">Device</th><th scope="col">Customer</th><th scope="col">Device access</th><th scope="col">Last login</th><th scope="col">Last request</th><th scope="col">Request IP</th><th scope="col">Manage</th></tr></thead>
      <tbody><tr v-for="device in data.devices" :key="device.id">
        <td><button class="table-person text-left hover:underline" @click="selected = device">{{ device.name }}</button><span class="table-detail">{{ platformLabel(device.platform) }} · {{ device.app_version }}</span></td>
        <td class="max-w-52 break-words">{{ device.organisation_name }}<span v-if="device.membership_status !== 'active'" class="table-detail">Membership {{ device.membership_status }}</span></td>
        <td><UBadge variant="subtle" size="sm" :color="device.revoked_at ? 'neutral' : 'primary'">{{ device.revoked_at ? 'Revoked' : 'Enrolled' }}</UBadge></td>
        <td class="whitespace-nowrap">{{ activityDate(device.last_login_at) }}</td>
        <td class="whitespace-nowrap">{{ activityDate(device.last_request_at) }}</td>
        <td class="max-w-44 break-all font-mono text-xs">{{ device.last_request_ip ?? 'Not recorded' }}</td>
        <td><UButton variant="ghost" color="neutral" size="sm" :aria-label="`Details for ${device.name}, ${device.organisation_name}`" @click="selected = device">Details</UButton></td>
      </tr></tbody>
    </table></div>
    <p v-if="!data.devices.length" class="table-empty">{{ query || state !== 'all' || cursors.length ? 'No devices match your filters.' : 'No managed devices yet. Sign in to the Sipper app and connect a customer to enrol this device.' }}</p>
  </section>
  <div v-if="data && (cursors.length || data.nextCursor)" class="mt-4 flex items-center justify-between gap-3"><UButton variant="outline" color="neutral" :disabled="!cursors.length || status === 'pending'" @click="cursors.pop()">Previous</UButton><span class="text-xs text-muted">Page {{ cursors.length + 1 }}</span><UButton variant="outline" color="neutral" :disabled="!data.nextCursor || status === 'pending'" @click="cursors.push(data.nextCursor)">Next</UButton></div>
  <p class="mt-4 max-w-4xl text-xs leading-relaxed text-muted">Enrolled means this device has not been revoked; it does not confirm a licence, a SIP registration or that it can receive calls. Request IPs describe the last connection to Sipper and may be shared by several devices.</p>
  <UModal v-model:open="detailOpen" title="Device details" description="Your managed connection and recorded activity."><template #body><div v-if="selected" class="space-y-5">
    <dl class="detail-list"><dt>Device</dt><dd>{{ selected.name }}</dd><dt>Customer</dt><dd>{{ selected.organisation_name }}</dd><dt>Platform</dt><dd>{{ platformLabel(selected.platform) }}</dd><dt>App version</dt><dd>{{ selected.app_version }}</dd><dt>OS version</dt><dd>{{ selected.os_version }}</dd><dt>Enrolled</dt><dd>{{ activityDate(selected.enrolled_at) }}</dd><dt>Last login</dt><dd>{{ activityDate(selected.last_login_at) }}</dd><dt>Last request</dt><dd>{{ activityDate(selected.last_request_at) }}</dd><dt>Request IP</dt><dd class="break-all font-mono text-xs">{{ selected.last_request_ip ?? 'Not recorded' }}</dd><dt>Last app report</dt><dd>{{ activityDate(selected.last_report_at) }}</dd><template v-if="selected.revoked_at"><dt>Revoked</dt><dd>{{ activityDate(selected.revoked_at) }}</dd></template></dl>
    <p class="text-xs leading-relaxed text-muted">Login and request times relate to this customer’s managed app access. Revoking access preserves your licence, other devices and personal SIP accounts.</p>
    <UButton v-if="!selected.revoked_at" color="error" variant="outline" @click="error = ''; revokeOpen = true">Revoke device access</UButton>
  </div></template></UModal>
  <UModal v-model:open="revokeOpen" title="Revoke device access?" :description="`${selected?.name ?? 'This device'} · ${selected?.organisation_name ?? ''}`"><template #body><div class="space-y-4"><UAlert v-if="error" color="error" :title="error" /><p class="text-sm">This stops new managed configuration, gateway access and push notifications for this connection. Established calls are not ended.</p><p class="text-sm text-muted">An offline app may keep its saved settings until they expire. Direct PBX credentials remain valid until your administrator changes them at the phone system.</p><p class="text-sm text-muted">To reconnect later, remove this customer from the app, then connect it again.</p><div class="flex justify-end gap-3"><UButton variant="outline" color="neutral" :disabled="busy" @click="revokeOpen = false">Cancel</UButton><UButton color="error" :loading="busy" @click="revoke">Revoke access</UButton></div></div></template></UModal>
</template>
