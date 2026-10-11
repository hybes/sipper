<script setup lang="ts">
import { BULK_LIMIT, readInvitationCsv, type BulkResult } from '~~/shared/bulk'
import { invitationInput } from '~~/shared/contracts'
import { CSV_SIZE_LIMIT } from '~~/shared/csv'
const props = defineProps<{ organisationId: string; canManage: boolean }>()
const emit = defineEmits<{ completed: []; reload: [] }>()
const open = defineModel<boolean>('open', { default: false })
const fileInputId = useId()
const source = ref(''), fileError = ref(''), results = ref<BulkResult['results']>([])
const { busy, error, action } = usePortal()
const preview = computed(() => {
  if (!source.value.trim()) return { entries: [], error: '' }
  try {
    const seen = new Set<string>()
    const entries = readInvitationCsv(source.value).map(entry => {
      const parsed = invitationInput.safeParse(entry)
      const duplicate = parsed.success && seen.has(parsed.data.email)
      if (parsed.success) seen.add(parsed.data.email)
      return { ...entry, error: !parsed.success ? 'Check email and role' : duplicate ? 'Duplicate email' : '' }
    })
    return { entries, error: '' }
  } catch (e) { return { entries: [], error: (e as Error).message } }
})
const ready = computed(() => preview.value.entries.filter(entry => !entry.error).length)
watch(source, () => { results.value = []; fileError.value = ''; error.value = '' })
watch(open, value => { if (!value) { source.value = ''; results.value = []; fileError.value = ''; error.value = '' } })
async function readFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file) return
  if (file.size > CSV_SIZE_LIMIT) { fileError.value = 'Use a CSV file smaller than 64 KB.'; input.value = ''; return }
  try { source.value = await file.text(); fileError.value = '' } catch { fileError.value = 'Could not read this file. Try pasting the CSV below.' }
  input.value = ''
}
async function send() {
  if (!props.canManage || !ready.value || fileError.value || preview.value.error) return
  const entries = preview.value.entries.map(({ email, role }) => ({ email, role }))
  const response = await action(() => $fetch<BulkResult>(`/api/platform/organisations/${props.organisationId}/bulk`, { method: 'POST', body: { action: 'invite', entries } }))
  if (response) { results.value = response.results; emit('completed') }
}
function editUnsent() {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  source.value = ['email,role', ...preview.value.entries.filter((_, index) => !results.value[index]?.ok && results.value[index]?.code !== 'duplicate_row').map(entry => `${quote(entry.email)},${quote(entry.role)}`)].join('\n')
  results.value = []
}
</script>
<template>
  <UModal v-model:open="open" title="Import invitations" description="Preview your list, then send invitations to this customer." :dismissible="!busy" :close="!busy" :ui="{ content: 'sm:max-w-2xl', close: 'size-11 sm:size-8' }">
    <template #body><div class="space-y-5">
      <UAlert v-if="!canManage" color="warning" title="Customer management is unavailable" description="Your list is kept. Reload this customer before sending invitations." :actions="[{ label: 'Reload customer', class: 'min-h-11 sm:min-h-0', onClick: () => emit('reload') }]" />
      <UAlert v-if="error || fileError || preview.error" color="error" :title="error || fileError || preview.error" />
      <template v-if="!results.length">
        <p class="text-sm text-muted">Use <strong>email</strong> and optionally <strong>role</strong> (user or admin). Up to {{ BULK_LIMIT }} people per import. Invitations do not assign licences.</p>
        <div><label :for="fileInputId" class="mb-2 block text-sm font-medium">CSV file</label><input :id="fileInputId" type="file" accept=".csv,text/csv" :disabled="busy" class="block w-full text-sm file:mr-3 file:min-h-11 sm:file:min-h-0 file:rounded-md file:border file:border-default file:bg-muted file:px-3 file:py-2" @change="readFile"></div>
        <UFormField label="Or paste CSV"><UTextarea v-model="source" :disabled="busy" :rows="5" :maxlength="CSV_SIZE_LIMIT" placeholder="email,role&#10;person@example.com,user" class="w-full font-mono" :ui="{ base: 'text-base sm:text-sm' }" /></UFormField>
      </template>
      <p v-if="preview.entries.length" class="text-xs text-muted sm:hidden">Scroll sideways for all columns.</p>
      <div v-if="preview.entries.length" class="table-panel"><div class="table-scroll max-h-80" tabindex="0" aria-label="Invitation import preview"><table class="management-table min-w-[460px]">
        <caption class="sr-only">Invitation import preview and results</caption>
        <thead><tr><th scope="col">Email</th><th scope="col">Access</th><th scope="col">{{ results.length ? 'Result' : 'Validation' }}</th></tr></thead>
        <tbody><tr v-for="(entry, index) in preview.entries" :key="index"><td><span class="table-person" :title="entry.email">{{ entry.email || 'Missing email' }}</span></td><td>{{ statusLabel(entry.role) }}</td><td><span :class="results[index] ? results[index]?.ok ? 'text-success' : 'text-error' : entry.error ? 'text-error' : 'text-muted'">{{ results[index]?.message ?? (entry.error || 'Ready') }}</span></td></tr></tbody>
      </table></div></div>
      <p v-if="results.length" class="text-sm" role="status">{{ results.filter(row => row.ok).length }} queued · {{ results.filter(row => !row.ok).length }} not sent.</p>
      <p v-else-if="preview.entries.length" class="text-sm text-muted" role="status">{{ ready }} ready · {{ preview.entries.length - ready }} need attention. Invalid and duplicate rows will not be sent. Admin invitations allow customer management after verified sign-in and two-factor setup.</p>
    </div></template>
    <template #footer><div class="flex w-full flex-wrap justify-end gap-3">
      <UButton color="neutral" variant="outline" class="min-h-11 sm:min-h-0" :disabled="busy" @click="open = false">{{ results.length ? 'Done' : 'Cancel' }}</UButton>
      <UButton v-if="results.some(row => !row.ok)" color="neutral" variant="outline" class="min-h-11 sm:min-h-0" @click="editUnsent">Edit unsent rows</UButton>
      <UButton v-if="!results.length" class="min-h-11 sm:min-h-0" :disabled="!canManage || !ready || Boolean(preview.error) || Boolean(fileError)" :loading="busy" @click="send">Send {{ ready }} {{ ready === 1 ? 'invitation' : 'invitations' }}</UButton>
    </div></template>
  </UModal>
</template>
