<script setup lang="ts">
import { auth } from '~/lib/auth'
const email = ref(''), sent = ref(false)
const { busy, error, action } = usePortal()
async function submit() { await action(async () => { const result = await auth.requestPasswordReset({ email: email.value, redirectTo: '/portal/reset-password' }); if (result.error) throw new Error(result.error.message); sent.value = true }) }
</script>
<template><AuthShell><h1 class="text-3xl font-semibold">Reset your password</h1><p class="mb-8 mt-3 text-stone-500">{{ sent ? 'If this address has an account, a reset link is on its way.' : 'We’ll email you a link to choose a new password.' }}</p><UAlert v-if="error" :title="error" color="error" class="mb-5" /><form v-if="!sent" class="space-y-5" @submit.prevent="submit"><UFormField label="Email address"><UInput v-model="email" type="email" autocomplete="email" required class="w-full" size="lg" /></UFormField><UButton type="submit" :loading="busy" block size="lg">Send reset link</UButton></form><UButton to="/portal/sign-in" variant="link" class="mt-6">Back to sign in</UButton></AuthShell></template>
