<script setup lang="ts">
import { Room,RoomEvent,Track,ConnectionState,DisconnectReason,setLogLevel,type Participant } from 'livekit-client'
import type { MeetingDetails,MeetingJoin } from '~~/shared/meetings'
import { changeMeetingCapture,stopMeetingCapture } from '~/utils/meeting-capture'
definePageMeta({layout:'portal',middleware:'auth',key:route=>route.path})
useHead({title:'Meeting · Sipper'})
setLogLevel('silent')
const route=useRoute(),organisationId=String(route.params.organisationId),id=String(route.params.id)
const base=`/api/platform/me/conferencing/${organisationId}/meetings/${id}`
const {data,error:detailsError,refresh,status}=await useFetch<MeetingDetails>(base)
const room=shallowRef<Room|null>(null),state=ref(ConnectionState.Disconnected),joining=ref(false),leaving=ref(false),mediaBusy=ref(false),actionBusy=ref(false)
const error=ref(''),notice=ref(''),audioReady=ref(false),now=ref(Date.now()),accessDenied=ref(false)
const removing=ref<{userId:string;name:string}|null>(null),endOpen=ref(false)
type Person={identity:string;name:string;local:boolean;userId:string|null;camera:Track|null;screen:Track|null;audio:Track|null;screenAudio:Track|null;microphone:boolean;cameraOn:boolean;speaking:boolean}
const people=shallowRef<Person[]>([])
let epoch=0,timer:ReturnType<typeof setInterval>|undefined,joinId='',sessionId=''
const host=computed(()=>data.value?.meeting.createdBy===data.value?.userId)
const connected=computed(()=>state.value===ConnectionState.Connected)
const active=computed(()=>room.value!==null || joining.value)
const canJoin=computed(()=>!active.value && !accessDenied.value && data.value?.canJoin && !detailsError.value && Date.parse(data.value.expiresAt)>now.value)
const self=computed(()=>people.value.find(person=>person.local))
const endLabel=computed(()=>data.value?.meeting.controlConfirmedAt ? 'Ended' : data.value?.meeting.endedAt ? 'End requested' : Date.parse(data.value?.meeting.expiresAt ?? '')<=now.value ? 'Expired' : null)
const sourceTrack=(person:Participant,source:Track.Source)=>{const publication=person.getTrackPublication(source);return publication && (person.isLocal || !publication.isMuted) && publication.track?.mediaStreamTrack.readyState==='live' ? publication.track : null}
function update(r:Room) {
  if(room.value!==r)return
  state.value=r.state;audioReady.value=r.canPlaybackAudio
  people.value=[r.localParticipant,...r.remoteParticipants.values()].map(person=>({identity:person.identity,name:person.name || (person.isLocal ? 'You' : 'Participant'),local:person.isLocal,
    userId:person.isLocal ? data.value?.userId ?? null : data.value?.sessions.find(session=>`sipper:${session.id}`===person.identity)?.userId ?? null,
    camera:sourceTrack(person,Track.Source.Camera),screen:sourceTrack(person,Track.Source.ScreenShare),audio:person.isLocal ? null : sourceTrack(person,Track.Source.Microphone),
    screenAudio:person.isLocal ? null : sourceTrack(person,Track.Source.ScreenShareAudio),microphone:Boolean(sourceTrack(person,Track.Source.Microphone)),cameraOn:Boolean(sourceTrack(person,Track.Source.Camera)),speaking:person.isSpeaking}))
}
async function withdraw(session:string,version=epoch) {
  if(!session)return
  try {await $fetch(`${base}/sessions/${session}/leave`,{method:'POST',body:{}})} catch {if(epoch===version)notice.value='You have disconnected. Sipper could not confirm the server leave request.'}
}
async function disconnect(message='',resetRequest=true) {
  epoch++;joining.value=false
  const r=room.value,owned=sessionId || joinId;room.value=null;sessionId='';if(resetRequest)joinId='';people.value=[];state.value=ConnectionState.Disconnected;mediaBusy.value=false
  if(message)notice.value=message
  if(r){stopMeetingCapture(r);await r.disconnect(true).catch(()=>{})}
  return owned
}
async function join() {
  if(!canJoin.value || joining.value)return
  const version=++epoch,r=new Room({adaptiveStream:true,dynacast:true,stopLocalTrackOnUnpublish:true,disconnectOnPageLeave:true})
  room.value=r;joining.value=true;error.value='';notice.value='';joinId ||= crypto.randomUUID()
  const requested=joinId
  let grantReceived=false
  const current=()=>epoch===version && room.value===r
  for(const event of [RoomEvent.ConnectionStateChanged,RoomEvent.ParticipantConnected,RoomEvent.ParticipantDisconnected,RoomEvent.TrackSubscribed,RoomEvent.TrackUnsubscribed,RoomEvent.TrackMuted,RoomEvent.TrackUnmuted,RoomEvent.LocalTrackPublished,RoomEvent.LocalTrackUnpublished,RoomEvent.ActiveSpeakersChanged,RoomEvent.AudioPlaybackStatusChanged])r.on(event,()=>update(r))
  r.on(RoomEvent.Disconnected,reason=>{
    if(!current())return
    notice.value=reason===DisconnectReason.PARTICIPANT_REMOVED ? 'You were removed from this meeting.' : reason===DisconnectReason.ROOM_DELETED ? 'This meeting has ended.' : 'You have disconnected from the meeting.'
    const owned=sessionId;epoch++;joinId='';sessionId='';mediaBusy.value=false
    stopMeetingCapture(r);room.value=null;people.value=[];state.value=ConnectionState.Disconnected;joining.value=false;void withdraw(owned);void refresh()
  })
  try {
    // Playback activation captures no microphone/camera. Capture starts only
    // from the separate explicit controls after the connection is established.
    await r.startAudio().catch(()=>{})
    if(!current())return
    const grant=await $fetch<MeetingJoin>(`${base}/join`,{method:'POST',body:{id:requested}})
    grantReceived=true
    if(grant.schemaVersion!==1 || grant.organisationId!==organisationId || grant.meetingId!==id || grant.sessionId!==requested || grant.identity!==`sipper:${requested}`)throw Error('invalid_meeting_grant')
    if(!current()){await withdraw(requested);return}
    sessionId=requested
    await r.connect(grant.url,grant.token)
    if(!current()){stopMeetingCapture(r);await r.disconnect(true);await withdraw(requested);return}
    update(r);void refresh()
  } catch(failure:any) {
    if(current()){
      error.value=failure?.data?.message ?? 'Could not join the meeting. Check your connection and try again.'
      const granted=Boolean(sessionId) || grantReceived,reset=granted || [400,401,403,404,409,429].includes(failure?.statusCode)
      await disconnect('',reset)
      if(granted)await withdraw(requested)
    } else await withdraw(requested,version)
  } finally {if(current())joining.value=false}
}
async function leave() {
  if(leaving.value)return
  leaving.value=true;error.value=''
  try {const owned=await disconnect('You have left the meeting.');await withdraw(owned);await refresh()}
  finally {leaving.value=false}
}
async function capture(source:Track.Source) {
  const r=room.value,version=epoch
  if(!r || mediaBusy.value)return
  const enabled=!sourceTrack(r.localParticipant,source)
  if(enabled && (!connected.value || accessDenied.value || endLabel.value))return
  const current=()=>room.value===r && epoch===version && (!enabled || (r.state===ConnectionState.Connected && !accessDenied.value && !endLabel.value))
  mediaBusy.value=true;error.value=''
  try {await changeMeetingCapture(r,source,enabled,current)}
  catch(failure:any) {if(current())error.value=failure?.name==='NotAllowedError' ? 'Capture was not allowed. Check your browser permissions and try again.' : 'Could not update capture. Check the selected device and try again.'}
  finally {if(room.value===r && epoch===version){mediaBusy.value=false;update(r)}}
}
async function enableAudio() {const r=room.value;if(!r)return;try{await r.startAudio();update(r)}catch{error.value='Audio playback could not start. Try again.'}}
async function end() {
  if(!host.value || actionBusy.value || endLabel.value)return
  actionBusy.value=true;error.value=''
  try {await $fetch(`${base}/end`,{method:'POST',body:{}});endOpen.value=false;await disconnect('Meeting end requested.');await refresh()}
  catch(failure:any){error.value=failure?.data?.message ?? 'Ending the meeting was not confirmed. Try again.'}
  finally {actionBusy.value=false}
}
async function remove() {
  const target=removing.value;if(!target || actionBusy.value || !host.value)return
  actionBusy.value=true;error.value=''
  try {await $fetch(`${base}/people/${encodeURIComponent(target.userId)}`,{method:'DELETE'});removing.value=null;notice.value=`Removal requested for ${target.name}.`;await refresh()}
  catch(failure:any){error.value=failure?.data?.message ?? 'Removal was not confirmed. Try again.'}
  finally {actionBusy.value=false}
}
watch(data,value=>{if(value?.meeting.endedAt || (active.value && value && !value.canJoin))void disconnect(value.meeting.endedAt ? 'Meeting end requested.' : 'Your access to this meeting has changed.');if(room.value)update(room.value)})
watch(detailsError,failure=>{if([401,403,404].includes(failure?.statusCode ?? 0)){accessDenied.value=true;void disconnect('Your access to this meeting has changed.')}})
onMounted(()=>{timer=setInterval(()=>{now.value=Date.now();if(status.value!=='pending')void refresh()},15_000)})
onBeforeUnmount(()=>{clearInterval(timer);const owned=sessionId || joinId;void disconnect();void withdraw(owned)})
</script>
<template>
  <UButton to="/portal/messages" variant="link" color="neutral" class="mb-4 -ml-2">Messages</UButton>
  <div class="page-heading"><div><h1 class="page-title">{{ data?.title ?? 'Meeting' }}</h1><p class="page-description">{{ data?.organisation.name ?? 'Customer meeting' }}<span v-if="data?.hostName"> · Hosted by {{ data.hostName }}</span></p></div><UBadge v-if="endLabel" color="neutral" variant="subtle">{{ endLabel }}</UBadge><UBadge v-else-if="active" :color="connected ? 'success' : 'warning'" variant="subtle">{{ connected ? 'Connected' : joining ? 'Connecting' : 'Reconnecting' }}</UBadge></div>
  <UAlert v-if="detailsError" class="my-5" color="error" title="Meeting details unavailable" :description="(detailsError.data as any)?.message ?? 'Could not check meeting access.'" :actions="[{label:'Retry',onClick:()=>refresh()}]" />
  <UAlert v-if="error" class="my-5" color="error" title="Meeting action not confirmed" :description="error" />
  <p v-if="notice" class="my-4 text-sm text-muted" role="status">{{ notice }}</p>
  <div v-if="data" class="mt-6">
    <div class="flex flex-wrap items-center gap-3 border-y border-default py-4">
      <UButton v-if="!active" :disabled="!canJoin || leaving" :loading="joining" @click="join">Join meeting</UButton>
      <template v-else>
        <UButton color="neutral" variant="outline" :disabled="mediaBusy || ((!connected || Boolean(endLabel)) && !self?.microphone)" :aria-pressed="self?.microphone ?? false" @click="capture(Track.Source.Microphone)">{{ self?.microphone ? 'Turn microphone off' : 'Turn microphone on' }}</UButton>
        <UButton color="neutral" variant="outline" :disabled="mediaBusy || ((!connected || Boolean(endLabel)) && !self?.cameraOn)" :aria-pressed="self?.cameraOn ?? false" @click="capture(Track.Source.Camera)">{{ self?.cameraOn ? 'Turn camera off' : 'Turn camera on' }}</UButton>
        <UButton color="neutral" variant="outline" :disabled="mediaBusy || ((!connected || Boolean(endLabel)) && !self?.screen)" :aria-pressed="Boolean(self?.screen)" @click="capture(Track.Source.ScreenShare)">{{ self?.screen ? 'Stop sharing' : 'Share screen' }}</UButton>
        <UButton v-if="connected && !audioReady" color="neutral" variant="outline" @click="enableAudio">Enable audio</UButton>
        <UButton color="error" variant="outline" :loading="leaving" @click="leave">{{ joining ? 'Cancel joining' : 'Leave meeting' }}</UButton>
      </template>
      <UButton v-if="host && !endLabel" color="error" variant="ghost" :disabled="actionBusy" @click="endOpen=true">End for everyone</UButton>
    </div>
    <p class="mt-3 text-sm text-muted">{{ active ? 'Stay on this page while you are in the meeting.' : endLabel ? 'This meeting is closed to new joins.' : !data.available ? 'Meetings are not available yet.' : !data.canJoin ? 'You cannot join this meeting.' : 'You will join with your microphone and camera off.' }}</p>
    <div v-if="people.some(person=>person.screen || person.camera)" class="mt-6 grid gap-4 md:grid-cols-2">
      <template v-for="person in people" :key="person.identity">
        <figure v-if="person.screen" class="min-w-0 overflow-hidden rounded-lg border border-default md:col-span-2"><MeetingTrack :track="person.screen" :local="person.local" /><figcaption class="px-3 py-2 text-sm">{{ person.local ? 'Your screen' : `${person.name}'s screen` }}</figcaption></figure>
        <figure v-if="person.camera" class="min-w-0 overflow-hidden rounded-lg border border-default"><MeetingTrack :track="person.camera" :local="person.local" /><figcaption class="px-3 py-2 text-sm">{{ person.local ? 'You' : person.userId===data?.userId ? 'You (another device)' : person.name }}</figcaption></figure>
      </template>
    </div>
    <div v-for="person in people" :key="`audio:${person.identity}`" class="hidden"><MeetingTrack v-if="person.audio" :track="person.audio" /><MeetingTrack v-if="person.screenAudio" :track="person.screenAudio" /></div>
    <section class="mt-8" aria-label="Meeting participants"><h2 class="mb-3 text-lg font-semibold">People</h2><div class="table-panel"><div class="table-scroll" tabindex="0" aria-label="Meeting people table"><table class="management-table min-w-[520px]"><caption class="sr-only">People currently connected to this meeting</caption><thead><tr><th scope="col">Person</th><th scope="col">Microphone</th><th scope="col">Camera</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody><tr v-for="person in people" :key="person.identity"><td><span class="table-person">{{ person.local ? 'You' : person.userId===data?.userId ? 'You (another device)' : person.name }}</span><span v-if="person.speaking" class="table-detail">Speaking</span></td><td>{{ person.microphone ? 'On' : 'Off' }}</td><td>{{ person.cameraOn ? 'On' : 'Off' }}</td><td><UButton v-if="host && !person.local && person.userId && person.userId!==data?.userId && !endLabel" size="sm" color="error" variant="ghost" :disabled="actionBusy" :aria-label="`Remove ${person.name}`" @click="removing={userId:person.userId!,name:person.name}">Remove</UButton></td></tr></tbody></table></div><p v-if="!people.length" class="table-empty">{{ endLabel ? 'This meeting is closed to new joins.' : joining ? 'Connecting to the meeting…' : 'Join to see who is connected.' }}</p></div></section>
  </div>
  <UModal v-model:open="endOpen" title="End meeting for everyone?" description="Everyone will be disconnected and this meeting cannot be joined again." :dismissible="!actionBusy" :close="!actionBusy"><template #body><UAlert v-if="error" class="mb-4" color="error" :title="error" /><p class="text-sm text-muted">The request stays pending until the meeting server confirms it. If the service is unavailable, it will retry.</p></template><template #footer><div class="flex w-full justify-end gap-3"><UButton color="neutral" variant="outline" :disabled="actionBusy" @click="endOpen=false">Cancel</UButton><UButton color="error" :loading="actionBusy" @click="end">End meeting</UButton></div></template></UModal>
  <UModal :open="Boolean(removing)" title="Remove person?" :description="`${removing?.name ?? 'This person'} will be removed on all their devices and cannot rejoin this meeting.`" :dismissible="!actionBusy" :close="!actionBusy" @update:open="!$event && !actionBusy && (removing=null)"><template #body><UAlert v-if="error" color="error" :title="error" /></template><template #footer><div class="flex w-full justify-end gap-3"><UButton color="neutral" variant="outline" :disabled="actionBusy" @click="removing=null">Cancel</UButton><UButton color="error" :loading="actionBusy" @click="remove">Remove person</UButton></div></template></UModal>
</template>
