<script setup lang="ts">
import { gatewayCallSummary, type GatewayCallObservation } from '~~/shared/service-status'
const props = defineProps<{ calls: GatewayCallObservation[]; now: number; organisationId: string }>()
const summary = computed(() => gatewayCallSummary(props.calls, props.now))
</script>
<template>
  <NuxtLink v-if="summary.count" :to="`/portal/calls/${organisationId}`" :aria-label="`${summary.label}: gateway call activity`" class="inline-block whitespace-nowrap hover:underline">
    <UBadge :color="summary.color" variant="subtle" size="sm">{{ summary.label }}</UBadge>
    <span class="table-detail">Gateway<span v-if="summary.count > 1"> · {{ summary.count }} calls</span></span>
  </NuxtLink>
  <span v-else class="text-xs text-muted whitespace-nowrap">Gateway · None reported</span>
</template>
