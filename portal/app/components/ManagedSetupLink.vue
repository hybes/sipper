<script setup lang="ts">
import QRCode from 'qrcode'
const props = defineProps<{
  organisationId: string
  canManage: boolean
  now: number
}>()
const emit = defineEmits<{ changed: []; reload: []; opened: [] }>()
const { busy, error, action } = usePortal()
const created = ref<{ id: string; url: string; expiresAt: string; email: string } | null>(null), qr = ref(''), copied = ref(false), qrError = ref(false)
const open = computed({ get: () => Boolean(created.value), set: value => { if (!value) { created.value = null; qr.value = ''; copied.value = false } } })
const expired = computed(() => Boolean(created.value && new Date(created.value.expiresAt).getTime() <= props.now))
async function create(person: { user_id: string; email: string; status: string; licensed: boolean }) {
  if (busy.value || !props.canManage || person.status !== 'active' || !person.licensed) return
  await action(async () => {
    const result = await $fetch<{ id: string; url: string; expiresAt: string }>(`/api/platform/organisations/${props.organisationId}/members/${person.user_id}/setup-link`, { method: 'POST', body: {} })
    created.value = { ...result, email: person.email }; copied.value = false; qr.value = ''; qrError.value = false
    emit('opened')
    emit('changed')
    try {
      const image = await QRCode.toDataURL(result.url, { width: 256, margin: 2, errorCorrectionLevel: 'M' })
      if (created.value?.id === result.id) qr.value = image
    } catch { if (created.value?.id === result.id) qrError.value = true }
  })
}
async function revoke(id: string) {
  if (busy.value || !props.canManage) return
  if (await action(() => $fetch(`/api/platform/organisations/${props.organisationId}/setup-links/${id}`, { method: 'DELETE' }), 'Setup link revoked')) {
    if (created.value?.id === id) open.value = false
    emit('changed')
  }
}
async function copy() {
  const link = created.value
  if (!link || busy.value || expired.value) return
  if (await action(async () => { await navigator.clipboard.writeText(link.url); return true }) && created.value?.id === link.id) copied.value = true
}
</script>
<template>
  <slot :create="create" :revoke="revoke" :busy="busy" />
  <UModal v-model:open="open" title="Set up a device" description="Share this link only with the person shown below." :dismissible="!busy" :close="!busy" :ui="{ close: 'size-11 sm:size-8' }">
    <template #body><div v-if="created" class="space-y-4">
      <UAlert v-if="!canManage" color="warning" title="Customer management is unavailable" description="Your setup link is kept. Reload this customer before revoking it." :actions="[{ label: 'Reload customer', class: 'min-h-11 sm:min-h-0', onClick: () => emit('reload') }]" />
      <UAlert v-if="error" color="error" :title="error" />
      <UAlert v-if="expired" color="warning" title="This setup link has expired" description="Close this dialog and create a new link for this person." />
      <p class="break-all text-sm font-medium">{{ created.email }}</p>
      <img v-if="qr && !expired" :src="qr" alt="QR code for this person's Sipper setup link" width="256" height="256" class="mx-auto max-w-full rounded-lg bg-white">
      <p v-if="qrError" class="text-sm text-muted">The QR code could not be created. You can still copy the setup link below.</p>
      <p class="text-sm text-muted">Sign in to the Sipper app with this email to connect. The link contains no SIP credentials. Expires {{ activityDate(created.expiresAt) }}.</p>
      <UFormField label="Setup link"><UInput :model-value="created.url" readonly class="w-full font-mono" :ui="{ base: 'text-base sm:text-sm' }" /></UFormField>
      <div class="flex flex-wrap gap-2"><UButton icon="i-lucide-copy" class="min-h-11 sm:min-h-0" :disabled="expired || busy" @click="copy">{{ copied ? 'Copied' : 'Copy link' }}</UButton><UButton variant="outline" color="neutral" class="min-h-11 sm:min-h-0" :disabled="!canManage" :loading="busy" @click="revoke(created.id)">Revoke link</UButton></div>
    </div></template>
  </UModal>
</template>
