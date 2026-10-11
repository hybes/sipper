<script setup lang="ts">
import { auth } from '~/lib/auth'
const route = useRoute()
const session = auth.useSession()
async function signOut() { await auth.signOut(); await navigateTo('/portal/sign-in') }
</script>
<template>
  <div class="flex min-h-screen flex-col bg-stone-50 dark:bg-stone-950">
    <a href="#main" class="sr-only focus:not-sr-only focus:p-3">Skip to content</a>
    <header class="border-b border-default bg-default">
      <div class="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <SipperBrand />
        <nav class="flex items-center gap-1 sm:gap-2" aria-label="Main navigation">
          <UButton to="/portal" variant="ghost" :color="!['/portal/security', '/portal/devices', '/portal/calling-preferences','/portal/messages'].includes(route.path) ? 'primary' : 'neutral'" icon="i-lucide-layout-dashboard"><span class="hidden sm:inline">Workspaces</span><span class="sr-only sm:hidden">Workspaces</span></UButton>
          <UButton to="/portal/devices" variant="ghost" :color="route.path === '/portal/devices' ? 'primary' : 'neutral'" icon="i-lucide-monitor-smartphone"><span class="hidden sm:inline">My devices</span><span class="sr-only sm:hidden">My devices</span></UButton>
          <UButton to="/portal/security" variant="ghost" :color="route.path === '/portal/security' ? 'primary' : 'neutral'" icon="i-lucide-shield-check"><span class="hidden sm:inline">Security</span><span class="sr-only sm:hidden">Security</span></UButton>
          <UColorModeButton />
          <UDropdownMenu :items="[{ label: session.data?.user.email ?? 'Your account', disabled: true }, { label:'Messages',to:'/portal/messages',icon:'i-lucide-message-square' }, { label: 'Calling preferences', to: '/portal/calling-preferences', icon: 'i-lucide-phone' }, { label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut }]">
            <UButton variant="soft" color="neutral" icon="i-lucide-user-round" aria-label="Account menu" />
          </UDropdownMenu>
        </nav>
      </div>
    </header>
    <main id="main" class="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-8 sm:py-8"><slot /></main>
    <footer class="mt-8 border-t border-default text-xs text-muted">
      <div class="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-8"><span>Sipper management</span><nav aria-label="Support and privacy" class="flex gap-5"><a href="https://sipper.dev/support">Support</a><a href="https://sipper.dev/privacy">Privacy</a></nav></div>
    </footer>
  </div>
</template>
