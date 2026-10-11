<script setup lang="ts">
import { auth } from '~/lib/auth'
const name = ref(''), email = ref(''), password = ref(''), sent = ref(false)
const { busy, error, action } = usePortal()
const route = useRoute()
const next = computed(() => typeof route.query.next === 'string' && route.query.next.startsWith('/portal') ? route.query.next : '/portal')
const hasInvitation = computed(() => invitationDestination(next.value, route.hash) !== next.value)
const signInLink = computed(() => ({ path: '/portal/sign-in', query: { next: next.value }, hash: hasInvitation.value ? route.hash : '' }))
async function submit() {
  await action(async () => {
    const callback = new URL('/portal/sign-in', location.origin)
    callback.searchParams.set('verified', '1')
    if (typeof route.query.next === 'string' && route.query.next.startsWith('/portal')) callback.searchParams.set('next', route.query.next)
    const result = await auth.signUp.email({ name: name.value, email: email.value, password: password.value, callbackURL: callback.toString() })
    if (result.error) throw new Error(result.error.message)
    sent.value = true; password.value = ''
  })
}
</script>
<template>
  <AuthShell>
    <template v-if="sent"><UIcon name="i-lucide-mail-check" class="mb-5 size-12 text-primary" /><h1 class="text-3xl font-semibold tracking-tight">Check your inbox</h1><p class="mt-4 leading-relaxed text-stone-500">We’ve sent a verification link to <strong>{{ email }}</strong>. Open it to finish creating your account.</p><p v-if="hasInvitation" class="mt-4 text-sm text-muted">After verifying your email, reopen your invitation to review and accept your access.</p><UButton :to="signInLink" variant="soft" class="mt-8">Back to sign in</UButton></template>
    <template v-else><h1 class="text-3xl font-semibold tracking-tight">{{ hasInvitation ? 'Create your Sipper account' : 'Make room for your team' }}</h1><p class="mb-8 mt-3 text-stone-500">{{ hasInvitation ? 'Use the email address from your invitation. Verify it, then review your access.' : 'Create your account, then choose your workspace and licences.' }}</p><UAlert v-if="error" color="error" :title="error" class="mb-6" /><form class="space-y-5" @submit.prevent="submit"><UFormField label="Your name" required><UInput v-model="name" autocomplete="name" class="w-full" size="lg" required /></UFormField><UFormField label="Email address" required><UInput v-model="email" type="email" autocomplete="username" class="w-full" size="lg" required /></UFormField><UFormField label="Password" help="Use at least 12 characters." required><UInput v-model="password" type="password" autocomplete="new-password" minlength="12" class="w-full" size="lg" required /></UFormField><UButton type="submit" block size="lg" :loading="busy">Create account</UButton></form><p class="mt-8 text-center text-sm text-stone-500">Already have an account? <NuxtLink :to="signInLink" class="text-primary">Sign in</NuxtLink></p></template>
  </AuthShell>
</template>
