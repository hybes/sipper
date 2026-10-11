<script setup lang="ts">
definePageMeta({ layout: 'portal', middleware: 'auth' })
const route = useRoute(), id = String(route.params.id), base = `/api/platform/organisations/${id}/company-sign-in`
const { data, error: loadError, refresh } = await useFetch<any>(base)
const { busy, error, action } = usePortal()
const provider = computed(() => data.value?.provider)
const domain = ref(provider.value?.domain ?? ''), issuer = ref(provider.value?.issuer ?? ''), clientId = ref(provider.value?.clientId ?? ''), clientSecret = ref('')
const confirmOpen = ref(false)
async function save() {
  if (await action(() => $fetch(base, { method: 'PUT', body: { domain: domain.value, issuer: issuer.value, clientId: clientId.value, clientSecret: clientSecret.value } }), 'Company sign-in settings saved')) {
    clientSecret.value = ''; await refresh()
  }
}
async function verify() { if (await action(() => $fetch(`${base}/verify`, { method: 'POST', body: {} }), 'Email domain verified')) await refresh() }
async function toggle() {
  if (await action(() => $fetch(base, { method: 'PATCH', body: { enabled: !provider.value.enabled } }))) { confirmOpen.value = false; await refresh() }
}
</script>
<template>
  <UButton :to="`/portal/organisations/${id}`" icon="i-lucide-arrow-left" variant="link" color="neutral" class="mb-4 -ml-2">Customer</UButton>
  <h1 class="page-title">Company sign-in</h1>
  <p class="page-description">Let people sign in with your company’s OpenID Connect identity provider. Invitations, licences and Sipper administrator MFA still apply.</p>
  <UAlert v-if="loadError" color="error" title="Could not load company sign-in" class="mt-6" :actions="[{ label: 'Try again', onClick: () => refresh() }]" />
  <UAlert v-if="error" color="error" :title="error" class="mt-6" />
  <div v-if="data" class="mt-8 grid gap-10 lg:grid-cols-2">
    <section aria-labelledby="connection-heading">
      <h2 id="connection-heading" class="mb-5 text-lg font-semibold">Identity provider</h2>
      <form class="max-w-lg space-y-5" @submit.prevent="save">
        <UFormField label="Email domain" help="Use the exact domain in your users’ email addresses. You must be able to add a DNS record." required><UInput v-model="domain" placeholder="company.example" :disabled="Boolean(provider)" required class="w-full" /></UFormField>
        <UFormField label="Issuer URL" help="The issuer from your provider’s OpenID Connect discovery document." required><UInput v-model="issuer" type="url" placeholder="https://identity.example/tenant" :disabled="Boolean(provider)" required class="w-full" /></UFormField>
        <UFormField label="Client ID" required><UInput v-model="clientId" :disabled="Boolean(provider)" required class="w-full" /></UFormField>
        <UFormField :label="provider ? 'New client secret' : 'Client secret'" help="Stored encrypted and never shown again." required><UInput v-model="clientSecret" type="password" autocomplete="new-password" required class="w-full" /></UFormField>
        <UButton type="submit" :loading="busy">{{ provider ? 'Update client secret' : 'Save connection' }}</UButton>
      </form>
      <p class="mt-5 max-w-lg text-xs leading-relaxed text-muted">One connection per customer. The issuer, email domain and client ID stay fixed to protect linked identities. Contact the platform administrator if you need to migrate to another provider.</p>
    </section>
    <section v-if="provider" aria-labelledby="activation-heading" class="min-w-0 border-t border-default pt-8 lg:border-t-0 lg:pt-0">
      <div class="mb-5 flex flex-wrap items-center gap-3"><h2 id="activation-heading" class="text-lg font-semibold">Connection setup</h2><UBadge variant="subtle" :color="provider.enabled ? 'success' : 'neutral'">{{ provider.enabled ? 'Enabled' : 'Disabled' }}</UBadge></div>
      <h3 class="font-medium">1. Add the redirect URI</h3>
      <p class="mt-2 text-sm text-muted">Copy this exact URI into the web application’s redirect settings at your identity provider.</p>
      <code class="mt-3 block select-all break-all rounded-md border border-default bg-muted p-3 text-xs">{{ provider.callbackURL }}</code>
      <h3 class="mt-7 font-medium">2. Verify the email domain</h3>
      <p class="mt-2 text-sm text-muted">Add this TXT record to your domain’s DNS settings.</p>
      <dl class="mt-4 space-y-3 text-sm"><div><dt class="text-muted">Record name</dt><dd class="mt-1 select-all break-all font-mono text-xs">{{ provider.verification.name }}</dd></div><div><dt class="text-muted">TXT value</dt><dd class="mt-1 select-all break-all font-mono text-xs">{{ provider.verification.value }}</dd></div></dl>
      <div class="mt-4 flex flex-wrap items-center gap-3"><UButton variant="outline" color="neutral" :loading="busy" @click="verify">Check DNS record</UButton><span v-if="provider.verifiedAt" class="text-sm text-muted">Verified {{ activityDate(provider.verifiedAt) }}</span></div>
      <h3 class="mt-7 font-medium">3. Enable company sign-in</h3>
      <p class="mt-2 text-sm text-muted">People can use “Sign in with your company” on the Sipper sign-in page. Existing Sipper passwords continue to work. Disabling this connection stops new company sign-ins; it does not sign out existing sessions or end calls.</p>
      <UButton class="mt-4" :color="provider.enabled ? 'neutral' : 'primary'" :variant="provider.enabled ? 'outline' : 'solid'" :disabled="!provider.verifiedAt || busy" @click="confirmOpen = true">{{ provider.enabled ? 'Disable company sign-in' : 'Enable company sign-in' }}</UButton>
    </section>
  </div>
  <UModal v-model:open="confirmOpen" :title="provider?.enabled ? 'Disable company sign-in?' : 'Enable company sign-in?'" :description="provider?.enabled ? 'New company sign-ins will stop. Existing sessions, passwords and calls remain available.' : 'This provider will be trusted to authenticate email addresses at this verified domain. Sipper roles, invitations, licences and administrator MFA remain in place.'">
    <template #footer><UButton color="neutral" variant="outline" :disabled="busy" @click="confirmOpen = false">Cancel</UButton><UButton :loading="busy" @click="toggle">{{ provider?.enabled ? 'Disable sign-in' : 'Enable sign-in' }}</UButton></template>
  </UModal>
</template>
