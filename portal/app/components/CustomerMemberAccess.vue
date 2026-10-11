<script setup lang="ts">
const props = defineProps<{ organisationId: string; person: { user_id: string; name: string; email: string; role: string; status: string; removed_at?: string }; viewerId?: string; workspaceAdmin: boolean }>()
const emit = defineEmits<{ changed: []; invite: [] }>()
const { busy, error, action } = usePortal()
const mode = ref<'role' | 'remove' | null>(null), role = ref('user')
const open = computed({ get: () => mode.value !== null, set: value => { if (!value) mode.value = null } })
const roles = [{ label: 'User', value: 'user', description: 'Use assigned calling accounts on managed devices.' }, { label: 'Administrator', value: 'admin', description: 'Manage this customer’s people, groups, devices and calling settings. Two-factor authentication is required.' }]
function show(next: 'role' | 'remove') { error.value = ''; role.value = props.person.role; mode.value = next }
async function save() {
  const removing = mode.value === 'remove', userId = props.person.user_id
  const result = await action(() => $fetch(`/api/platform/organisations/${props.organisationId}/members/${encodeURIComponent(userId)}${removing ? '' : '/role'}`, {
    method: removing ? 'DELETE' : 'PATCH', ...(removing ? {} : { body: { role: role.value } }),
  }), removing ? 'Person removed from this customer' : 'Customer role updated')
  if (!result) return
  mode.value = null
  if (userId === props.viewerId && !props.workspaceAdmin && (removing || role.value === 'user')) { await navigateTo('/portal'); return }
  emit('changed')
}
</script>
<template>
  <section class="space-y-3" aria-label="Customer permissions">
    <h2 class="font-semibold">Customer permissions</h2>
    <template v-if="person.status === 'removed'"><p class="text-sm text-muted">Removed {{ activityDate(person.removed_at) }}. Send a new invitation to restore access; previous devices and calling assignments stay revoked.</p><UButton variant="outline" color="neutral" icon="i-lucide-mail" @click="emit('invite')">Invite again</UButton></template>
    <template v-else><p class="text-sm text-muted">{{ person.role === 'admin' ? 'Administrator for this customer.' : 'Calling user for this customer.' }} Workspace staff access is managed separately.</p><div class="flex flex-wrap gap-2"><UButton variant="outline" color="neutral" icon="i-lucide-user-round-cog" @click="show('role')">Change role</UButton><UButton variant="soft" color="error" icon="i-lucide-user-round-minus" @click="show('remove')">Remove person</UButton></div></template>
  </section>
  <UModal v-model:open="open" :title="mode === 'remove' ? 'Remove from this customer?' : 'Change customer role'" :description="person.email" :dismissible="!busy" :close="!busy">
    <template #body><form class="space-y-5" @submit.prevent="save"><UAlert v-if="error" :title="error" color="error" />
      <template v-if="mode === 'role'"><UFormField label="Customer role" :help="roles.find(item => item.value === role)?.description"><USelect v-model="role" :items="roles" :disabled="busy" class="w-full" /></UFormField><p class="text-sm text-muted">Changing this role does not assign or release a licence, or change workspace staff access.</p></template>
      <template v-else><p class="text-sm text-muted">This revokes this person’s managed devices, push tokens, calling assignments and unused invitations for this customer. A fresh invitation is needed to join again.</p><p class="text-sm text-muted">Other customers, personal SIP accounts, workspace staff access and established calls stay in place. Their workspace licence is kept; release it separately if it is no longer needed.</p><p class="text-sm text-muted">Direct SIP credentials must also be revoked at the phone system for immediate enforcement. Offline apps remove their managed configuration when they reconnect or its validity expires.</p></template>
      <UAlert v-if="person.user_id === viewerId && !workspaceAdmin && (mode === 'remove' || role === 'user')" color="warning" title="You will lose management access to this customer" description="A workspace administrator can restore your access." />
      <div class="flex justify-end gap-3"><UButton variant="outline" color="neutral" :disabled="busy" @click="mode = null">Cancel</UButton><UButton type="submit" :color="mode === 'remove' ? 'error' : 'primary'" :loading="busy">{{ mode === 'remove' ? 'Remove person' : 'Save role' }}</UButton></div>
    </form></template>
  </UModal>
</template>
