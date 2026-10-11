<script setup lang="ts">
const route = useRoute(), reference = ref(''), origin = ref('')
onMounted(() => {
  origin.value = location.origin
  watch(() => route.hash, hash => { reference.value = /^#ref=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? '' }, { immediate: true })
})
const appLink = computed(() => `sipper://setup?${new URLSearchParams({ server: origin.value, reference: reference.value })}`)
useHead({ title: 'Set up Sipper', meta: [{ name: 'referrer', content: 'no-referrer' }] })
</script>
<template>
  <AuthShell>
    <h1 class="text-3xl font-semibold tracking-tight">Set up Sipper</h1>
    <template v-if="reference">
      <p class="mt-4 text-sm leading-relaxed text-muted">Open Sipper and sign in with the email your administrator invited. Then connect this device using the setup link.</p>
      <UButton class="mt-6" :to="appLink" external icon="i-lucide-external-link">Open Sipper</UButton>
      <p class="mt-6 text-sm leading-relaxed text-muted">If the app does not open, go to <strong>Accounts</strong> or <strong>Settings</strong> in Sipper and paste this page's link into <strong>Setup link</strong>.</p>
      <p class="mt-4 text-sm leading-relaxed text-muted">Setup links expire after 15 minutes and work once. If yours has expired or was already used, ask your administrator for a new one. You can also sign in and select your customer directly.</p>
    </template>
    <UAlert v-else class="mt-6" color="warning" title="Open your full setup link" description="Use the link or QR code your administrator provided. It contains the reference needed to set up your device." />
    <NuxtLink to="/portal/sign-in" class="mt-6 block text-sm text-primary">Open management sign-in</NuxtLink>
  </AuthShell>
</template>
