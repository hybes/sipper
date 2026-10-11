<script setup lang="ts">
import { auth } from '~/lib/auth'
definePageMeta({ middleware: 'auth' })
const route = useRoute()
const { busy, error, action } = usePortal()
const returnURL = ref('')
const knownClient = computed(() => ['sipper-macos', 'sipper-windows', 'sipper-ios', 'sipper-android'].includes(String(route.query.client_id)))
async function decide(accept: boolean) {
  await action(async () => {
    const result = await auth.oauth2.consent({ accept })
    if (result.error) throw new Error(result.error.message)
    if (!result.data?.url) throw new Error('Unable to return to Sipper. Start sign-in again in the app.')
    returnURL.value = result.data.url
    location.assign(returnURL.value)
  })
}
</script>
<template><AuthShell><h1 class="text-3xl font-semibold">Connect your Sipper app</h1><p class="mb-7 mt-4 leading-relaxed text-stone-500">Your app will receive the managed calling accounts assigned to you and report its device and registration status to your administrator.</p><UAlert v-if="!knownClient" color="error" title="This application is not recognised" /><UAlert v-if="error" class="mb-5" color="error" :title="error" /><template v-if="returnURL"><p class="mb-5 text-sm text-muted">If Sipper did not open, use the button below to return to your app.</p><UButton block :to="returnURL" external>Return to Sipper</UButton></template><template v-else-if="knownClient"><div class="mb-7 rounded-lg bg-stone-50 p-4 text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-300"><p>Your personal SIP accounts stay on your device. Connecting an organisation does not share their passwords with Sipper.</p></div><div class="flex gap-3"><UButton block color="neutral" variant="outline" :loading="busy" @click="decide(false)">Cancel</UButton><UButton block :loading="busy" @click="decide(true)">Connect app</UButton></div></template></AuthShell></template>
