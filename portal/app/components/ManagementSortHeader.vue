<script setup lang="ts">
import type { SortDirection } from '~~/shared/table-sort'
defineProps<{ label: string; direction?: SortDirection }>()
defineEmits<{ sort: [] }>()
</script>
<template>
  <th scope="col" :aria-sort="direction ?? 'none'">
    <button class="inline-flex items-center gap-1.5 rounded-sm text-left hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary" @click="$emit('sort')">
      {{ label }}
      <UIcon :name="direction === 'ascending' ? 'i-lucide-arrow-up' : direction === 'descending' ? 'i-lucide-arrow-down' : 'i-lucide-arrow-up-down'" class="size-3 shrink-0" aria-hidden="true" />
    </button>
  </th>
</template>
