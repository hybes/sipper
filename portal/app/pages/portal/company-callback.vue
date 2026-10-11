<script setup lang="ts">
const route = useRoute(), error = ref('')
onMounted(async () => {
  try {
    const flow = typeof route.query.flow === 'string' ? route.query.flow : ''
    if (!/^[a-f0-9-]{36}$/.test(flow)) throw new Error('This sign-in request is no longer available. Start again.')
    const key = `sipper-company-sign-in:${flow}`, raw = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    if (route.query.error) throw new Error('Company sign-in did not complete. Try again or contact your administrator.')
    const saved = raw ? JSON.parse(raw) : null
    if (!saved || !Number.isFinite(saved.createdAt) || Date.now() - saved.createdAt > 10 * 60_000 || saved.createdAt > Date.now() || typeof saved.destination !== 'string' || !/^\/portal(?:[/?#]|$)/.test(saved.destination)) throw new Error('This sign-in request has expired. Start again.')
    await navigateTo(saved.destination, { replace: true })
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Company sign-in could not be completed.' }
})
</script>
<template><AuthShell><h1 class="text-2xl font-semibold">{{ error ? 'Sign-in unavailable' : 'Completing sign-in…' }}</h1><UAlert v-if="error" class="mt-5" color="error" :title="error" /><p v-else class="mt-3 text-sm text-muted" role="status">Returning you to Sipper.</p><UButton v-if="error" to="/portal/sign-in" class="mt-6">Return to sign-in</UButton></AuthShell></template>
