<script setup lang="ts">
import QRCode from 'qrcode'
import { auth } from '~/lib/auth'
definePageMeta({ layout: 'portal', middleware: 'auth' })
const session = auth.useSession()
const route = useRoute()
const returnTo = computed(() => invitationDestination(typeof route.query.next === 'string' && isInvitationPath(route.query.next) ? route.query.next : '/portal', route.hash))
const password = ref(''), code = ref(''), qr = ref(''), manualKey = ref(''), backupCodes = ref<string[]>([])
const needsPassword = ref(true)
onMounted(async () => { const result = await auth.listAccounts(); if (result.data) needsPassword.value = result.data.some(account => account.providerId === 'credential') })
const { busy, error, action } = usePortal()
async function enable() {
  await action(async () => {
    const result = await auth.twoFactor.enable({ password: password.value })
    if (result.error) throw new Error(result.error.message)
    if (!result.data || result.data.method !== 'totp') throw new Error('Authenticator setup is unavailable.')
    backupCodes.value = result.data.backupCodes
    manualKey.value = new URL(result.data.totpURI).searchParams.get('secret') ?? ''
    qr.value = await QRCode.toDataURL(result.data.totpURI, { margin: 2, width: 240 })
    password.value = ''
  })
}
async function verify() {
  await action(async () => {
    const result = await auth.twoFactor.verifyTotp({ code: code.value })
    if (result.error) throw new Error(result.error.message)
    qr.value = ''; manualKey.value = ''; code.value = ''
    await auth.getSession({ fetchOptions: { cache: 'no-store' } })
  }, 'Two-factor authentication is enabled')
}
function saveCodes() {
  const url = URL.createObjectURL(new Blob([`Sipper recovery codes\nKeep these somewhere safe. Each code works once.\n\n${backupCodes.value.join('\n')}\n`], { type: 'text/plain' }))
  const link = document.createElement('a'); link.href = url; link.download = 'sipper-recovery-codes.txt'; link.click(); URL.revokeObjectURL(url)
}
async function revokeOthers() { await action(async () => { const r = await auth.revokeOtherSessions(); if (r.error) throw new Error(r.error.message) }, 'Other browser sessions signed out') }
</script>
<template>
  <div class="max-w-3xl"><h1 class="page-title">Security</h1><p class="page-description">Protect your account before you start managing other people’s access.</p>
    <UAlert v-if="error" color="error" :title="error" class="mb-6" />
    <UCard class="mt-8"><template #header><div class="flex items-center justify-between gap-4"><h2 class="font-semibold">Two-factor authentication</h2><UBadge :color="session.data?.user.twoFactorEnabled ? 'success' : 'warning'" variant="soft">{{ session.data?.user.twoFactorEnabled ? 'Enabled' : 'Setup required for admins' }}</UBadge></div></template>
      <p class="mb-5 text-sm leading-relaxed text-stone-500">Use an authenticator app to add a second check when you sign in. Two-factor authentication is required for administrators.</p>
      <form v-if="!session.data?.user.twoFactorEnabled && !qr" class="max-w-md space-y-4" @submit.prevent="enable"><UFormField v-if="needsPassword" label="Confirm your password"><UInput v-model="password" type="password" autocomplete="current-password" class="w-full" required /></UFormField><UButton type="submit" :loading="busy" icon="i-lucide-shield-plus">Set up two-factor authentication</UButton></form>
      <div v-if="qr" class="space-y-5"><div><p class="mb-4 font-medium">1. Scan this code in your authenticator app</p><img :src="qr" alt="Authenticator setup QR code" width="240" height="240" class="rounded-lg border border-stone-200" /><details class="mt-4 text-sm"><summary class="cursor-pointer text-sipper-600">Enter a setup key instead</summary><code class="mt-2 block break-all rounded bg-stone-100 p-3 text-stone-900">{{ manualKey }}</code></details></div><form class="max-w-md space-y-4" @submit.prevent="verify"><UFormField label="2. Enter the six-digit code"><UInput v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="w-full" required /></UFormField><UButton type="submit" :loading="busy">Verify and enable</UButton></form></div>
      <div v-if="backupCodes.length" class="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-5 text-stone-900"><h3 class="font-semibold">Keep your recovery codes safe</h3><p class="mb-4 mt-2 text-sm">Use these if you lose access to your authenticator. Each code works once. They are only shown during setup.</p><div class="grid grid-cols-2 gap-2 font-mono text-sm"><span v-for="item in backupCodes" :key="item">{{ item }}</span></div><UButton class="mt-4" color="neutral" variant="outline" icon="i-lucide-download" @click="saveCodes">Save recovery codes</UButton></div>
      <UButton v-if="session.data?.user.twoFactorEnabled" :to="returnTo" class="mt-6" trailing-icon="i-lucide-arrow-right">{{ returnTo !== '/portal' ? 'Return to invitation' : 'Continue to workspaces' }}</UButton>
    </UCard>
    <UCard class="mt-6"><template #header><h2 class="font-semibold">Browser sessions</h2></template><p class="mb-4 text-sm text-stone-500">Sign out other browsers if you have used a shared or unfamiliar computer.</p><UButton variant="outline" color="neutral" :loading="busy" @click="revokeOthers">Sign out other browsers</UButton></UCard>
  </div>
</template>
