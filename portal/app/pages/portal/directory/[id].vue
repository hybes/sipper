<script setup lang="ts">
import { directoryContactInput, type DirectoryContact, type DirectoryContactInput, type DirectoryPage } from '~~/shared/directory'
definePageMeta({ layout: 'portal', middleware: 'auth' })
useHead({ title: 'Company directory · Sipper' })
const id = String(useRoute().params.id), base = `/api/platform/organisations/${id}/directory`
const search = ref(''), queryText = ref(''), page = ref(0)
const cursors = ref<Array<{ after?: string; revision?: string }>>([{}])
const query = computed(() => ({ q: queryText.value, ...cursors.value[page.value] }))
const { data, error: loadError, refresh, status } = await useFetch<DirectoryPage>(base, { query })
const { data: customer, error: memberError } = await useFetch<{ members: Array<{ user_id: string; name: string; email: string; status: string }> }>(`/api/platform/organisations/${id}`)
const memberOptions = computed(() => [{ label: 'No linked member', value: 'none' }, ...(customer.value?.members ?? [])
  .filter(member => member.status === 'active' || member.user_id === draft.memberUserId)
  .map(member => ({ label: `${member.name} · ${member.email}${member.status === 'active' ? '' : ` (${member.status})`}`, value: `member:${member.user_id}`, disabled: member.status !== 'active' }))])
