<script setup lang="ts">
import { directCallSummary, type DirectCallObservation } from '~~/shared/service-status'
const props = defineProps<{ reports: DirectCallObservation[]; now: number }>()
const summary = computed(() => directCallSummary(props.reports, props.now))
const lastReport = computed(() => props.reports.map(report => report.observedAt).filter(value => Number.isFinite(Date.parse(value))).sort().at(-1))
</script>
<template>
  <div class="mt-2">
    <UBadge :color="summary.color" variant="subtle" size="sm">{{ summary.label }}</UBadge>
    <span class="table-detail" :title="lastReport ? `App report: ${activityDate(lastReport)}` : undefined">Direct · App reported<span v-if="lastReport">{{ ` · ${activityAge(lastReport, now)}` }}</span><span v-if="summary.count > 1"> · {{ summary.count }} call legs</span></span>
    <span v-if="summary.stale && summary.count" class="table-detail">Some reports are unconfirmed</span>
  </div>
</template>
