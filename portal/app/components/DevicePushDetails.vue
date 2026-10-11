<script setup lang="ts">
import { pushEndpointLabel, pushOutcomeLabel } from '~~/shared/service-status'
defineProps<{ device: { platform: string; revoked_at?: string | null; push_provider?: string | null; push_disabled_at?: string | null; push_updated_at?: string | null; last_push_at?: string | null; last_push_status?: string | null; last_wake_at?: string | null } }>()
</script>
<template>
  <section aria-label="Mobile push activity"><h2 class="mb-3 font-semibold">Mobile push</h2>
    <p v-if="!['ios','android'].includes(device.platform)" class="text-sm text-muted">This desktop app does not use mobile push.</p>
    <template v-else><dl class="detail-list"><dt>Token</dt><dd>{{ pushEndpointLabel(device) }}</dd><dt>Provider</dt><dd>{{ device.push_provider === 'apns' ? 'Apple' : device.push_provider === 'fcm' ? 'Google' : 'Not registered' }}</dd><dt>Token updated</dt><dd>{{ activityDate(device.push_updated_at) }}</dd><dt>Last provider attempt</dt><dd>{{ activityDate(device.last_push_at) }}</dd><dt>Provider response</dt><dd>{{ pushOutcomeLabel(device.last_push_status) }}</dd><dt>Last wake request</dt><dd>{{ activityDate(device.last_wake_at) }}</dd></dl><p class="mt-4 text-xs leading-relaxed text-muted">Provider acceptance does not prove that the phone rang. A wake request means the app contacted Sipper about a call. These timestamps describe this installation, including earlier token registrations.</p></template>
  </section>
</template>
