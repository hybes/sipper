<script setup lang="ts">
import { auth } from '~/lib/auth'
definePageMeta({ layout: 'portal', middleware: 'auth' })
useHead({ title: 'Join your organisation · Sipper', meta: [{ name: 'referrer', content: 'no-referrer' }] })
const route = useRoute(), session = auth.useSession()
const { busy, error, action } = usePortal()
const token = computed(() => /^#token=([A-Za-z0-9_-]{43})$/.exec(route.hash)?.[1] ?? '')
const invitation = ref<{ organisationName: string; role: 'user' | 'admin'; expiresAt: string; existingRole: 'user' | 'admin' | null } | null>(null)
const loading = ref(false), inspectedToken = ref('')
const roleLabel = computed(() => invitation.value?.role === 'admin' ? 'Administrator' : 'User')
const needsMfa = computed(() => invitation.value?.role === 'admin' && !session.value.data?.user.twoFactorEnabled)
watch(token, async requested => {
  invitation.value = null; inspectedToken.value = ''; error.value = ''
  if (!requested) { loading.value = false; return }
  loading.value = true
  try {
    const result = await $fetch<NonNullable<typeof invitation.value>>('/api/platform/invitations/inspect', { method: 'POST', body: { token: requested } })
    if (requested === token.value) { invitation.value = result; inspectedToken.value = requested }
  } catch (e: any) {
    if (requested === token.value) error.value = e?.data?.message ?? 'This invitation could not be loaded. Reopen your email or ask your administrator for a new invitation.'
  } finally { if (requested === token.value) loading.value = false }
}, { immediate: true })
async function accept() {
  if (!invitation.value || inspectedToken.value !== token.value || needsMfa.value) return
  const result = await action(() => $fetch('/api/platform/invitations/accept', { method: 'POST', body: { token: token.value } }))
  if (result) await navigateTo('/portal', { replace: true })
}
async function switchAccount() {
  await action(async () => {
    const result = await auth.signOut()
    if (result.error) throw new Error(result.error.message)
    await navigateTo({ path: '/portal/sign-in', query: { next: route.path }, hash: route.hash }, { replace: true })
  })
}
</script>
<template>
  <div class="mx-auto max-w-lg py-10"><UCard>
    <h1 class="page-title">Join your organisation</h1>
    <p class="page-description">Review your access before accepting this invitation.</p>
    <UAlert v-if="error" class="mt-6" color="error" :title="error" />
    <p v-if="loading" role="status" class="mt-6 text-sm text-muted">Loading invitation…</p>
    <div v-else-if="invitation" class="mt-6 space-y-5">
      <h2 class="break-words text-xl font-semibold">{{ invitation.organisationName }}</h2>
      <dl class="detail-list"><dt>Invited role</dt><dd>{{ roleLabel }}</dd><dt>Access</dt><dd>{{ invitation.role === 'admin' ? 'Manage this customer’s people, groups, devices and calling settings.' : 'Use your assigned calling accounts in Sipper.' }}</dd><dt>Expires</dt><dd>{{ activityDate(invitation.expiresAt) }}</dd></dl>
      <UAlert v-if="invitation.existingRole" color="neutral" title="You already belong to this customer" :description="`Accepting keeps your current ${invitation.existingRole === 'admin' ? 'administrator' : 'user'} role. Ask an administrator if it needs changing.`" />
      <p class="text-sm text-muted">Your administrator assigns your calling licence and accounts. Accepting an invitation does not start a subscription.</p>
      <template v-if="needsMfa"><UAlert color="warning" title="Set up two-factor authentication first" description="Administrator access requires an authenticator code as well as your password." /><UButton :to="{ path: '/portal/security', query: { next: route.path }, hash: route.hash }" block>Set up two-factor authentication</UButton></template>
      <UButton v-else :loading="busy" block @click="accept">Accept invitation</UButton>
    </div>
    <p v-else-if="!loading && !error" class="mt-6 text-sm text-muted">Open the full link in your invitation email. If you have just created an account, verify your email and then reopen the invitation.</p>
    <div class="mt-6 border-t border-default pt-5"><p class="break-all text-sm text-muted">Signed in as {{ session.data?.user.email }}</p><UButton class="mt-2 -ml-2" variant="link" color="neutral" :disabled="busy || loading" @click="switchAccount">Use a different account</UButton></div>
    <UButton class="mt-3 -ml-2" variant="link" color="neutral" to="/portal">Back to workspaces</UButton>
  </UCard></div>
</template>
