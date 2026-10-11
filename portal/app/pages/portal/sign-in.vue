<script setup lang="ts">
import { auth } from '~/lib/auth'
const route = useRoute()
const email = ref(''), password = ref(''), code = ref('')
const challenge = ref(route.query.challenge === 'company'), recovery = ref(false), company = ref(false)
const { busy, error, action } = usePortal()
const next = computed(() => typeof route.query.next === 'string' && route.query.next.startsWith('/portal') && !route.query.next.startsWith('//') ? route.query.next : '/portal')
const destination = computed(() => invitationDestination(next.value, route.hash))
const signupLink = computed(() => ({ path: '/portal/sign-up', query: { next: route.query.sig ? route.fullPath : next.value }, hash: destination.value !== next.value ? route.hash : '' }))
async function companySignIn() {
  await action(async () => {
    const flow = crypto.randomUUID(), key = `sipper-company-sign-in:${flow}`
    // Invitation fragments stay in this browser, never in provider/state URLs.
    sessionStorage.setItem(key, JSON.stringify({ createdAt: Date.now(), destination: destination.value }))
    try {
      const callbackURL = `${location.origin}/portal/company-callback?flow=${flow}`
      const result = await $fetch<{ url: string }>('/api/auth/sign-in/sso', { method: 'POST', body: { email: email.value, callbackURL, errorCallbackURL: callbackURL, ...(route.query.sig ? { oauth_query: location.search.slice(1) } : {}) } })
      location.assign(result.url)
    } catch (cause) { sessionStorage.removeItem(key); throw cause }
  })
}
async function submit() {
  await action(async () => {
    const result = challenge.value
      ? recovery.value ? await auth.twoFactor.verifyBackupCode({ code: code.value }) : await auth.twoFactor.verifyTotp({ code: code.value })
      // Better Auth redirects automatically when callbackURL is supplied. Keep invitation
      // navigation here so the reference never enters that server-side callback URL.
      : await auth.signIn.email({ email: email.value, password: password.value, ...(destination.value === next.value ? { callbackURL: next.value } : {}) })
    if (result.error) throw new Error(result.error.message)
    if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) { challenge.value = true; password.value = ''; return }
    if (result.data && 'url' in result.data && typeof result.data.url === 'string' && result.data.url && destination.value === next.value) { location.assign(result.data.url); return }
    await navigateTo(destination.value, { replace: true })
  })
}
</script>
<template>
  <AuthShell>
    <h1 class="text-3xl font-semibold tracking-tight">{{ challenge ? 'One more step' : company ? 'Company sign-in' : 'Welcome back' }}</h1>
    <p class="mb-8 mt-3 text-stone-500">{{ challenge ? 'Confirm it’s you to open your workspace.' : destination !== next ? 'Sign in to continue to your invitation.' : 'Sign in to manage your people and calling accounts.' }}</p>
    <UAlert v-if="route.query.verified" color="success" title="Email verified. You can sign in now." class="mb-6" />
    <UAlert v-if="error" color="error" :title="error" class="mb-6" />
    <form class="space-y-5" @submit.prevent="company && !challenge ? companySignIn() : submit()">
      <template v-if="!challenge"><UFormField label="Email address" required><UInput v-model="email" type="email" autocomplete="username" class="w-full" size="lg" required /></UFormField><UFormField v-if="!company" label="Password" required><UInput v-model="password" type="password" autocomplete="current-password" class="w-full" size="lg" required /></UFormField></template>
      <UFormField v-else :label="recovery ? 'Recovery code' : 'Authenticator code'" required><UInput v-model="code" :inputmode="recovery ? 'text' : 'numeric'" autocomplete="one-time-code" class="w-full" size="lg" required autofocus /></UFormField>
      <UButton type="submit" block size="lg" :loading="busy">{{ challenge ? 'Verify and sign in' : company ? 'Continue to company sign-in' : 'Sign in' }}</UButton>
    </form>
    <UButton v-if="challenge" variant="link" class="mt-4" @click="recovery = !recovery; code = ''">{{ recovery ? 'Use an authenticator code' : 'Use a recovery code' }}</UButton>
    <template v-else><UButton block variant="outline" color="neutral" class="mt-4" :disabled="busy" @click="company = !company; password = ''; error = ''">{{ company ? 'Use a Sipper password' : 'Sign in with your company' }}</UButton><div v-if="!company" class="mt-5 text-center"><NuxtLink to="/portal/forgot-password" class="text-sm text-primary">Forgot your password?</NuxtLink></div><p class="mt-10 text-center text-sm text-stone-500">New to Sipper? <NuxtLink :to="signupLink" class="font-medium text-primary">Create an account</NuxtLink></p></template>
  </AuthShell>
</template>
