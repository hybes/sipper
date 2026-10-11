<script setup lang="ts">
import { sortRows } from '~~/shared/table-sort'
definePageMeta({ layout: 'portal', middleware: 'auth' })
const { data, error: loadError, refresh, status } = await useFetch<any>('/api/platform/overview')
const { busy, error, action } = usePortal()
const loadMessage = computed(() => (loadError.value?.data as { message?: string } | undefined)?.message)
const createOpen = ref(false), name = ref(''), kind = ref('business')
const search = ref(''), kindFilter = ref('all'), page = ref(1)
const workspaces = computed(() => sortRows((data.value?.workspaces ?? []).filter((workspace: any) =>
  workspace.name.toLowerCase().includes(search.value.toLowerCase()) && (kindFilter.value === 'all' || workspace.kind === kindFilter.value)), (workspace: any) => workspace.name, 'ascending'))
watch([search, kindFilter], () => { page.value = 1 })
async function create() { const result = await action(() => $fetch<any>('/api/platform/workspaces', { method: 'POST', body: { name: name.value, kind: kind.value } }), 'Workspace created'); if (result) await navigateTo(`/portal/workspaces/${result.id}`) }
</script>
<template>
  <div class="page-heading"><div><h1 class="page-title">{{ data?.platformOwner ? 'All workspaces' : 'Workspaces' }}</h1><p class="page-description">{{ data?.platformOwner ? 'Platform owner access to customers, people, subscriptions and activity across Sipper.' : 'Choose a workspace to view its customers, people and licences.' }}</p></div><div class="flex flex-wrap gap-2"><UButton v-if="data?.platformOwner" to="/portal/service" icon="i-lucide-activity" variant="outline" color="neutral">Service status</UButton><UButton v-if="data?.user.mfa" icon="i-lucide-plus" @click="createOpen = true">New workspace</UButton></div></div>
  <UAlert v-if="loadError" color="error" title="Could not load your workspaces" :description="loadMessage" class="mt-8" :actions="[{ label: 'Try again', onClick: () => refresh() }]" />
  <UAlert v-if="data && !data.user.mfa" icon="i-lucide-shield-check" title="Secure your administrator account" description="Set up two-factor authentication to create or manage a workspace. You can still use your invited calling accounts." class="mt-8" :actions="[{ label: 'Set up security', to: '/portal/security' }]" />
  <div v-if="status === 'pending' && !data" class="mt-8 space-y-2" role="status" aria-label="Loading workspaces"><USkeleton v-for="row in 4" :key="row" class="h-12" /></div>
  <div v-if="data?.workspaces.length" class="section-toolbar mt-6"><div class="flex w-full flex-wrap gap-2 sm:w-auto"><UInput v-model="search" icon="i-lucide-search" placeholder="Search workspaces…" aria-label="Search workspaces" class="w-full sm:w-64" /><USelect v-model="kindFilter" :items="[{ label: 'All types', value: 'all' }, { label: 'Business', value: 'business' }, { label: 'Reseller', value: 'reseller' }]" aria-label="Workspace type" class="w-full sm:w-40" /></div><p class="text-xs text-muted" role="status">{{ workspaces.length }} {{ workspaces.length === 1 ? 'workspace' : 'workspaces' }}</p></div>
  <div v-if="data?.workspaces.length" class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Workspaces table"><table class="management-table min-w-[840px]">
    <caption class="sr-only">Workspaces</caption><thead><tr><th scope="col">Workspace</th><th scope="col">Type</th><th scope="col">Your access</th><th scope="col">Licensed people</th><th scope="col">Subscription</th><th scope="col">Manage</th></tr></thead>
    <tbody><tr v-for="w in workspaces.slice((page - 1) * 25, page * 25)" :key="w.id"><td><NuxtLink :to="`/portal/workspaces/${w.id}`" class="table-person hover:underline">{{ w.name }}</NuxtLink></td><td>{{ w.kind === 'reseller' ? 'Reseller' : 'Business' }}</td><td class="whitespace-nowrap">{{ data.platformOwner ? 'Platform owner' : workspaceRoles.find(role => role.value === w.role)?.label ?? statusLabel(w.role) }}</td><td>{{ w.assigned_seats }} <span class="text-muted">/ {{ w.purchased_seats }}</span></td><td><UBadge variant="subtle" size="sm" :color="['active', 'trialing'].includes(w.subscription_status) ? 'success' : 'neutral'">{{ statusLabel(w.subscription_status) }}</UBadge></td><td><UButton :to="`/portal/workspaces/${w.id}`" variant="ghost" color="neutral" size="sm">Open workspace</UButton></td></tr></tbody>
  </table></div><p v-if="!workspaces.length" class="table-empty">No workspaces match your filters.</p></div>
  <UCard v-else-if="data?.user.mfa" class="mt-8"><div class="py-10 text-center"><UIcon name="i-lucide-building-2" class="size-12 text-stone-300" /><h2 class="mt-4 text-xl font-semibold">Start with your first workspace</h2><p class="mx-auto mt-2 max-w-md text-stone-500">Choose a business workspace for your own team, or a reseller workspace to manage several customers.</p><UButton class="mt-6" @click="createOpen = true">Create workspace</UButton></div></UCard>
  <UPagination v-if="workspaces.length > 25" v-model:page="page" :total="workspaces.length" :items-per-page="25" class="mt-4" />
  <section v-if="data?.organisations.length" class="mt-10">
    <h2 class="mb-4 text-xl font-semibold">Your calling organisations</h2>
    <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Your calling organisations table"><table class="management-table min-w-[640px]">
      <caption class="sr-only">Your calling organisations</caption>
      <thead><tr><th scope="col">Organisation</th><th scope="col">Your access</th><th scope="col">Status</th><th scope="col">Manage</th></tr></thead>
      <tbody><tr v-for="org in data.organisations" :key="org.id">
        <td><NuxtLink v-if="org.role === 'admin'" :to="`/portal/organisations/${org.id}`" class="table-person hover:underline">{{ org.name }}</NuxtLink><span v-else class="table-person">{{ org.name }}</span></td>
        <td class="whitespace-nowrap">{{ org.role === 'admin' ? 'Customer administrator' : 'Managed calling' }}</td>
        <td><UBadge :color="org.status === 'active' ? 'success' : 'warning'" variant="subtle" size="sm">{{ statusLabel(org.status) }}</UBadge></td>
        <td><UButton v-if="org.role === 'admin'" :to="`/portal/organisations/${org.id}`" variant="ghost" color="neutral" size="sm">Manage customer</UButton><span v-else class="text-xs text-muted">Sign in to the Sipper app to receive your calling settings.</span></td>
      </tr></tbody>
    </table></div></div>
  </section>
  <UModal v-model:open="createOpen" title="Create a workspace" description="Licences are shared across the people in this workspace."><template #body><form class="space-y-5" @submit.prevent="create"><UAlert v-if="error" :title="error" color="error" /><UFormField label="Workspace name" required><UInput v-model="name" autofocus required maxlength="160" class="w-full" placeholder="Your company" /></UFormField><UFormField label="What will you manage?"><USelect v-model="kind" :items="[{ label: 'Our own business', value: 'business' }, { label: 'Several customers as a reseller', value: 'reseller' }]" class="w-full" /></UFormField><UButton type="submit" :loading="busy" block>Create workspace</UButton></form></template></UModal>
</template>
