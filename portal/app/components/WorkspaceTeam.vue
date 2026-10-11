<script setup lang="ts">
const props = defineProps<{ workspaceId: string; currentUserId?: string }>()
const emit = defineEmits<{ changed: [] }>()
const base = `/api/platform/workspaces/${props.workspaceId}`
const { data, error: loadError, refresh } = await useFetch<any>(`${base}/staff`)
const { busy, error, action } = usePortal()
const search = ref(''), inviteOpen = ref(false), email = ref(''), inviteRole = ref('admin')
const selected = ref<any>(null), nextRole = ref('admin'), removing = ref(false)
const memberOpen = computed({ get: () => Boolean(selected.value), set: value => { if (!value) selected.value = null } })
const members = computed(() => (data.value?.members ?? []).filter((m: any) => `${m.name} ${m.email}`.toLowerCase().includes(search.value.toLowerCase())))
const roleLabel = (role: string) => workspaceRoles.find(item => item.value === role)?.label ?? statusLabel(role)
async function invite() {
  if (await action(() => $fetch(`${base}/staff-invitations`, { method: 'POST', body: { email: email.value, role: inviteRole.value } }), 'Staff invitation queued')) {
    inviteOpen.value = false; email.value = ''; await refresh()
  }
}
function edit(member: any, remove = false) { error.value = ''; selected.value = member; nextRole.value = member.role; removing.value = remove }
function openInvite() { error.value = ''; inviteOpen.value = true }
async function saveMember() {
  const target = selected.value, remove = removing.value
  if (!target) return
  if (await action(() => $fetch(`${base}/staff/${encodeURIComponent(target.user_id)}`, { method: remove ? 'DELETE' : 'PATCH', ...(remove ? {} : { body: { role: nextRole.value } }) }), remove ? 'Staff access removed' : 'Staff role updated')) {
    selected.value = null
    if (target.user_id === props.currentUserId && (remove || ['billing', 'support'].includes(nextRole.value))) { await navigateTo('/portal'); return }
    await refresh(); emit('changed')
  }
}
async function revoke(id: string) {
  if (await action(() => $fetch(`${base}/staff-invitations/${id}`, { method: 'DELETE' }), 'Invitation revoked')) await refresh()
}
</script>
<template>
  <section aria-label="Workspace team">
    <div class="section-toolbar"><div><h2 class="text-xl font-semibold">Workspace team</h2><p class="page-description">Staff access covers this workspace. Calling licences are managed separately.</p></div><div class="flex flex-wrap gap-2"><UButton variant="outline" color="neutral" icon="i-lucide-refresh-cw" @click="refresh()">Refresh</UButton><UButton v-if="data?.canManage" icon="i-lucide-user-round-plus" @click="openInvite">Invite staff</UButton></div></div>
    <UAlert v-if="loadError" color="error" title="Could not load the workspace team" class="mb-4" />
    <template v-if="data">
      <p v-if="!data.canManage" class="mb-4 text-sm text-muted">Workspace owners manage staff roles and invitations.</p>
      <UInput v-model="search" icon="i-lucide-search" placeholder="Find staff…" aria-label="Search workspace staff" class="mb-4 w-full sm:w-72" />
      <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Workspace staff table"><table class="management-table min-w-[720px]">
        <caption class="sr-only">Workspace staff and administrative access</caption><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Joined</th><th v-if="data.canManage" scope="col">Actions</th></tr></thead>
        <tbody><tr v-for="member in members" :key="member.user_id"><td><span class="table-person">{{ member.name }}<span v-if="member.user_id === currentUserId" class="text-xs text-muted"> · You</span></span><span class="table-detail" :title="member.email">{{ member.email }}</span></td><td><UBadge variant="subtle" :color="member.role === 'owner' ? 'primary' : 'neutral'">{{ roleLabel(member.role) }}</UBadge></td><td class="whitespace-nowrap text-muted">{{ activityDate(member.joined_at) }}</td><td v-if="data.canManage"><div class="flex gap-1"><UButton size="sm" variant="ghost" color="neutral" :disabled="busy" :aria-label="`Change role for ${member.name}`" @click="edit(member)">Change role</UButton><UButton size="sm" variant="ghost" color="error" :disabled="busy" :aria-label="`Remove staff access for ${member.name}`" @click="edit(member, true)">Remove</UButton></div></td></tr></tbody>
      </table></div><p v-if="!members.length" class="table-empty">No staff match your search.</p></div>
      <div class="mt-8"><h2 class="mb-2 text-xl font-semibold">Recent invitations</h2><p class="mb-4 text-sm text-muted">The latest 200 invitations. Only the invited email can accept, after verification and two-factor setup.</p>
        <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Staff invitations table"><table class="management-table min-w-[720px]">
          <caption class="sr-only">Workspace staff invitations</caption><thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Expires</th><th v-if="data.canManage" scope="col">Actions</th></tr></thead>
          <tbody><tr v-for="invitation in data.invitations" :key="invitation.id"><td><span class="table-person" :title="invitation.email">{{ invitation.email }}</span></td><td>{{ roleLabel(invitation.role) }}</td><td><UBadge variant="subtle" color="neutral">{{ invitation.accepted_at ? 'Accepted' : invitation.revoked_at ? 'Revoked' : new Date(invitation.expires_at).getTime() <= Date.now() ? 'Expired' : 'Pending' }}</UBadge></td><td class="whitespace-nowrap text-muted">{{ activityDate(invitation.expires_at) }}</td><td v-if="data.canManage"><UButton v-if="!invitation.accepted_at && !invitation.revoked_at && new Date(invitation.expires_at).getTime() > Date.now()" variant="ghost" color="neutral" size="sm" :loading="busy" :aria-label="`Revoke invitation for ${invitation.email}`" @click="revoke(invitation.id)">Revoke</UButton></td></tr></tbody>
        </table></div><p v-if="!data.invitations.length" class="table-empty">No staff invitations yet.</p></div>
      </div>
    </template>
  </section>
  <UModal v-model:open="inviteOpen" :dismissible="!busy" :close="!busy" title="Invite workspace staff" description="Choose the access this person needs across the workspace. This does not assign a calling licence.">
    <template #body><form class="space-y-5" @submit.prevent="invite"><UAlert v-if="error" :title="error" color="error" /><UFormField label="Email address"><UInput v-model="email" type="email" required maxlength="320" class="w-full" /></UFormField><UFormField label="Role" :help="workspaceRoles.find(item => item.value === inviteRole)?.description"><USelect v-model="inviteRole" :items="workspaceRoles" class="w-full" /></UFormField><p class="text-sm text-muted">The invitation expires in seven days. A new invitation replaces any unused invitation for this email.</p><UButton type="submit" :loading="busy" block>Send staff invitation</UButton></form></template>
  </UModal>
  <UModal v-model:open="memberOpen" :title="removing ? 'Remove staff access?' : 'Change staff role'" :description="selected?.email" :dismissible="!busy" :close="!busy">
    <template #body><form class="space-y-5" @submit.prevent="saveMember"><UAlert v-if="error" :title="error" color="error" /><UFormField v-if="!removing" label="Role" :help="workspaceRoles.find(item => item.value === nextRole)?.description"><USelect v-model="nextRole" :items="workspaceRoles" class="w-full" /></UFormField><p class="text-sm text-muted">{{ removing ? 'This removes workspace staff access. Any customer memberships, calling licences and established calls stay in place.' : 'The new role takes effect on the next request. Customer memberships and calling licences stay in place.' }}</p><p v-if="selected?.role === 'owner'" class="text-sm text-muted">At least one owner must remain. Removing owner access also revokes outstanding invitations created by that owner.</p><div class="flex justify-end gap-3"><UButton variant="outline" color="neutral" :disabled="busy" @click="selected = null">Cancel</UButton><UButton type="submit" :color="removing ? 'error' : 'primary'" :loading="busy">{{ removing ? 'Remove staff access' : 'Save role' }}</UButton></div></form></template>
  </UModal>
</template>
