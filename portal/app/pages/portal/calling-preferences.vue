<script setup lang="ts">
definePageMeta({ layout: 'portal', middleware: 'auth' })
type Customer = { id: string; name: string; status: string; do_not_disturb: boolean; availability: string; share_status: boolean; share_activity: boolean; calling_preference_updated_at: string | null }
const { data, error: loadError, status, refresh } = await useFetch<{ organisations: Customer[] }>('/api/platform/me/calling-preferences')
const { busy, error, action } = usePortal()
const search = ref(''), savingId = ref<string | null>(null)
const customers = computed(() => data.value?.organisations.filter(customer => customer.name.toLowerCase().includes(search.value.trim().toLowerCase())) ?? [])
async function reload() { error.value = ''; await refresh() }
const availabilityOptions = [{ label: 'Not set', value: 'unset' }, { label: 'Available', value: 'available' }, { label: 'Away', value: 'away' }, { label: 'Busy', value: 'busy' }]
async function setPreference(customer: Customer, preference: { doNotDisturb?: boolean; availability?: string; shareStatus?: boolean; shareActivity?: boolean }) {
  if (busy.value) return
  savingId.value = customer.id
  const result = await action(() => $fetch<{ doNotDisturb: boolean; availability: string; shareStatus: boolean; shareActivity: boolean; updatedAt: string | null }>(`/api/platform/me/calling-preferences/${customer.id}`, {
    method: 'PATCH', body: preference,
  }), preference.shareActivity !== undefined ? 'Call activity sharing updated' : preference.shareStatus !== undefined ? 'Status sharing updated' : preference.availability ? 'Availability updated' : preference.doNotDisturb ? 'Do Not Disturb turned on' : 'Do Not Disturb turned off')
  if (result) { customer.do_not_disturb = result.doNotDisturb; customer.availability = result.availability; customer.share_status = result.shareStatus; customer.share_activity = result.shareActivity; customer.calling_preference_updated_at = result.updatedAt }
  await refresh()
  savingId.value = null
}
</script>
<template>
  <div class="page-heading"><div><h1 class="page-title">Calling preferences</h1><p class="page-description">Set your availability and incoming call preferences for each customer.</p></div><UButton icon="i-lucide-refresh-cw" variant="outline" color="neutral" :disabled="busy" :loading="status === 'pending'" @click="reload">Refresh</UButton></div>
  <p class="my-6 max-w-3xl text-sm leading-relaxed text-muted">Do Not Disturb stops new managed incoming calls. Gateway changes take effect immediately. Direct PBX accounts apply the change when the app refreshes its settings. Calls already ringing or connected can continue, and you can still make outgoing calls.</p>
  <div class="section-toolbar"><UInput v-model="search" icon="i-lucide-search" placeholder="Find a customer…" aria-label="Find a customer" class="w-full sm:w-80" /></div>
  <UAlert v-if="loadError" color="error" title="Could not load your calling preferences" :description="(loadError.data as any)?.message" class="my-4" :actions="[{ label: 'Try again', onClick: reload }]" />
  <UAlert v-if="error" color="error" :title="error" class="my-4" />
  <div v-if="status === 'pending' && !data" role="status" aria-label="Loading calling preferences"><USkeleton class="h-24" /></div>
  <p v-if="data && !loadError" class="mb-2 text-xs text-muted sm:hidden">Scroll sideways for more preferences.</p>
  <section v-if="data && !loadError" aria-label="Your calling preferences" class="table-panel" :aria-busy="busy || status === 'pending'">
    <div class="table-scroll" tabindex="0" aria-label="Calling preferences table"><table class="management-table min-w-[920px]">
      <caption class="sr-only">Your availability and incoming call preferences by customer</caption>
      <thead><tr><th scope="col">Customer</th><th scope="col">Availability</th><th scope="col">Do Not Disturb</th><th scope="col">Share status</th><th scope="col">Share call activity</th><th scope="col">Last changed</th></tr></thead>
      <tbody><tr v-for="customer in customers" :key="customer.id">
        <td><span class="block w-40 break-words font-medium text-highlighted sm:w-64">{{ customer.name }}</span><span v-if="customer.status !== 'active'" class="table-detail">Membership {{ customer.status }}</span></td>
        <td><USelect :model-value="customer.availability" :items="availabilityOptions" :aria-label="`Availability for ${customer.name}`" :disabled="busy || status === 'pending' || customer.status !== 'active'" class="w-32" @update:model-value="setPreference(customer, { availability: $event })" /></td>
        <td><div class="flex items-center gap-3 whitespace-nowrap"><UBadge :color="customer.do_not_disturb ? 'warning' : 'neutral'" variant="subtle" size="sm">{{ customer.do_not_disturb ? 'On' : 'Off' }}</UBadge><UButton size="sm" color="neutral" variant="outline" :aria-label="`${customer.do_not_disturb ? 'Turn off' : 'Turn on'} Do Not Disturb for ${customer.name}`" :disabled="busy || status === 'pending' || customer.status !== 'active'" :loading="savingId === customer.id" @click="setPreference(customer, { doNotDisturb: !customer.do_not_disturb })">{{ customer.do_not_disturb ? 'Turn off' : 'Turn on' }}</UButton></div></td>
        <td><UCheckbox :model-value="customer.share_status" label="With colleagues" class="whitespace-nowrap" :aria-label="`Share status with colleagues at ${customer.name}`" :disabled="busy || status === 'pending' || customer.status !== 'active'" @update:model-value="setPreference(customer, { shareStatus: $event === true })" /></td>
        <td><UCheckbox :model-value="customer.share_activity" label="With colleagues" class="whitespace-nowrap" :aria-label="`Share call activity with colleagues at ${customer.name}`" :disabled="busy || status === 'pending' || customer.status !== 'active'" @update:model-value="setPreference(customer, { shareActivity: $event === true })" /></td>
        <td class="whitespace-nowrap">{{ activityDate(customer.calling_preference_updated_at) }}</td>
      </tr></tbody>
    </table></div>
    <p v-if="!customers.length" class="table-empty">{{ search.trim() ? 'No customers match your search.' : 'No customer memberships yet. Accept an invitation to manage your calling preferences.' }}</p>
  </section>
  <p class="mt-4 max-w-3xl text-xs leading-relaxed text-muted">Your administrator can see your availability and Do Not Disturb setting. Sharing also shows them to licensed colleagues through a directory contact linked to your membership. Both sharing options start off. Call activity sharing separately shows recent managed ringing, dialling, connected and held calls, with the report source. It shares no caller, destination, device or personal-call details. Turning sharing off clears that information within 30 seconds. Missing activity does not mean someone is free. Availability stays until you change or clear it and does not confirm that you can answer. Personal SIP accounts are unaffected. Older apps may not support Do Not Disturb for direct PBX accounts, and offline apps keep their last call settings until expiry.</p>
</template>
