<script setup lang="ts">
import { directoryContactInput, directoryContactKey, readDirectoryCsv, type DirectoryImportResult } from '~~/shared/directory'
import { CSV_ROW_LIMIT, CSV_SIZE_LIMIT } from '~~/shared/csv'
const props = defineProps<{ organisationId: string }>()
const emit = defineEmits<{ completed: [] }>()
const open = defineModel<boolean>('open', { default: false })
const fileInputId = useId(), source = ref(''), fileError = ref(''), results = ref<DirectoryImportResult['results']>([])
const { busy, error, action } = usePortal()
const template = 'data:text/csv;charset=utf-8,' + encodeURIComponent('name,company,number,label,number2,label2\r\nReception,Example Company,+1 (202) 555-0101,Work,101,Extension\r\n')
const preview = computed(() => {
  if (!source.value.trim()) return { entries: [], error: '' }
  try {
    const seen = new Set<string>()
    const entries = readDirectoryCsv(source.value).map(entry => {
      const parsed = directoryContactInput.safeParse(entry), key = parsed.success ? directoryContactKey(parsed.data) : ''
      const duplicate = Boolean(key && seen.has(key))
      if (key) seen.add(key)
      return { entry: parsed.success ? parsed.data : entry, duplicate,
        error: parsed.success ? '' : 'Check the contact details' }
    })
    return { entries, error: '' }
  } catch (e) { return { entries: [], error: (e as Error).message } }
})
const ready = computed(() => preview.value.entries.filter(row => !row.error && !row.duplicate).length)
watch(source, () => { results.value = []; fileError.value = ''; error.value = '' })
watch(open, value => { if (!value) { source.value = ''; results.value = []; fileError.value = ''; error.value = '' } })
async function readFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file) return
  if (file.size > CSV_SIZE_LIMIT) { fileError.value = 'Use a CSV file smaller than 64 KB.'; input.value = ''; return }
  try { source.value = await file.text(); fileError.value = '' } catch { fileError.value = 'Could not read this file. Try pasting the CSV below.' }
  input.value = ''
}
async function save() {
  const body = { entries: preview.value.entries.map(row => row.entry) }
  if (new TextEncoder().encode(JSON.stringify(body)).length > CSV_SIZE_LIMIT) {
    fileError.value = 'This import is too large. Use fewer rows and try again.'
    return
  }
  const response = await action(() => $fetch<DirectoryImportResult>(`/api/platform/organisations/${props.organisationId}/directory/import`, {
    method: 'POST', body,
  }))
  if (response) { results.value = response.results; emit('completed') }
}
function editInvalid() {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  source.value = ['name,company,number,label,number2,label2,number3,label3,number4,label4,number5,label5',
    ...preview.value.entries.filter((_, index) => results.value[index]?.status === 'invalid').map(({entry}) => [entry.name,entry.company,
      ...[0,1,2,3,4].flatMap(index => [entry.numbers[index]?.number ?? '',entry.numbers[index]?.label ?? ''])].map(quote).join(',')),
  ].join('\n')
  results.value = []
}
</script>
<template>
  <UModal v-model:open="open" title="Import shared contacts" description="Preview contacts before adding them to this customer’s directory." :dismissible="!busy" :close="!busy" :ui="{ content: 'sm:max-w-3xl' }">
    <template #body><div class="space-y-5">
      <UAlert v-if="error || fileError || preview.error" color="error" :title="error || fileError || preview.error" />
      <template v-if="!results.length">
        <p class="text-sm text-muted">Use <strong>name</strong> and <strong>number</strong> columns. Add <strong>company</strong> and <strong>label</strong> if needed. For more numbers, use number2/label2 through number5/label5. Up to {{ CSV_ROW_LIMIT }} contacts per import.</p>
        <a :href="template" download="sipper-directory-template.csv" class="text-sm font-medium text-primary underline underline-offset-4">Download CSV template</a>
        <div><label :for="fileInputId" class="mb-2 block text-sm font-medium">CSV file</label><input :id="fileInputId" type="file" accept=".csv,text/csv" :disabled="busy" class="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-default file:bg-muted file:px-3 file:py-2" @change="readFile"></div>
        <UFormField label="Or paste CSV"><UTextarea v-model="source" :disabled="busy" :rows="5" :maxlength="CSV_SIZE_LIMIT" placeholder="name,number&#10;Reception,101" class="w-full font-mono text-sm" /></UFormField>
      </template>
      <p v-if="preview.entries.length" class="text-xs text-muted sm:hidden">Scroll sideways for all columns.</p>
      <div v-if="preview.entries.length" class="table-panel"><div class="table-scroll max-h-80" tabindex="0" aria-label="Shared contact import preview"><table class="management-table min-w-[560px]">
        <caption class="sr-only">Shared contact import preview and results</caption>
        <thead><tr><th scope="col">Contact</th><th scope="col">Numbers</th><th scope="col">{{ results.length ? 'Result' : 'Validation' }}</th></tr></thead>
        <tbody><tr v-for="(row,index) in preview.entries" :key="index"><td><span class="table-person" :title="row.entry.name">{{ row.entry.name || 'Missing name' }}</span><span v-if="row.entry.company" class="table-detail">{{ row.entry.company }}</span></td>
          <td><ul class="space-y-1"><li v-for="(number,numberIndex) in row.entry.numbers" :key="numberIndex"><span class="font-mono text-sm">{{ number.number || 'Missing number' }}</span><span class="ml-2 text-xs text-muted">{{ number.label }}</span></li></ul></td>
          <td><span :class="results[index]?.status === 'invalid' || row.error ? 'text-error' : results[index]?.status === 'imported' ? 'text-success' : 'text-muted'">{{ results[index]?.message ?? (row.error || (row.duplicate ? 'Duplicate row · skipped' : 'Ready')) }}</span></td>
        </tr></tbody>
      </table></div></div>
      <p v-if="results.length" class="text-sm" role="status">{{ results.filter(row => row.status === 'imported').length }} imported · {{ results.filter(row => row.status === 'skipped').length }} already present · {{ results.filter(row => row.status === 'invalid').length }} to correct.</p>
      <p v-else-if="preview.entries.length" class="text-sm text-muted" role="status">{{ ready }} ready · {{ preview.entries.filter(row => row.error).length }} invalid · {{ preview.entries.filter(row => row.duplicate).length }} duplicate.</p>
      <p v-if="!results.length" class="text-xs text-muted">Contacts with the same name, company and labelled numbers are skipped. Existing contacts are never overwritten. Invalid rows are left out.</p>
    </div></template>
    <template #footer><div class="flex w-full flex-wrap justify-end gap-3">
      <UButton color="neutral" variant="outline" :disabled="busy" @click="open=false">{{ results.length ? 'Done' : 'Cancel' }}</UButton>
      <UButton v-if="results.some(row => row.status === 'invalid')" color="neutral" variant="outline" @click="editInvalid">Edit invalid rows</UButton>
      <UButton v-if="!results.length" :disabled="!ready || Boolean(preview.error) || Boolean(fileError)" :loading="busy" @click="save">Import {{ ready }} {{ ready === 1 ? 'contact' : 'contacts' }}</UButton>
    </div></template>
  </UModal>
</template>
