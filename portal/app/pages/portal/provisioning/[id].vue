<script setup lang="ts">
definePageMeta({ layout: 'portal', middleware: 'auth' })
const id = String(useRoute().params.id), base = `/api/platform/organisations/${id}/provisioning`
const { data, error: loadError, status: connectionStatus, refresh: refreshConnection } = await useFetch<any>(base)
const search = ref(''), query = ref(''), cursors = ref<string[]>([])
const filters = computed(() => ({ q: query.value, after: cursors.value.at(-1) }))
const { data: people, error: peopleError, status: peopleStatus, refresh: refreshPeople } = await useFetch<any>(`${base}/users`, { query: filters })
const { busy, error, action } = usePortal()
const issued = ref<{ token: string; expiresAt: string } | null>(null)
const confirmation = ref<'rotate' | 'revoke' | null>(null)
const confirmOpen = computed({ get: () => confirmation.value !== null, set: value => { if (!value) confirmation.value = null } })
const connection = computed(() => data.value?.connection)
const tokenStatus = computed(() => connection.value?.enabled ? 'Active' : connection.value?.token_expires_at ? 'Expired' : connection.value ? 'Revoked' : 'Not created')
async function refresh() { await Promise.all([refreshConnection(), refreshPeople()]) }
function find() { cursors.value = []; query.value = search.value.trim() }
async function confirm() {
  if (confirmation.value === 'rotate') {
    const result = await action(() => $fetch<{ token: string; expiresAt: string }>(base, { method: 'POST', body: {} }))
    if (!result) return
    issued.value = result
  } else if (confirmation.value === 'revoke') {
    if (!await action(() => $fetch(base, { method: 'DELETE' }), 'Provisioning token revoked')) return
    issued.value = null
  } else return
  confirmation.value = null
  await refresh()
}
</script>
<template>
  <UButton :to="`/portal/organisations/${id}`" icon="i-lucide-arrow-left" variant="link" color="neutral" class="mb-4 -ml-2 max-w-full"><span class="truncate">{{ data?.organisation.name ?? 'Customer' }}</span></UButton>
  <div class="page-heading"><div><h1 class="page-title">User provisioning</h1><p class="page-description">Sync this customer’s users and groups from your identity provider using SCIM.</p></div><UButton icon="i-lucide-refresh-cw" variant="outline" color="neutral" :loading="connectionStatus === 'pending' || peopleStatus === 'pending'" @click="refresh">Refresh</UButton></div>
  <UAlert v-if="loadError" color="error" title="Could not load provisioning settings" class="mt-6" :actions="[{ label: 'Try again', onClick: () => refreshConnection() }]" />
  <UAlert v-if="error && !confirmOpen" color="error" :title="error" class="mt-6" />
  <section v-if="data" aria-labelledby="connection-heading" class="my-7 border-b border-default pb-7">
    <h2 id="connection-heading" class="mb-4 text-lg font-semibold">Connection</h2>
    <div class="grid gap-6 lg:grid-cols-2 lg:gap-12"><div class="min-w-0">
      <p class="text-sm text-muted">Use this URL and a bearer token in your identity provider’s provisioning settings. Only share the token with the provider managing this customer.</p>
      <label for="scim-url" class="mt-4 block text-sm font-medium">SCIM base URL</label>
      <UTextarea id="scim-url" :model-value="data.baseURL" readonly :rows="2" class="mt-2 w-full font-mono text-xs" :spellcheck="false" />
    </div><div class="min-w-0">
      <dl class="detail-list"><dt>Token</dt><dd><UBadge variant="subtle" :color="connection?.enabled ? 'success' : 'neutral'">{{ tokenStatus }}</UBadge></dd><template v-if="connection?.token_expires_at"><dt>Expires</dt><dd>{{ activityDate(connection.token_expires_at) }}</dd></template><dt>Last request</dt><dd>{{ activityDate(connection?.last_request_at) }}</dd></dl>
      <div class="mt-5 flex flex-wrap gap-3"><UButton :disabled="busy" @click="error = ''; confirmation = 'rotate'">{{ connection?.enabled ? 'Rotate token' : 'Create token' }}</UButton><UButton v-if="connection?.token_expires_at" color="error" variant="outline" :disabled="busy" @click="error = ''; confirmation = 'revoke'">Revoke token</UButton></div>
    </div></div>
    <p class="mt-4 max-w-3xl text-xs leading-relaxed text-muted">An active token allows provisioning requests; it does not confirm the provider is connected. Last request includes authenticated requests that failed validation.</p>
      <section v-if="issued" class="mt-5 max-w-3xl rounded-lg border border-primary p-4" aria-labelledby="new-token-heading" aria-live="polite">
        <h3 id="new-token-heading" class="font-medium">Save this token now</h3>
        <p class="mt-2 text-sm text-muted">It is shown once. Copy it into your identity provider before dismissing this message or leaving the page.</p>
        <code class="my-4 block select-all break-all text-xs">{{ issued.token }}</code>
        <UButton variant="outline" color="neutral" size="sm" @click="issued = null">Dismiss token</UButton>
      </section>
  </section>
  <section aria-labelledby="people-heading" class="mt-8">
    <h2 id="people-heading" class="mb-4 text-lg font-semibold">Provisioned people</h2>
    <form class="section-toolbar" @submit.prevent="find"><div class="flex w-full flex-wrap gap-2 sm:w-auto"><UInput v-model="search" icon="i-lucide-search" placeholder="Name or email address…" aria-label="Search provisioned people" maxlength="160" class="w-full sm:w-80" /><UButton type="submit" variant="outline" color="neutral">Search</UButton></div><p v-if="data" class="text-xs text-muted">{{ data.users.total }} {{ data.users.total === 1 ? 'person' : 'people' }} provisioned · Email A–Z</p></form>
    <UAlert v-if="peopleError" color="error" title="Could not load provisioned people" class="mb-4" :actions="[{ label: 'Try again', onClick: () => refreshPeople() }]" />
    <div v-if="peopleStatus === 'pending' && !people" role="status" aria-label="Loading provisioned people" class="space-y-2"><USkeleton v-for="row in 3" :key="row" class="h-12" /></div>
    <div v-if="people" class="table-panel" :aria-busy="peopleStatus === 'pending'"><div class="table-scroll" tabindex="0" aria-label="Provisioned people table"><table class="management-table min-w-[760px]"><caption class="sr-only">Users provisioned by this customer’s identity provider</caption><thead><tr><th scope="col">Person</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Last changed</th></tr></thead><tbody><tr v-for="person in people.users" :key="person.id"><td><span class="table-person" :title="person.name || person.email">{{ person.name || person.email }}</span><span class="table-detail" :title="person.email">{{ person.email }}</span></td><td><UBadge variant="subtle" size="sm" :color="provisioningState(person).color">{{ provisioningState(person).label }}</UBadge><span class="table-detail">{{ provisioningState(person).detail }}</span></td><td class="whitespace-nowrap">{{ activityDate(person.created_at) }}</td><td class="whitespace-nowrap">{{ activityDate(person.updated_at) }}</td></tr></tbody></table></div><p v-if="!people.users.length" class="table-empty">{{ query ? 'No provisioned people match your search.' : 'Users will appear here when your identity provider provisions them.' }}</p></div>
    <div v-if="people" class="mt-4 flex items-center justify-between gap-3"><UButton variant="outline" color="neutral" :disabled="!cursors.length || peopleStatus === 'pending'" @click="cursors.pop()">Previous</UButton><span class="text-xs text-muted">Page {{ cursors.length + 1 }}</span><UButton variant="outline" color="neutral" :disabled="!people.nextCursor || peopleStatus === 'pending'" @click="cursors.push(people.nextCursor)">Next</UButton></div>
  </section>
  <details class="mt-7 max-w-3xl text-sm leading-relaxed text-muted">
    <summary class="w-fit cursor-pointer rounded font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">Setup and access rules</summary>
    <ol class="mt-4 list-decimal space-y-3 pl-5"><li>Map the provider’s userName to each person’s sign-in email. New people join after signing in with a verified Sipper identity. Provisioning does not send an invitation email.</li><li>Assign a licence in Sipper when they need managed calling. Provisioning cannot buy licences or grant administrator access.</li><li>Manage group names and membership in the identity provider. Assign calling accounts to those groups in Sipper.</li></ol>
    <p class="mt-4">Suspension pauses customer access. Removal revokes this customer’s devices and clears assignments. Existing calls, other customers and licence charges are preserved. Direct SIP credentials must be revoked at the phone system for immediate enforcement.</p>
    <p class="mt-4">Manual removals, administrator roles and separately managed memberships take priority and appear as Needs attention. Normal SCIM-managed suspensions can be changed by the next provider sync.</p>
    <p class="mt-4">Revoking a token stops syncing. Previously provisioned people can still join after verified sign-in. Suspend or remove users before disconnecting a provider when their access should stop.</p>
    <UButton :to="`/portal/company-sign-in/${id}`" variant="link" class="mt-3 -ml-2">Configure company sign-in</UButton>
  </details>
  <UModal v-model:open="confirmOpen" :title="confirmation === 'revoke' ? 'Revoke provisioning token?' : connection?.enabled ? 'Rotate provisioning token?' : 'Create provisioning token?'" :dismissible="!busy" :close="!busy" :description="`${data?.organisation.name ?? 'This customer'} · SCIM access`">
    <template #body><UAlert v-if="error" color="error" :title="error" class="mb-4" /><p class="text-sm leading-relaxed">{{ confirmation === 'revoke' ? 'The provider will no longer be able to sync users or groups. Current memberships, licences, devices and calls stay as they are. Previously provisioned people can still join after verified sign-in.' : 'The token can create, suspend and remove provisioned users and groups for this customer. It cannot grant administrator access or assign licences. It expires after one year.' }}</p><p v-if="confirmation === 'rotate' && connection?.enabled" class="mt-3 text-sm text-muted">The current token will stop working immediately. Update the identity provider with the new token to resume syncing.</p></template>
    <template #footer><UButton variant="outline" color="neutral" :disabled="busy" @click="confirmation = null">Cancel</UButton><UButton :color="confirmation === 'revoke' ? 'error' : 'primary'" :loading="busy" @click="confirm">{{ confirmation === 'revoke' ? 'Revoke token' : connection?.enabled ? 'Rotate token' : 'Create token' }}</UButton></template>
  </UModal>
</template>
