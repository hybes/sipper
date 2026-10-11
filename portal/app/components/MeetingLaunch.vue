<script setup lang="ts">
import type { Meeting } from '~~/shared/meetings'
const props=defineProps<{organisationId:string;conversationId:string;enabled:boolean}>()
const meeting=ref<Meeting|null>(null),available=ref(false),loading=ref(false),starting=ref(false),error=ref(''),requestId=ref('')
let generation=0,timer:ReturnType<typeof setInterval>|undefined
const endpoint=()=>`/api/platform/me/conferencing/${props.organisationId}/conversations/${props.conversationId}/meeting`
async function load() {
  if(!props.enabled || loading.value)return
  const version=generation;loading.value=true
  try {const result=await $fetch<{available:boolean;meeting:Meeting|null}>(endpoint());if(version===generation){meeting.value=result.meeting;available.value=result.available;error.value=''}}
  catch {if(version===generation){available.value=false;error.value='Could not check meeting access. Try again.'}}
  finally {if(version===generation)loading.value=false}
}
async function start() {
  if(!props.enabled || !available.value || starting.value)return
  const version=generation,url=endpoint();starting.value=true;error.value='';requestId.value ||= crypto.randomUUID()
  try {
    const result=await $fetch<{meeting:Meeting}>(url,{method:'POST',body:{id:requestId.value}})
    if(version!==generation)return
    requestId.value='';meeting.value=result.meeting
    await navigateTo(`/portal/meeting/${props.organisationId}/${result.meeting.id}`)
  } catch(failure:any) {if(version===generation){error.value=failure?.data?.message ?? 'Starting the meeting was not confirmed. Retry keeps the same request.';if([400,409,429].includes(failure?.statusCode))requestId.value=''}}
  finally {if(version===generation)starting.value=false}
}
watch(()=>[props.organisationId,props.conversationId],()=>{generation++;meeting.value=null;available.value=false;loading.value=false;starting.value=false;error.value='';requestId.value='';void load()},{immediate:true})
watch(()=>props.enabled,value=>{if(value)void load();else{generation++;meeting.value=null;available.value=false;loading.value=false;starting.value=false}})
onMounted(()=>{timer=setInterval(()=>{if(document.visibilityState==='visible' && !starting.value)void load()},15_000)})
onBeforeUnmount(()=>{generation++;clearInterval(timer)})
</script>
<template>
  <div class="space-y-2">
    <UButton v-if="meeting" :to="`/portal/meeting/${organisationId}/${meeting.id}`" variant="outline" color="neutral" size="sm" :disabled="!enabled || !available">Join meeting</UButton>
    <UButton v-else variant="outline" color="neutral" size="sm" :loading="starting" :disabled="!enabled || !available || loading" @click="start">{{ requestId ? 'Retry starting meeting' : 'Start meeting' }}</UButton>
    <p v-if="error" class="max-w-xs text-xs text-error" role="alert">{{ error }} <button type="button" class="underline" :disabled="loading" @click="load">Refresh</button></p>
    <p v-else-if="enabled && !loading && !available" class="text-xs text-muted">Meetings are not available yet.</p>
  </div>
</template>
