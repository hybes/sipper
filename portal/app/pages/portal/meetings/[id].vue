<script setup lang="ts">
definePageMeta({layout:'portal',middleware:'auth',key:route=>route.path})
useHead({title:'Meeting activity · Sipper'})
const route=useRoute(),id=String(route.params.id),page=ref(0),cursors=ref<(string|undefined)[]>([undefined]),before=computed(()=>cursors.value[page.value])
const {data,error,refresh,status}=await useFetch<any>(`/api/platform/organisations/${id}/meetings`,{query:{before}})
const {busy,error:actionError,action}=usePortal(),ending=ref<any>(null)
const endOpen=computed({get:()=>Boolean(ending.value),set:value=>{if(!value && !busy.value)ending.value=null}})
const now=ref(Date.now()),autoRefresh=ref(true)
let timer:ReturnType<typeof setInterval>|undefined
function state(meeting:any) {return meeting.controlConfirmedAt ? 'Ended' : meeting.endedAt ? 'End requested' : Date.parse(meeting.expiresAt)<=now.value ? 'Expired' : 'Open'}
function canEnd(meeting:any) {return !error.value && data.value?.canEndMeetings && !meeting.endedAt && state(meeting)!=='Expired'}
async function end() {
  if(!ending.value || busy.value || !canEnd(ending.value))return
  const result=await action(()=>$fetch(`/api/platform/organisations/${id}/meetings/${ending.value.id}/end`,{method:'POST',body:{}}),'Meeting end requested')
  if(result){ending.value=null;await refresh()}
}
function older() {if(data.value?.nextCursor){cursors.value=[...cursors.value.slice(0,page.value+1),data.value.nextCursor];page.value++}}
async function latest() {if(page.value){page.value=0;cursors.value=[undefined]}else await refresh()}
onMounted(()=>{timer=setInterval(()=>{now.value=Date.now();if(autoRefresh.value && !page.value && !ending.value && document.visibilityState==='visible' && status.value!=='pending')void refresh()},15_000)})
onBeforeUnmount(()=>clearInterval(timer))
</script>
<template>
  <UButton :to="`/portal/organisations/${id}`" variant="link" color="neutral" class="mb-4 -ml-2">Customer</UButton>
  <div class="page-heading"><div><h1 class="page-title">Meeting activity</h1><p class="page-description">{{ data?.organisationName ?? 'Customer' }}</p></div><UButton variant="outline" color="neutral" :loading="status==='pending'" @click="latest">Latest meetings</UButton></div>
  <UAlert v-if="error" class="mt-6" color="error" title="Meeting activity unavailable" :description="(error.data as any)?.message ?? 'Could not load the meeting history.'" />
  <template v-if="data && !error">
    <div class="section-toolbar mt-6"><p class="text-xs text-muted">{{ page ? 'Viewing earlier meetings. Auto-refresh resumes on the first page.' : `Updated ${activityDate(data.sampledAt)}` }}</p><UCheckbox v-model="autoRefresh" label="Auto-refresh · 15s" /></div>
    <p class="mb-4 max-w-3xl text-sm text-muted">Open means this meeting can accept authorised joins. Admitted sessions are server-authorised device or browser sessions; they do not confirm connected audio or video. Administrators can end a meeting without joining it.</p>
    <p class="mb-2 text-xs text-muted lg:hidden">Scroll sideways for more columns.</p>
    <div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Meeting activity table"><table class="management-table min-w-[1040px]">
      <caption class="sr-only">Customer meeting history and control confirmations</caption><thead><tr><th scope="col">Host</th><th scope="col">State</th><th scope="col">Admitted sessions</th><th scope="col">Pending removals</th><th scope="col">Started</th><th scope="col">Closes</th><th scope="col">Meeting reference</th><th v-if="data.canEndMeetings" scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody><tr v-for="meeting in data.meetings" :key="meeting.id">
        <td><span class="table-person">{{ meeting.hostName ?? 'Former member' }}</span></td><td><UBadge variant="subtle" :color="state(meeting)==='End requested' ? 'warning' : 'neutral'">{{ state(meeting) }}</UBadge><span v-if="meeting.controlConfirmedAt" class="table-detail">Confirmed {{ activityDate(meeting.controlConfirmedAt) }}</span><span v-else-if="meeting.endedAt" class="table-detail">Requested {{ activityDate(meeting.endedAt) }}</span></td><td>{{ meeting.admittedSessions }}</td><td>{{ meeting.removalsPending }}</td><td class="whitespace-nowrap">{{ activityDate(meeting.createdAt) }}</td><td class="whitespace-nowrap">{{ activityDate(meeting.expiresAt) }}</td><td class="whitespace-nowrap font-mono text-xs">{{ meeting.id }}</td><td v-if="data.canEndMeetings"><UButton v-if="canEnd(meeting)" color="error" variant="ghost" size="sm" class="whitespace-nowrap" :aria-label="`End meeting hosted by ${meeting.hostName ?? 'former member'}`" @click="ending=meeting;actionError=''">End meeting</UButton><span v-else class="text-muted">—</span></td>
      </tr></tbody>
    </table></div><p v-if="!data.meetings.length" class="table-empty">No meetings in this history. Older records are removed according to the service retention policy.</p></div>
    <div class="mt-4 flex flex-wrap items-center justify-between gap-3"><p class="text-xs text-muted">Page {{ page+1 }} · {{ data.meetings.length }} {{ data.meetings.length===1 ? 'meeting' : 'meetings' }}</p><div class="flex gap-2"><UButton color="neutral" variant="outline" :disabled="!page || status==='pending'" @click="page--">Newer</UButton><UButton color="neutral" variant="outline" :disabled="!data.nextCursor || status==='pending'" @click="older">Older</UButton></div></div>
  </template>
  <UModal v-if="data?.canEndMeetings && !error" v-model:open="endOpen" title="End meeting for everyone?" description="Everyone will be disconnected and this meeting cannot be joined again." :dismissible="!busy" :close="!busy"><template #body><UAlert v-if="actionError" class="mb-4" color="error" :title="actionError" /><p class="text-sm text-muted">The request stays pending until the meeting server confirms it. If the service is unavailable, it will retry.</p></template><template #footer><div class="flex w-full justify-end gap-3"><UButton color="neutral" variant="outline" :disabled="busy" @click="ending=null">Cancel</UButton><UButton color="error" :loading="busy" @click="end">End meeting</UButton></div></template></UModal>
</template>
