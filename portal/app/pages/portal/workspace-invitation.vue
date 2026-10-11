<script setup lang="ts">
import { auth } from '~/lib/auth'
definePageMeta({ layout: 'portal', middleware: 'auth' })
useHead({ title: 'Join a workspace · Sipper', meta: [{ name: 'referrer', content: 'no-referrer' }] })
const route = useRoute(), session = auth.useSession()
const { busy, error, action } = usePortal()
const invitation = ref<{ workspaceName: string; role: string; expiresAt: string } | null>(null)
const token = computed(() => /^#token=([A-Za-z0-9_-]{43})$/.exec(route.hash)?.[1] ?? '')
const role = computed(() => workspaceRoles.find(item => item.value === invitation.value?.role))
const inspectedToken = ref('')
async function inspect() {
  const requested = token.value
  invitation.value = null; inspectedToken.value = ''
  const result = await action(() => $fetch<{ workspaceName: string; role: string; expiresAt: string }>('/api/platform/workspace-invitations/inspect', { method: 'POST', body: { token: requested } }))
  if (requested === token.value && result) { invitation.value = result; inspectedToken.value = requested }
}
watch(token, inspect, { immediate: true })
async function accept() {
  if (!invitation.value || inspectedToken.value !== token.value) return
  const result = await action(() => $fetch<{ workspaceId: string }>('/api/platform/workspace-invitations/accept', { method: 'POST', body: { token: token.value } }))
  if (result) await navigateTo(`/portal/workspaces/${result.workspaceId}`, { replace: true })
}
</script>
<template>
  <div class="mx-auto max-w-lg py-10"><UCard><h1 class="page-title">Join a workspace</h1><p class="page-description">Sign in with the email address that received this invitation.</p>
    <UAlert v-if="error" class="mt-6" color="error" :title="error" />
    <div v-if="invitation" class="mt-6 space-y-5"><h2 class="text-xl font-semibold">{{ invitation.workspaceName }}</h2><dl class="detail-list"><dt>Your role</dt><dd>{{ role?.label }}</dd><dt>Access</dt><dd>{{ role?.description }}</dd><dt>Expires</dt><dd>{{ activityDate(invitation.expiresAt) }}</dd></dl>
      <p class="text-sm text-muted">Staff access does not consume a calling licence.</p>
      <template v-if="!session.data?.user.twoFactorEnabled"><UAlert color="warning" title="Set up two-factor authentication first" description="Staff access requires an authenticator code as well as your password." /><UButton :to="{ path: '/portal/security', query: { next: route.path }, hash: route.hash }" block>Set up two-factor authentication</UButton></template>
      <UButton v-else :loading="busy" block @click="accept">Accept {{ role?.label.toLowerCase() }} access</UButton>
    </div>
    <p v-else-if="!busy" class="mt-5 text-sm text-muted">Open the full link in your invitation email. If you have just created an account, verify your email and then reopen that invitation.</p>
    <UButton class="mt-5" variant="link" color="neutral" to="/portal">Back to workspaces</UButton>
  </UCard></div>
</template>