const memberName = (userId?: string | null) => customer.value?.members.find(member => member.user_id === userId)?.name ?? (userId ? 'Linked member' : 'None')
const { busy, error, action } = usePortal()
const open = ref(false), importOpen = ref(false), editing = ref<DirectoryContact | null>(null), deleting = ref<DirectoryContact | null>(null)
const deleteOpen = computed({ get: () => Boolean(deleting.value), set: value => { if (!value) deleting.value = null } })
const draft = reactive<DirectoryContactInput>({ name: '', company: '', numbers: [{ label: 'Work', number: '' }] })
const fields = ref<Record<string,string>>({})
async function first() {
  const changed = page.value !== 0 || cursors.value[0]?.revision
  page.value = 0; cursors.value = [{}]
  if (!changed) await refresh()
}
function find() { queryText.value = search.value.trim(); page.value = 0; cursors.value = [{}] }
function next() {
  if (!data.value?.nextCursor) return
  cursors.value = [...cursors.value.slice(0,page.value+1),{after:data.value.nextCursor,revision:data.value.revision}]
  page.value++
}
function edit(contact?: DirectoryContact) {
  error.value = ''; fields.value = {}; editing.value = contact ?? null
  Object.assign(draft, contact ? { name:contact.name,company:contact.company,memberUserId:contact.memberUserId,numbers:contact.numbers.map(number=>({...number})) }
    : { name:'',company:'',memberUserId:null,numbers:[{label:'Work',number:''}] })
  open.value = true
}
async function save() {
  fields.value = {}
  const parsed = directoryContactInput.safeParse(draft)
  if (!parsed.success) {
    fields.value = Object.fromEntries(parsed.error.issues.map(issue=>[issue.path.join('.'),issue.message]))
    error.value = 'Check the highlighted fields and try again.'
    return
  }
  const result = await action(() => $fetch(`${base}${editing.value ? `/${editing.value.id}` : ''}`, {
    method: editing.value ? 'PATCH' : 'POST', body: { ...parsed.data, ...(editing.value ? {revision:editing.value.revision} : {}) },
  }), editing.value ? 'Contact updated' : 'Contact added')
  if (result) { open.value = false; await first() }
}
async function remove() {
  if (!deleting.value) return
  const result = await action(() => $fetch(`${base}/${deleting.value!.id}`, { method:'DELETE',query:{revision:deleting.value!.revision} }), 'Contact deleted')
  if (result) { deleting.value = null; await first() }
}
</script>
<template>
  <UButton :to="`/portal/organisations/${id}`" icon="i-lucide-arrow-left" variant="link" color="neutral" class="mb-4 -ml-2">Customer</UButton>
  <div class="page-heading"><div><h1 class="page-title">Company directory</h1><p class="page-description">{{ data?.organisation.name ?? 'Customer' }} · Shared contacts</p></div>
    <div class="flex flex-wrap gap-2"><UButton variant="outline" color="neutral" :loading="status === 'pending'" @click="first">Refresh</UButton><UButton variant="outline" color="neutral" :disabled="!data || Boolean(loadError)" @click="importOpen=true">Import CSV</UButton><UButton :disabled="!data || Boolean(loadError)" @click="edit()">Add contact</UButton></div>
  </div>
  <p class="mt-4 max-w-3xl text-sm text-muted">Manage this customer’s shared contacts. Personal contacts in Sipper are kept separately.</p>
  <form class="section-toolbar mt-6" role="search" @submit.prevent="find">
    <div class="flex w-full flex-wrap gap-2 sm:w-auto"><UInput v-model="search" aria-label="Search company directory" placeholder="Name, company or number…" :maxlength="160" icon="i-lucide-search" class="w-full sm:w-80" /><UButton type="submit" variant="outline" color="neutral" :loading="status === 'pending'">Search</UButton></div>
    <p v-if="data && !loadError" class="text-xs text-muted" role="status">Page {{ page+1 }} · {{ data.contacts.length }} {{ data.contacts.length === 1 ? 'contact' : 'contacts' }}</p>
  </form>
  <UAlert v-if="loadError" class="mb-4" color="error" title="Directory unavailable" :description="(loadError.data as any)?.message" :actions="[{label:'Refresh directory',onClick:()=>first()}]" />
  <UAlert v-if="error && !open && !deleteOpen" class="mb-4" color="error" :title="error" />
  <template v-if="data && !loadError">
    <p class="mb-2 text-xs text-muted sm:hidden">Scroll sideways for more columns.</p>
    <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Company directory table"><table class="management-table min-w-[760px]">
      <caption class="sr-only">Shared company contacts</caption><thead><tr><th scope="col">Contact</th><th scope="col">Numbers</th><th scope="col">Member status</th><th scope="col">Last edited</th><th scope="col">Actions</th></tr></thead>
      <tbody><tr v-for="contact in data.contacts" :key="contact.id"><td><button class="table-person text-left hover:underline" @click="edit(contact)">{{ contact.name }}</button><span v-if="contact.company" class="table-detail">{{ contact.company }}</span></td>
        <td><ul class="space-y-1"><li v-for="number in contact.numbers" :key="number.number" class="flex flex-wrap gap-x-3"><span class="font-mono text-sm">{{ number.number }}</span><span class="text-xs text-muted">{{ number.label }}</span></li></ul></td>
        <td>{{ memberName(contact.memberUserId) }}<span v-if="contact.memberUserId" class="table-detail">Shown only if shared</span></td>
        <td class="whitespace-nowrap">{{ activityDate(contact.updatedAt) }}</td><td><div class="flex gap-1"><UButton size="sm" variant="ghost" color="neutral" :aria-label="`Edit ${contact.name}`" @click="edit(contact)">Edit</UButton><UButton size="sm" variant="ghost" color="error" :aria-label="`Delete ${contact.name}`" @click="deleting=contact; error=''">Delete</UButton></div></td>
      </tr></tbody>
    </table></div><p v-if="!data.contacts.length" class="table-empty">{{ queryText ? 'No shared contacts match your search.' : 'No shared contacts yet. Add a person or a useful company number.' }}</p></div>
    <div class="mt-4 flex justify-end gap-2"><UButton variant="outline" color="neutral" :disabled="!page || status==='pending'" @click="page--">Previous</UButton><UButton variant="outline" color="neutral" :disabled="!data.nextCursor || status==='pending'" @click="next">Next</UButton></div>
  </template>
  <p v-else-if="status === 'pending'" class="py-8 text-sm text-muted" role="status">Loading directory…</p>
  <DirectoryImport v-model:open="importOpen" :organisation-id="id" @completed="first" />
  <UModal v-model:open="open" :title="editing ? 'Edit shared contact' : 'Add shared contact'" description="This contact belongs to this customer’s company directory." :dismissible="!busy" :close="!busy">
    <template #body><form class="space-y-5" @submit.prevent="save"><UAlert v-if="error" color="error" :title="error" />
      <UFormField label="Name" required :error="fields.name"><UInput v-model="draft.name" required :maxlength="160" autofocus class="w-full" /></UFormField>
      <UFormField label="Company" :error="fields.company"><UInput v-model="draft.company" :maxlength="160" class="w-full" /></UFormField>
      <UFormField label="Member status" description="Link a customer member to show their shared availability and Do Not Disturb setting. Each person controls sharing in Calling preferences." :error="memberError ? 'Member list unavailable. Reopen this page to try again.' : fields.memberUserId">
        <USelect :model-value="draft.memberUserId ? `member:${draft.memberUserId}` : 'none'" :items="memberOptions" :disabled="Boolean(memberError)" aria-label="Linked customer member" class="w-full" @update:model-value="draft.memberUserId=$event === 'none' ? null : $event.slice(7)" />
      </UFormField>
      <fieldset class="space-y-4"><legend class="mb-3 text-sm font-medium">Telephone numbers</legend>
        <div v-for="(number,index) in draft.numbers" :key="index" class="flex flex-wrap items-end gap-2">
          <UFormField :label="`Label ${index+1}`" :error="fields[`numbers.${index}.label`]" class="w-24 shrink-0"><UInput v-model="number.label" required :maxlength="32" class="w-full" /></UFormField>
          <UFormField :label="`Number ${index+1}`" :error="fields[`numbers.${index}.number`]" class="min-w-40 flex-1"><UInput v-model="number.number" type="tel" required :maxlength="128" class="w-full" /></UFormField>
          <UButton icon="i-lucide-x" variant="ghost" color="neutral" :aria-label="`Remove number ${index+1}`" :disabled="draft.numbers.length===1" @click="draft.numbers.splice(index,1)" />
        </div>
        <UButton variant="outline" color="neutral" :disabled="draft.numbers.length===5" @click="draft.numbers.push({label:'Mobile',number:''})">Add another number</UButton>
        <p v-if="fields.numbers" class="text-sm text-error" role="alert">{{ fields.numbers }}</p>
        <p class="text-xs text-muted">Up to five telephone numbers or extensions. Formatting spaces and brackets are removed when saved.</p>
      </fieldset>
      <UButton type="submit" block :loading="busy">Save contact</UButton>
    </form></template>
  </UModal>
  <UModal v-model:open="deleteOpen" :title="`Delete ${deleting?.name ?? 'contact'}?`" description="This removes the shared contact from this customer’s directory. Personal contacts are unaffected." :dismissible="!busy" :close="!busy">
    <template #body><UAlert v-if="error" color="error" :title="error" /><p v-else class="text-sm text-muted">This cannot be undone.</p></template>
    <template #footer><div class="flex w-full justify-end gap-2"><UButton variant="outline" color="neutral" :disabled="busy" @click="deleting=null">Cancel</UButton><UButton color="error" :loading="busy" @click="remove">Delete contact</UButton></div></template>
  </UModal>
</template>
