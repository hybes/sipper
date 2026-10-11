<script setup lang="ts">
import type { Conversation, ConversationPage, MessagePage, MessagePeople, MessagePerson, TextMessage } from '~~/shared/messages'
definePageMeta({ layout:'portal',middleware:'auth' })
useHead({ title:'Messages · Sipper' })
const {data:memberships,error:customerError}=await useFetch<{organisations:Array<{id:string;name:string;status:string}>}>('/api/platform/me/calling-preferences')
const customers=computed(()=>memberships.value?.organisations.filter(customer=>customer.status==='active') ?? [])
const customer=ref(customers.value[0]?.id ?? ''), selected=ref(''), threads=ref<Conversation[]>([]), threadCursor=ref<string|null>(null)
const history=ref<MessagePage|null>(null), loading=ref(false), historyLoading=ref(false), sending=ref(false), error=ref(''), historyError=ref(''), sendError=ref('')
const expires=ref(0), draft=ref(''), pending=ref<{id:string;text:string}|null>(null), timeline=ref<HTMLDivElement>()
const cursors=ref<Array<string|undefined>>([undefined]), page=ref(0)
const newOpen=ref(false), people=ref<MessagePerson[]>([]), recipients=ref<MessagePerson[]>([]), peopleCursor=ref<string|null>(null)
const newPending=ref<{id:string;userIds:string[];title:string}|null>(null)
const conversationPending=computed(()=>Boolean(groupPending.value || newPending.value))
const editing=ref<Conversation|null>(null), groupOwner=ref(''), groupPending=ref<{revision:string;title:string;userIds:string[];ownerId:string}|null>(null), leaveOpen=ref(false), leaving=ref(false), leaveError=ref('')
const canEdit=computed(()=>Boolean(groupPending.value) || !editing.value || editing.value.ownerId===history.value?.userId)
const search=ref(''), searched=ref(''), title=ref(''), createId=ref(''), creating=ref(false), peopleLoading=ref(false), newError=ref('')
let epoch=0, historyRequest=0, timer:ReturnType<typeof setInterval>|undefined, polling=false, nextPoll=0
const endpoint=(id=customer.value)=>`/api/platform/me/messages/${id}`
const message=(failure:any)=>typeof failure?.data?.message==='string' && failure.data.message.trim() ? failure.data.message : 'Could not reach Sipper. Try again.'
const current=computed(()=>history.value?.conversation ?? threads.value.find(thread=>thread.id===selected.value))
const ready=computed(()=>Boolean(history.value) && Date.parse(history.value!.expiresAt)>Date.now() && expires.value>Date.now() && !historyError.value)
function discard() {pending.value=null;draft.value='';sendError.value=''}
function clearAccess() {threads.value=[];history.value=null;people.value=[];expires.value=0;newOpen.value=false;editing.value=null;groupPending.value=null;newPending.value=null;leaveOpen.value=false;discard()}
function denied(failure:any) {return [401,403,404].includes(failure?.statusCode ?? failure?.status)}
async function loadThreads(more=false) {
  if(!customer.value)return
  const id=customer.value, generation=epoch
  loading.value=true
  try {
    const result=await $fetch<ConversationPage>(`${endpoint(id)}/conversations`,{query:more && threadCursor.value ? {after:threadCursor.value} : {}})
    if(generation!==epoch)return
    const retained=threads.value.some(old=>!result.conversations.some(item=>item.id===old.id)), oldExpiry=expires.value
    const hadEntries=threads.value.length>0, entries=[...threads.value,...result.conversations]
    threads.value=[...new Map(entries.map(thread=>[thread.id,thread])).values()].sort((a,b)=>BigInt(a.lastSequence)>BigInt(b.lastSequence) ? -1 : BigInt(a.lastSequence)<BigInt(b.lastSequence) ? 1 : a.id>b.id ? -1 : a.id<b.id ? 1 : 0)
    if(more || !hadEntries)threadCursor.value=result.nextCursor
    expires.value=retained && oldExpiry ? Math.min(oldExpiry,Date.parse(result.expiresAt)) : Date.parse(result.expiresAt);error.value=''
  } catch(failure) {if(generation===epoch){error.value=message(failure);if(denied(failure))clearAccess()}}
  finally {if(generation===epoch)loading.value=false}
}
async function loadHistory() {
  if(!selected.value || !customer.value)return
  const id=selected.value, org=customer.value, generation=epoch, request=++historyRequest
  const stick=!timeline.value || timeline.value.scrollHeight-timeline.value.scrollTop-timeline.value.clientHeight<64
  historyLoading.value=true
  try {
    const result=await $fetch<MessagePage>(`${endpoint(org)}/conversations/${id}`,{query:cursors.value[page.value] ? {before:cursors.value[page.value]} : {}})
    if(generation!==epoch || selected.value!==id || request!==historyRequest)return
    history.value=result;historyError.value=''
    const index=threads.value.findIndex(thread=>thread.id===id)
    if(index>=0)threads.value[index]=result.conversation
    await nextTick()
    if(stick && timeline.value)timeline.value.scrollTop=timeline.value.scrollHeight
    if(document.visibilityState==='visible' && result.messages.length) {
      await $fetch(`${endpoint(org)}/conversations/${id}/read`,{method:'POST',body:{sequence:result.messages.at(-1)!.sequence}})
    }
  } catch(failure) {
    if(generation===epoch && selected.value===id && request===historyRequest){historyError.value=message(failure);if(denied(failure))clearAccess()}
  } finally {if(request===historyRequest)historyLoading.value=false}
}
function latest() {cursors.value=[undefined];page.value=0;void loadHistory()}
function older() {if(!history.value?.nextCursor)return;cursors.value[page.value+1]=history.value.nextCursor;page.value++;void loadHistory()}
function newer() {if(!page.value)return;page.value--;void loadHistory()}
async function send() {
  if(!ready.value || sending.value || !draft.value.trim())return
  const org=customer.value,id=selected.value,generation=epoch
  pending.value ??= {id:crypto.randomUUID(),text:draft.value}
  const value={...pending.value}
  sending.value=true;sendError.value=''
  try {
    await $fetch<{message:TextMessage}>(`${endpoint(org)}/conversations/${id}`,{method:'POST',body:value})
    if(generation!==epoch || id!==selected.value)return
    discard();latest();await loadThreads()
  } catch(failure:any) {
    if(generation===epoch && id===selected.value) {
      sendError.value=message(failure)
      if([400,409,429].includes(failure?.statusCode ?? failure?.status))pending.value=null
      if(denied(failure))clearAccess()
    }
  } finally {if(generation===epoch && id===selected.value)sending.value=false}
}
async function loadPeople(more=false) {
  const org=customer.value,generation=epoch
  peopleLoading.value=true
  try {
    const result=await $fetch<MessagePeople>(`${endpoint(org)}/people`,{query:{q:searched.value,...(more && peopleCursor.value ? {after:peopleCursor.value} : {})}})
    if(generation!==epoch || !newOpen.value)return
    people.value=more ? [...people.value,...result.people] : result.people;peopleCursor.value=result.nextCursor;newError.value=''
  } catch(failure) {if(generation===epoch)newError.value=message(failure)}
  finally {if(generation===epoch)peopleLoading.value=false}
}
function choose(person:MessagePerson,on:boolean) {recipients.value=on ? [...recipients.value,person] : recipients.value.filter(item=>item.id!==person.id);if(!on && groupOwner.value===person.id)groupOwner.value=history.value?.userId ?? editing.value?.ownerId ?? ''}
function openNew() {editing.value=null;groupPending.value=null;newPending.value=null;newOpen.value=true;recipients.value=[];search.value='';searched.value='';title.value='';createId.value=crypto.randomUUID();newError.value='';void loadPeople()}
function openGroup() {
  if(!ready.value || current.value?.kind!=='group' || pending.value)return
  editing.value=current.value;groupOwner.value=current.value.ownerId ?? '';groupPending.value=null;newPending.value=null
  recipients.value=current.value.participants.filter(person=>person.id!==history.value!.userId)
  title.value=current.value.title;search.value='';searched.value='';newError.value='';people.value=[];newOpen.value=true
  if(canEdit.value)void loadPeople()
}
async function leave() {
  if(leaving.value || !selected.value)return
  const org=customer.value,id=selected.value,generation=epoch
  leaving.value=true;leaveError.value=''
  try {
    await $fetch(`${endpoint(org)}/conversations/${id}/leave`,{method:'POST',body:{}})
    if(generation!==epoch || selected.value!==id)return
    leaveOpen.value=false;newOpen.value=false;editing.value=null;threads.value=[];selected.value='';discard();await loadThreads()
  } catch(failure) {if(generation===epoch){leaveError.value=message(failure);if(denied(failure))clearAccess()}}
  finally {if(generation===epoch)leaving.value=false}
}
async function create() {
  if(creating.value || !canEdit.value || (!editing.value && !recipients.value.length) || ((editing.value || recipients.value.length>1) && !title.value.trim()))return
  const generation=epoch,org=customer.value
  creating.value=true;newError.value=''
  try {
    let result:{conversation:Conversation}
    if(editing.value) {
      groupPending.value ??= {revision:editing.value.revision,title:title.value.trim(),userIds:[history.value!.userId,...recipients.value.map(person=>person.id)],ownerId:groupOwner.value}
      result=await $fetch(`${endpoint(org)}/conversations/${editing.value.id}/group`,{method:'PUT',body:groupPending.value})
    } else {
      newPending.value ??= {id:createId.value,userIds:recipients.value.map(person=>person.id),title:title.value}
      result=await $fetch(`${endpoint(org)}/conversations`,{method:'POST',body:newPending.value})
    }
    if(generation!==epoch)return
    threads.value=[];await loadThreads();selected.value=result.conversation.id;newOpen.value=false;editing.value=null;groupPending.value=null;newPending.value=null;await loadHistory()
  } catch(failure:any) {if(generation===epoch){newError.value=message(failure);if([400,409,429].includes(failure?.statusCode ?? failure?.status)){groupPending.value=null;newPending.value=null;createId.value=crypto.randomUUID()}if(denied(failure))clearAccess()}}
  finally {if(generation===epoch)creating.value=false}
}
watch(customer,()=>{epoch++;historyRequest++;selected.value='';threads.value=[];threadCursor.value=null;clearAccess();discard();error.value='';historyError.value='';sending.value=false;newOpen.value=false;editing.value=null;groupPending.value=null;newPending.value=null;leaveOpen.value=false;void loadThreads()})
watch(selected,()=>{historyRequest++;history.value=null;historyError.value='';historyLoading.value=false;sending.value=false;discard();latest()})
onMounted(()=>{
  void loadThreads()
  timer=setInterval(()=>{
    if(expires.value && expires.value<=Date.now()){history.value=null;threads.value=[];expires.value=0}
    if(history.value && Date.parse(history.value.expiresAt)<=Date.now())history.value=null
    if(Date.now()<nextPoll || document.visibilityState!=='visible' || polling || loading.value || historyLoading.value || sending.value || creating.value)return
    nextPoll=Date.now()+5000
    polling=true
    void (async()=>{await loadThreads();if(selected.value)await loadHistory()})().finally(()=>{polling=false})
  },1000)
})
onBeforeUnmount(()=>{clearInterval(timer);epoch++;historyRequest++;clearAccess();discard()})
</script>
<template>
  <div class="page-heading"><div><h1 class="page-title">Messages</h1><p class="page-description">Text conversations with people in your customer organisation.</p></div>
    <UButton :disabled="!customer || Boolean(error) || Boolean(pending) || leaving" @click="openNew">New conversation</UButton>
  </div>
  <UAlert v-if="customerError" color="error" title="Customer list unavailable" class="my-5" :description="(customerError.data as any)?.message" />
  <div class="section-toolbar mt-6"><UFormField label="Customer" class="w-full sm:w-80"><USelect v-model="customer" :items="customers.map(item=>({label:item.name,value:item.id}))" :disabled="!customers.length || sending || creating || Boolean(pending) || leaving || newOpen || leaveOpen" class="w-full" aria-label="Message customer" /></UFormField>
    <UButton variant="outline" color="neutral" :loading="loading" :disabled="!customer" @click="loadThreads();selected && loadHistory()">Refresh</UButton>
  </div>
  <UAlert v-if="error" color="error" title="Messages unavailable" :description="error" class="mb-5" />
  <p v-if="!customers.length && !customerError" class="table-empty">Join a customer organisation with a user licence to use messaging.</p>
  <div v-if="customer" class="grid min-w-0 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
    <section aria-label="Conversations" class="min-w-0">
      <div class="table-panel"><ul class="divide-y divide-default">
        <li v-for="thread in threads" :key="thread.id"><button class="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-elevated" :class="selected===thread.id ? 'bg-elevated' : ''" :disabled="sending || Boolean(pending) || leaving || newOpen || leaveOpen" :aria-current="selected===thread.id ? 'true' : undefined" @click="selected=thread.id">
          <span class="min-w-0"><span class="block break-words font-medium">{{ thread.title }}</span><span class="mt-1 block text-xs text-muted">{{ activityDate(thread.updatedAt) }}</span></span>
          <UBadge v-if="thread.unread" color="primary" variant="soft" :aria-label="`${thread.unread} unread messages`">{{ thread.unread }}</UBadge>
        </button></li>
      </ul><p v-if="!threads.length" class="table-empty" role="status">{{ loading ? 'Loading conversations…' : error ? 'Conversations could not be loaded.' : 'No conversations yet.' }}</p></div>
      <UButton v-if="threadCursor" class="mt-3" variant="outline" color="neutral" :loading="loading" @click="loadThreads(true)">More conversations</UButton>
    </section>
    <section aria-label="Selected conversation" class="min-w-0">
      <template v-if="selected">
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-default pb-4"><div class="min-w-0"><h2 class="break-words text-xl font-semibold">{{ current?.title ?? 'Conversation' }}</h2><p v-if="current?.kind==='group'" class="mt-1 break-words text-sm text-muted">{{ current.participants.map(person=>person.name).join(', ') }}</p></div>
          <div class="flex flex-wrap gap-2"><UButton v-if="current?.kind==='group'" size="sm" variant="outline" color="neutral" :disabled="!ready || sending || Boolean(pending) || leaving" @click="openGroup">Group settings</UButton><UButton size="sm" variant="outline" color="neutral" :disabled="!history?.nextCursor || historyLoading" @click="older">Older messages</UButton><UButton v-if="page" size="sm" variant="outline" color="neutral" :disabled="historyLoading" @click="newer">Newer messages</UButton><UButton v-if="page" size="sm" variant="outline" color="neutral" @click="latest">Latest messages</UButton></div>
        </div>
        <UAlert v-if="historyError" color="error" title="Conversation unavailable" :description="historyError" class="my-4" :actions="[{label:'Reload latest messages',onClick:latest}]" />
        <div class="mt-4"><MeetingLaunch :key="`${customer}:${selected}`" :organisation-id="customer" :conversation-id="selected" :enabled="ready && !sending && !pending && !leaving" /></div>
        <div ref="timeline" class="max-h-[55vh] min-h-48 overflow-y-auto py-4" :aria-busy="historyLoading" aria-label="Message history">
          <ol v-if="history" class="space-y-5"><li v-for="text in history.messages" :key="text.id" class="min-w-0 border-l-2 border-default pl-4" :class="text.senderId===history.userId ? 'border-primary' : ''">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1"><span class="text-sm font-medium">{{ text.senderId===history.userId ? 'You' : text.senderName }}</span><time :datetime="text.createdAt" class="text-xs text-muted">{{ activityDate(text.createdAt) }}</time></div>
            <p class="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{{ text.text }}</p>
          </li></ol>
          <p v-if="history && !history.messages.length" class="py-8 text-sm text-muted">No messages in this conversation yet.</p>
          <p v-if="!history && !historyError" class="py-8 text-sm text-muted" role="status">{{ historyLoading ? 'Loading conversation…' : 'Refresh the conversation to reconnect.' }}</p>
        </div>
        <form class="space-y-3 border-t border-default pt-4" @submit.prevent="send">
          <UAlert v-if="sendError" color="error" title="Message not confirmed" :description="sendError" />
          <UFormField label="Message"><UTextarea v-model="draft" :maxlength="4096" :rows="3" :disabled="sending || Boolean(pending) || !ready" class="w-full" placeholder="Write a message…" aria-label="Message text" /></UFormField>
          <div class="flex flex-wrap items-center justify-between gap-3"><p class="text-xs text-muted">{{ draft.length }}/4096<span v-if="history"> · Messages kept for {{ history.retentionDays }} days</span></p><div class="flex gap-2"><UButton v-if="pending && !sending" variant="outline" color="neutral" @click="discard">Discard pending message</UButton><UButton type="submit" :loading="sending" :disabled="!ready || !draft.trim()">{{ pending && !sending ? 'Retry send' : 'Send message' }}</UButton></div></div>
        </form>
      </template>
      <p v-else class="py-8 text-sm text-muted">Choose a conversation or start one with a colleague.</p>
    </section>
  </div>
  <UModal v-model:open="newOpen" :title="editing ? 'Group settings' : 'New conversation'" :description="editing ? 'New members see messages sent after they join.' : 'Choose people from this customer. More than one recipient starts a group.'" :dismissible="!creating" :close="!creating">
    <template #body><form class="space-y-5" @submit.prevent="create"><UAlert v-if="newError" color="error" :title="newError" />
      <div v-if="canEdit" class="flex gap-2"><UInput v-model="search" aria-label="Find a colleague" placeholder="Find a colleague…" class="min-w-0 flex-1" :maxlength="160" :disabled="creating || conversationPending" /><UButton variant="outline" color="neutral" :loading="peopleLoading" :disabled="creating || conversationPending" @click="searched=search;loadPeople()">Search</UButton></div>
      <fieldset v-if="canEdit" class="space-y-3"><legend class="mb-3 text-sm font-medium">People · {{ recipients.length }}/19 selected</legend>
        <div v-for="person in people" :key="person.id"><UCheckbox :model-value="recipients.some(item=>item.id===person.id)" :label="person.name" :disabled="creating || conversationPending || (recipients.length>=19 && !recipients.some(item=>item.id===person.id))" @update:model-value="choose(person,$event===true)" /></div>
        <p v-if="!people.length" class="text-sm text-muted" role="status">{{ peopleLoading ? 'Loading people…' : 'No active licensed colleagues match this search.' }}</p>
        <UButton v-if="peopleCursor" variant="outline" color="neutral" :loading="peopleLoading" :disabled="creating || conversationPending" @click="loadPeople(true)">More people</UButton>
      </fieldset>
      <ul v-if="recipients.length" class="space-y-2"><li v-for="person in recipients" :key="person.id" class="flex items-center justify-between gap-3"><span class="break-words text-sm">{{ person.name }}</span><UButton v-if="editing && canEdit" size="xs" color="neutral" variant="ghost" :disabled="creating || conversationPending" :aria-label="`Remove ${person.name}`" @click="choose(person,false);groupOwner===person.id && (groupOwner=history!.userId)">Remove</UButton></li></ul>
      <UFormField v-if="(editing || recipients.length>1) && canEdit" label="Group name" required><UInput v-model="title" :maxlength="160" required :disabled="creating || conversationPending" class="w-full" /></UFormField>
      <UFormField v-if="editing && canEdit" label="Group owner"><USelect v-model="groupOwner" :disabled="creating || conversationPending" :items="[{label:'You',value:history?.userId ?? ''},...recipients.map(person=>({label:person.name,value:person.id}))]" class="w-full" /></UFormField>
      <p v-if="editing && !canEdit" class="text-sm text-muted">Only the group owner can change its name or people.</p>
      <p v-if="conversationPending" class="text-sm text-muted">The request may have completed. Retry keeps the same request.</p>
      <UButton v-if="editing && newError && !groupPending && !creating" variant="outline" color="neutral" @click="newOpen=false;loadHistory()">Reload group</UButton>
      <UButton v-if="conversationPending && !creating" variant="outline" color="neutral" @click="groupPending=null;newPending=null;newError='';newOpen=false;loadThreads();loadHistory()">Discard retry and reload</UButton>
      <UButton v-if="canEdit" type="submit" block :loading="creating" :disabled="(!editing && !recipients.length) || ((Boolean(editing) || recipients.length>1) && !title.trim()) || (Boolean(editing) && !history)">{{ conversationPending ? 'Retry request' : editing ? 'Save group' : 'Start conversation' }}</UButton>
      <UButton v-if="editing" block variant="outline" color="error" :disabled="creating || conversationPending" @click="newOpen=false;leaveError='';leaveOpen=true">Leave group</UButton>
    </form></template>
  </UModal>
  <UModal v-model:open="leaveOpen" title="Leave group?" description="You will lose access to this group's messages. If you own it, ownership passes to a remaining member." :dismissible="!leaving" :close="!leaving"><template #body><div class="space-y-4"><UAlert v-if="leaveError" color="error" title="Leaving not confirmed" :description="leaveError" /><div class="flex justify-end gap-3"><UButton color="neutral" variant="outline" :disabled="leaving" @click="leaveOpen=false;loadHistory()">Cancel</UButton><UButton color="error" :loading="leaving" @click="leave">{{ leaveError ? 'Retry leaving' : 'Leave group' }}</UButton></div></div></template></UModal>
</template>
