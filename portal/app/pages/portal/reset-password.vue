<script setup lang="ts">
import { auth } from '~/lib/auth'
const route = useRoute(), password = ref(''), done = ref(false)
const { busy, error, action } = usePortal()
async function submit() { await action(async () => { const result = await auth.resetPassword({ newPassword: password.value, token: String(route.query.token ?? '') }); if (result.error) throw new Error(result.error.message); done.value = true; password.value = '' }) }
</script>
<template><AuthShell><h1 class="text-3xl font-semibold">{{ done ? 'Password updated' : 'Choose a new password' }}</h1><p class="mb-8 mt-3 text-stone-500">{{ done ? 'Sign in with your new password.' : 'Use at least 12 characters.' }}</p><UAlert v-if="error" :title="error" color="error" class="mb-5" /><form v-if="!done" class="space-y-5" @submit.prevent="submit"><UFormField label="New password"><UInput v-model="password" type="password" autocomplete="new-password" required minlength="12" class="w-full" size="lg" /></UFormField><UButton type="submit" :loading="busy" block size="lg">Save password</UButton></form><UButton v-else to="/portal/sign-in">Sign in</UButton></AuthShell></template>
