import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import { sealSecret, openSecret } from '../server/lib/crypto'
import { getConfig } from '../server/lib/config'
import * as platform from '../server/lib/platform'
import { gatewayFixture } from './gateway-fixture'
import { messageInput, conversationInput, groupInput, messageSequence } from '../shared/messages'
import { messagePeople, messageAlerts, createConversation, conversations, conversationMessages, sendMessage, markConversationRead, messagingRequest, pruneMessageHistory, updateMessageGroup, leaveMessageGroup, saveMessagePushToken, removeMessagePushToken } from '../server/lib/messages'
import { runOnePushJob } from '../server/lib/push-jobs'
import { savePushToken } from '../server/lib/mobile-calls'

process.env.SIPPER_GATEWAY_ID=`messages-${randomUUID()}`
after(()=>getPool().end())
const code=(value:string)=>(error:any)=>error.code===value
async function fixture(t:any) {
  const f=await gatewayFixture();t.after(async()=>{
    await getPool().query(`DELETE FROM jobs WHERE kind='message_push' AND deduplication_key LIKE ANY(
      SELECT 'message_push:'||id::text||':%' FROM text_messages WHERE organisation_id=$1)`,[f.organisation])
    await f.cleanup()
  })
  await getPool().query('UPDATE subscriptions SET purchased_seats=4 WHERE workspace_id=$1',[f.workspace])
  const peers=[]
  for(const name of ['Alex fixture','Bea fixture','Casey fixture']) {
    const userId=randomUUID(),actor={userId,email:`${userId}@example.invalid`,verified:true,mfa:false}
    await getPool().query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[userId,name,actor.email])
    t.after(()=>getPool().query('DELETE FROM auth_user WHERE id=$1',[userId]))
    await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')",[f.workspace,f.organisation,userId])
    await platform.assignSeat(f.actor,f.workspace,userId)
    peers.push(actor)
  }
  return {...f,peers,scope:{organisationId:f.organisation},actor:{...f.actor,mfa:false}}
}
test('desktop alerts expose only current unread references to an owned licensed device, independently of SIP',async t=>{
  const f=await fixture(t),alex=f.peers[0]!,bea=f.peers[1]!
  const devices=await Promise.all(['macos','windows'].map(name=>platform.enrolDevice(alex,f.organisation,{installationId:randomUUID(),name:'Desktop alert fixture',platform:name,appVersion:'test',osVersion:'test'})))
  const {conversation:c}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex.userId]})
  await sendMessage(f.actor,f.scope,c.id,{id:randomUUID(),text:'Earlier private message'})
  const latest=await sendMessage(f.actor,f.scope,c.id,{id:randomUUID(),text:'Private text stays out of the alert'})
  await sendMessage(alex,f.scope,c.id,{id:randomUUID(),text:'Own reply must not alert'})
  const {conversation:group}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex.userId,bea.userId],title:'Joining cutoff fixture'})
  const joined=await sendMessage(bea,f.scope,group.id,{id:randomUUID(),text:'Before joining cutoff'})
  await getPool().query('UPDATE conversation_members SET joined_sequence=$3,last_read_sequence=$3 WHERE conversation_id=$1 AND user_id=$2',[group.id,alex.userId,joined.message.sequence])
  const result:any=await messagingRequest(alex,{deviceId:devices[0]!.id},'GET',['alerts'],undefined)
  assert.equal(result.userId,alex.userId);assert.equal(result.deviceId,devices[0]!.id)
  assert.equal(result.alerts.length,1);assert.equal(result.alerts[0].conversationId,c.id);assert.equal(result.alerts[0].sequence,latest.message.sequence)
  assert.deepEqual(Object.keys(result.alerts[0]).sort(),['conversationId','expiresAt','sequence'])
  assert.ok(!JSON.stringify(result).includes(latest.message.text));assert.ok(Date.parse(result.alerts[0].expiresAt)>Date.now())
  assert.deepEqual((await messageAlerts(alex,devices[0]!.id,{after:latest.message.sequence})).alerts,[])
  await assert.rejects(messageAlerts(f.actor,devices[0]!.id),code('not_found'))
  await assert.rejects(messagingRequest(alex,f.scope,'GET',['alerts'],undefined),code('not_found'))
  await assert.rejects(messageAlerts(alex,devices[0]!.id,{after:'01'}))
  await assert.rejects(messageAlerts(alex,devices[0]!.id,{unexpected:true}))
  await markConversationRead(alex,{deviceId:devices[1]!.id},c.id,{sequence:latest.message.sequence})
  assert.deepEqual((await messageAlerts(alex,devices[0]!.id)).alerts,[],'A read on another device suppresses the alert')
  const expired=await sendMessage(f.actor,f.scope,c.id,{id:randomUUID(),text:'Expired alert'})
  await getPool().query("UPDATE text_messages SET created_at=now()-interval '6 minutes' WHERE id=$1",[expired.message.id])
  assert.deepEqual((await messageAlerts(alex,devices[0]!.id)).alerts,[])
  await getPool().query("UPDATE text_messages SET created_at=now()-interval '4 minutes 45 seconds' WHERE id=$1",[expired.message.id])
  assert.deepEqual((await messageAlerts(alex,devices[0]!.id)).alerts,[],'The alert must stay fresh for the whole 30-second page authority')
  await platform.setMemberStatus({...f.actor,mfa:true},f.organisation,alex.userId,'suspended')
  await assert.rejects(messageAlerts(alex,devices[0]!.id))
  await platform.setMemberStatus({...f.actor,mfa:true},f.organisation,alex.userId,'active')
  await getPool().query('DELETE FROM seat_assignments WHERE workspace_id=$1 AND user_id=$2',[f.workspace,alex.userId])
  await assert.rejects(messageAlerts(alex,devices[0]!.id))
  await platform.assignSeat({...f.actor,mfa:true},f.workspace,alex.userId)
  await platform.revokeDevice({...f.actor,mfa:true},f.organisation,devices[0]!.id)
  await assert.rejects(messageAlerts(alex,devices[0]!.id),code('not_found'))
})
test('desktop alert pagination sorts bigint sequences numerically without decrypting message bodies',async t=>{
  const f=await fixture(t),alex=f.peers[0]!,expected=[]
  for(let i=0;i<102;i++) {
    const id=randomUUID(),sequence=String(9999999999999950n+BigInt(i));expected.push({id,sequence})
    await getPool().query("INSERT INTO conversations(id,organisation_id,kind,title,created_by,owner_id,last_sequence) VALUES($1,$2,'group','Opaque alert fixture',$3,$3,$4)",[id,f.organisation,f.actor.userId,sequence])
    await getPool().query('INSERT INTO conversation_members(organisation_id,conversation_id,user_id) VALUES($1,$2,$3)',[f.organisation,id,f.actor.userId])
    await getPool().query('INSERT INTO text_messages(id,sequence,organisation_id,conversation_id,sender_id,envelope) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),sequence,f.organisation,id,alex.userId,{}])
  }
  const first=await messageAlerts(f.actor,f.devices[0]!.id)
  assert.deepEqual(first.alerts.map(a=>[a.conversationId,a.sequence]),expected.slice(0,100).map(a=>[a.id,a.sequence]))
  assert.equal(first.nextCursor,expected[99]!.sequence)
  const last=await messageAlerts(f.actor,f.devices[0]!.id,{after:first.nextCursor})
  assert.deepEqual(last.alerts.map(a=>a.sequence),expected.slice(100).map(a=>a.sequence));assert.equal(last.nextCursor,null)
})
test('message notifications use separate owned mobile tokens, encrypted storage and exact-send deduplication',async t=>{
  const f=await fixture(t),alex=f.peers[0]!
  const mobile=await Promise.all(['ios','android'].map(platformName=>platform.enrolDevice(alex,f.organisation,{installationId:randomUUID(),name:'Message fixture',platform:platformName,appVersion:'test',osVersion:'test'})))
  const tokens=['AB'.repeat(32),'fictional-message-fcm-token']
  for(let i=0;i<mobile.length;i++) {
    const result:any=await messagingRequest(alex,{deviceId:mobile[i]!.id},'PUT',['push'],{token:tokens[i]})
    assert.equal(result.deviceId,mobile[i]!.id);assert.equal(result.registered,true)
    const saved=(await rows('SELECT * FROM message_push_endpoints WHERE device_id=$1',[mobile[i]!.id]))[0]!
    assert.equal(openSecret(saved.token_envelope,`message-push:${f.organisation}:${mobile[i]!.id}`),i===0 ? tokens[i]!.toLowerCase() : tokens[i])
    assert.ok(!JSON.stringify(saved).includes(tokens[i]!))
  }
  const own=f.devices[0]!.id
  await savePushToken(f.actor,own,{token:'a'.repeat(64)})
  await saveMessagePushToken(f.actor,own,{token:'b'.repeat(64)})
  assert.equal(openSecret((await rows('SELECT token_envelope FROM push_endpoints WHERE device_id=$1',[own]))[0]!.token_envelope,`push:${f.organisation}:${own}`),'a'.repeat(64))
  await assert.rejects(saveMessagePushToken(alex,own,{token:tokens[0]}),code('not_found'))
  await assert.rejects(saveMessagePushToken({...alex,verified:false},mobile[0]!.id,{token:tokens[0]}),code('email_verification_required'))
  await assert.rejects(saveMessagePushToken(alex,mobile[0]!.id,{token:tokens[1]}),code('invalid_push_token'))
  const {conversation}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex.userId]})
  const input={id:randomUUID(),text:'Private text never enters a push job'}
  await sendMessage(f.actor,f.scope,conversation.id,input);await sendMessage(f.actor,f.scope,conversation.id,input)
  const queued=await rows("SELECT * FROM jobs WHERE kind='message_push' AND payload->>'messageId'=$1",[input.id])
  assert.equal(queued.length,2)
  for(const job of queued) {assert.deepEqual(Object.keys(job.payload).sort(),['deviceId','messageId']);assert.ok(!JSON.stringify(job).includes(input.text))}
  const delivered:any[]=[]
  while(await runOnePushJob(async()=>{throw Error('Unexpected call delivery')},async push=>{
    delivered.push(push)
    assert.equal(push.conversationId,conversation.id);assert.ok(!JSON.stringify(push).includes(input.text))
    // A provider response for the old token must not disable a replacement.
    await saveMessagePushToken(alex,push.deviceId,{token:push.provider==='apns' ? 'c'.repeat(64) : 'replacement-fictional-fcm-token'})
    return 'invalid_token'
  })) {}
  assert.equal(delivered.length,2)
  assert.equal((await rows('SELECT count(*)::int AS n FROM message_push_endpoints WHERE device_id=ANY($1::uuid[]) AND disabled_at IS NOT NULL',[mobile.map(d=>d.id)]))[0]!.n,0)
  const complete=await rows('SELECT payload,completed_at FROM jobs WHERE id=ANY($1::uuid[])',[queued.map(j=>j.id)])
  assert.ok(complete.every(j=>j.completed_at && JSON.stringify(j.payload)==='{}'))
  await removeMessagePushToken(alex,mobile[0]!.id);await removeMessagePushToken(alex,mobile[0]!.id)
  await assert.rejects(removeMessagePushToken(f.actor,mobile[1]!.id),code('not_found'))
  const desktop=await platform.enrolDevice(alex,f.organisation,{installationId:randomUUID(),name:'Desktop fixture',platform:'macos',appVersion:'test',osVersion:'test'})
  await assert.rejects(saveMessagePushToken(alex,desktop.id,{token:tokens[1]}),code('unsupported_push_platform'))
})
test('message push rechecks unread, joining, licence, revocation, expiry and recovery hold before delivery',async t=>{
  const f=await fixture(t),alex=f.peers[0]!,bea=f.peers[1]!
  const device=await platform.enrolDevice(alex,f.organisation,{installationId:randomUUID(),name:'Message fixture',platform:'android',appVersion:'test',osVersion:'test'})
  await saveMessagePushToken(alex,device.id,{token:'fictional-message-fcm-token'})
  let {conversation:c}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex.userId,bea.userId],title:'Message alerts fixture'})
  const send=()=>sendMessage(f.actor,f.scope,c.id,{id:randomUUID(),text:'Only an unread eligible recipient may be notified'})
  const drain=async()=>{while(await runOnePushJob(async()=>{throw Error('Unexpected call delivery')},async()=>{assert.fail('Ineligible message must not be sent')})) {}}
  let message=await send();await markConversationRead(alex,f.scope,c.id,{sequence:message.message.sequence});await drain()
  await send();await leaveMessageGroup(alex,f.scope,c.id)
  c=(await conversationMessages(f.actor,f.scope,c.id)).conversation
  c=(await updateMessageGroup(f.actor,f.scope,c.id,{revision:c.revision,title:c.title,userIds:[f.actor.userId,alex.userId,bea.userId],ownerId:f.actor.userId})).conversation
  await drain()
  await send();await platform.setMemberStatus({...f.actor,mfa:true},f.organisation,alex.userId,'suspended');await drain()
  await platform.setMemberStatus({...f.actor,mfa:true},f.organisation,alex.userId,'active')
  await send();await getPool().query("UPDATE subscriptions SET status='cancelled' WHERE workspace_id=$1",[f.workspace]);await drain()
  await getPool().query("UPDATE subscriptions SET status='active' WHERE workspace_id=$1",[f.workspace])
  message=await send();await getPool().query("UPDATE text_messages SET created_at=now()-interval '6 minutes' WHERE id=$1",[message.message.id]);await drain()
  await send();await getPool().query('UPDATE service_recovery SET restored_at=now(),released_at=NULL WHERE singleton')
  try {await drain()} finally {await getPool().query('UPDATE service_recovery SET restored_at=NULL,released_at=NULL WHERE singleton')}
  await send();await getPool().query('UPDATE devices SET revoked_at=now() WHERE id=$1',[device.id]);await drain()
  assert.equal((await rows('SELECT 1 FROM message_push_endpoints WHERE device_id=$1',[device.id])).length,0)
})
test('managed messaging bounds input, preserves plain text and rejects forged fields',()=>{
  const id=randomUUID()
  assert.equal(messageInput.parse({id:id.toUpperCase(),text:'Hello'}).id,id)
  assert.equal(messageInput.parse({id,text:'<script>\nhello\t🌱</script>'}).text,'<script>\nhello\t🌱</script>')
  for(const text of ['', ' \n ', '\0', 'a'.repeat(4097)]) assert.equal(messageInput.safeParse({id,text}).success,false)
  assert.equal(messageInput.safeParse({id,text:'Hi',senderId:'someone'}).success,false)
  assert.equal(conversationInput.safeParse({id,userIds:['a','a'],title:'Team'}).success,false)
  assert.equal(conversationInput.safeParse({id,userIds:['a','b']}).success,false)
  for(const sequence of ['-1','01','9223372036854775808','1.1']) assert.equal(messageSequence.safeParse(sequence).success,false)
  for(const input of [{revision:'0',title:'Team',userIds:['a'],ownerId:'a'}, {revision:'1',title:' ',userIds:['a'],ownerId:'a'},
    {revision:'1',title:'Team',userIds:['a','a'],ownerId:'a'}, {revision:'1',title:'Team',userIds:['a'],ownerId:'b'}])
    assert.equal(groupInput.safeParse(input).success,false)
})
test('group ownership, revision conflicts and joining history remain scoped across native and web requests',async t=>{
  const f=await fixture(t),[alex,bea,casey]=f.peers
  let {conversation:c}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex!.userId,bea!.userId],title:'Original group'})
  assert.equal(c.ownerId,f.actor.userId);assert.equal(c.revision,'1')
  const old=await sendMessage(alex!,f.scope,c.id,{id:randomUUID(),text:'Before Casey joined'})
  const edit={revision:c.revision,title:'Project group',userIds:[f.actor.userId,alex!.userId,bea!.userId,casey!.userId],ownerId:f.actor.userId}
  await assert.rejects(updateMessageGroup(bea!,f.scope,c.id,edit),code('group_owner_required'))
  await assert.rejects(updateMessageGroup(casey!,f.scope,c.id,edit),code('not_found'))
  const changed=await messagingRequest(f.actor,{deviceId:f.devices[0]!.id},'PUT',['conversations',c.id.toUpperCase(),'group'],edit) as any
  c=changed.conversation
  assert.ok(BigInt(c.revision)>1n);assert.equal(c.title,'Project group')
  assert.equal(c.participants.find(p=>p.id===casey!.userId)!.joinedSequence,old.message.sequence)
  assert.equal((await updateMessageGroup(f.actor,f.scope,c.id,edit)).conversation.revision,c.revision)
  assert.equal((await conversationMessages(casey!,f.scope,c.id)).messages.length,0)
  assert.equal((await conversationMessages(casey!,f.scope,c.id)).conversation.unread,0)
  await assert.rejects(conversationMessages(casey!,f.scope,c.id,{before:old.message.sequence}),code('message_page_changed'))
  await assert.rejects(markConversationRead(casey!,f.scope,c.id,{sequence:old.message.sequence}),code('invalid_message_sequence'))
  await assert.rejects(updateMessageGroup(f.actor,f.scope,c.id,{...edit,title:'Stale rename'}),code('conversation_conflict'))
  const concurrent=await Promise.allSettled(['One rename','Another rename'].map(title=>updateMessageGroup(f.actor,f.scope,c.id,{...edit,revision:c.revision,title})))
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(concurrent.filter(r=>r.status==='rejected' && r.reason.code==='conversation_conflict').length,1)
  c=(await conversationMessages(f.actor,f.scope,c.id)).conversation
  const newText=await sendMessage(bea!,f.scope,c.id,{id:randomUUID(),text:'After Casey joined'})
  assert.deepEqual((await conversationMessages(casey!,f.scope,c.id)).messages.map(m=>m.id),[newText.message.id])
  const transfer={revision:c.revision,title:c.title,userIds:c.participants.map(p=>p.id),ownerId:alex!.userId}
  c=(await updateMessageGroup(f.actor,f.scope,c.id,transfer)).conversation
  assert.equal(c.ownerId,alex!.userId)
  assert.equal((await updateMessageGroup(f.actor,f.scope,c.id,transfer)).conversation.revision,c.revision)
  await assert.rejects(updateMessageGroup(f.actor,f.scope,c.id,{...transfer,revision:c.revision,title:'Former owner rename'}),code('group_owner_required'))
  c=(await updateMessageGroup(alex!,f.scope,c.id,{...transfer,revision:c.revision,userIds:c.participants.map(p=>p.id).filter(id=>id!==bea!.userId)})).conversation
  await assert.rejects(conversationMessages(bea!,f.scope,c.id),code('not_found'))
  await assert.rejects(sendMessage(bea!,f.scope,c.id,{id:randomUUID(),text:'Removed user'}),code('not_found'))
  c=(await updateMessageGroup(alex!,f.scope,c.id,{revision:c.revision,title:c.title,userIds:[...c.participants.map(p=>p.id),bea!.userId],ownerId:alex!.userId})).conversation
  assert.equal((await conversationMessages(bea!,f.scope,c.id)).messages.length,0)
  await assert.rejects(sendMessage(bea!,f.scope,c.id,{id:newText.message.id,text:newText.message.text}),code('message_conflict'))
  const leave=await messagingRequest(alex!,f.scope,'POST',['conversations',c.id,'leave'],{}) as any
  assert.equal(leave.left,true);assert.equal(leave.conversationId,c.id)
  assert.equal((await leaveMessageGroup(alex!,f.scope,c.id)).left,true)
  assert.equal((await leaveMessageGroup(alex!,f.scope,randomUUID())).left,true)
  await assert.rejects(conversationMessages(alex!,f.scope,c.id),code('not_found'))
  c=(await conversationMessages(f.actor,f.scope,c.id)).conversation
  assert.ok(c.ownerId && c.ownerId!==alex!.userId && c.participants.some(p=>p.id===c.ownerId))
  await getPool().query('DELETE FROM organisation_members WHERE organisation_id=$1 AND user_id=$2',[f.organisation,c.ownerId])
  const stillIn=c.participants.find(p=>p.id!==c.ownerId)!
  const survivor=[f.actor,...f.peers].find(p=>p.userId===stillIn.id)!
  c=(await conversationMessages(survivor,f.scope,c.id)).conversation
  assert.ok(c.ownerId && c.participants.some(p=>p.id===c.ownerId));assert.ok(BigInt(c.revision)>BigInt(transfer.revision))
})
test('group edits cannot revive ineligible people, direct pairs or withdrawn devices',async t=>{
  const f=await fixture(t),[alex,bea,casey]=f.peers
  const {conversation:c}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex!.userId,bea!.userId],title:'Access group'})
  const edit={revision:c.revision,title:c.title,userIds:[f.actor.userId,alex!.userId,bea!.userId,casey!.userId],ownerId:f.actor.userId}
  await platform.setMemberStatus({...f.actor,mfa:true},f.organisation,casey!.userId,'suspended')
  await assert.rejects(updateMessageGroup(f.actor,f.scope,c.id,edit),code('invalid_recipients'))
  await assert.rejects(updateMessageGroup(f.actor,f.scope,c.id,{...edit,userIds:[alex!.userId,bea!.userId],ownerId:alex!.userId}),code('invalid_message_group'))
  await assert.rejects(updateMessageGroup(f.actor,f.scope,c.id,{...edit,userIds:[f.actor.userId,alex!.userId,bea!.userId],ownerId:casey!.userId}))
  const {conversation:d}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex!.userId]})
  await assert.rejects(updateMessageGroup(f.actor,f.scope,d.id,{...edit,userIds:[f.actor.userId,alex!.userId]}),code('invalid_message_group'))
  await assert.rejects(leaveMessageGroup(f.actor,f.scope,d.id),code('invalid_message_group'))
  const old=await sendMessage(f.actor,f.scope,d.id,{id:randomUUID(),text:'Previous membership'})
  await getPool().query('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[d.id,f.actor.userId])
  const restored=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex!.userId]})
  assert.equal(restored.conversation.id,d.id)
  assert.equal((await conversationMessages(f.actor,f.scope,d.id)).messages.length,0)
  await assert.rejects(sendMessage(f.actor,f.scope,d.id,{id:old.message.id,text:old.message.text}),code('message_conflict'))
  await platform.revokeDevice({...f.actor,mfa:true},f.organisation,f.devices[0]!.id)
  await assert.rejects(updateMessageGroup(f.actor,{deviceId:f.devices[0]!.id},c.id,{...edit,userIds:[f.actor.userId,alex!.userId,bea!.userId]}),code('not_found'))
  await assert.rejects(leaveMessageGroup(f.actor,{deviceId:f.devices[0]!.id},c.id),code('not_found'))
  assert.equal((await conversationMessages(f.actor,f.scope,c.id)).conversation.revision,c.revision)
})
test('direct/group conversations are customer-bound, retry-safe and unavailable without an active user licence',async t=>{
  const f=await fixture(t),[alex,bea,casey]=f.peers
  const people=await messagePeople(f.actor,f.scope)
  assert.equal(people.people.length,3);assert.ok(!JSON.stringify(people).includes(alex!.email))
  assert.equal((await messagePeople(f.actor,f.scope,{q:'Alex'})).people[0]!.id,alex!.userId)
  const direct=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex!.userId]})
  const again=await createConversation(alex!,f.scope,{id:randomUUID(),userIds:[f.actor.userId]})
  assert.equal(direct.conversation.id,again.conversation.id)
  const simultaneous=await Promise.all([createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[bea!.userId]}),createConversation(bea!,f.scope,{id:randomUUID(),userIds:[f.actor.userId]})])
  assert.equal(simultaneous[0]!.conversation.id,simultaneous[1]!.conversation.id)
  const request={id:randomUUID().toUpperCase(),userIds:[alex!.userId,bea!.userId],title:'Project team'}
  const group=await createConversation(f.actor,f.scope,request)
  assert.equal(group.conversation.kind,'group');assert.equal(group.conversation.participants.length,3)
  assert.equal(group.conversation.id,request.id.toLowerCase())
  assert.equal((await createConversation(f.actor,f.scope,request)).conversation.id,group.conversation.id)
  await assert.rejects(createConversation(f.actor,f.scope,{...request,title:'Changed'}),code('conversation_conflict'))
  await assert.rejects(conversationMessages(casey!,f.scope,group.conversation.id),code('not_found'))
  const other=await platform.createOrganisation({...f.actor,mfa:true},f.workspace,{name:'Separate message customer'})
  await assert.rejects(createConversation(f.actor,{organisationId:other.id},{id:randomUUID(),userIds:[alex!.userId]}),code('managed_access_unavailable'))
  await assert.rejects(createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[f.actor.userId]}),code('invalid_recipients'))
  await platform.setMemberStatus({...f.actor,mfa:true},f.organisation,alex!.userId,'suspended')
  assert.ok(!(await messagePeople(f.actor,f.scope)).people.some(person=>person.id===alex!.userId))
  await assert.rejects(sendMessage(f.actor,f.scope,direct.conversation.id,{id:randomUUID(),text:'Unavailable'}),code('recipients_unavailable'))
  await assert.rejects(conversationMessages(alex!,f.scope,direct.conversation.id),code('managed_access_unavailable'))
  await assert.rejects(createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex!.userId]}),code('invalid_recipients'))
  await sendMessage(f.actor,f.scope,group.conversation.id,{id:randomUUID(),text:'Remaining members'})
  await platform.releaseSeat({...f.actor,mfa:true},f.workspace,f.actor.userId)
  await assert.rejects(conversations(f.actor,f.scope),code('managed_access_unavailable'))
  await assert.rejects(messagePeople({...bea!,verified:false},f.scope),code('email_verification_required'))
})
test('encrypted text retries, ordered concurrent sends and cross-device read markers cannot leak or impersonate another conversation',async t=>{
  const f=await fixture(t),[alex,bea]=f.peers
  const {conversation:c}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex!.userId]})
  const value={id:randomUUID().toUpperCase(),text:'Private fixture text with <b>plain markup</b>'}
  const [a,b]=await Promise.all([sendMessage(f.actor,f.scope,c.id,value),sendMessage(f.actor,{deviceId:f.devices[0]!.id},c.id,{...value,id:value.id.toLowerCase()})])
  assert.deepEqual(a.message,b.message)
  assert.equal(a.message.id,value.id.toLowerCase())
  const stored=(await rows('SELECT envelope FROM text_messages WHERE id=$1',[value.id]))[0]!
  assert.ok(!JSON.stringify(stored).includes(value.text))
  assert.equal((await rows('SELECT id FROM text_messages WHERE conversation_id=$1',[c.id])).length,1)
  await assert.rejects(sendMessage(alex!,f.scope,c.id,value),code('message_conflict'))
  await assert.rejects(sendMessage(f.actor,f.scope,c.id,{...value,text:'Changed pending text'}),code('message_conflict'))
  const replies=await Promise.all(['One','Two','Three'].map(text=>sendMessage(alex!,f.scope,c.id,{id:randomUUID(),text})))
  const history=await conversationMessages(f.actor,{deviceId:f.devices[1]!.id},c.id)
  assert.equal(history.messages.length,4)
  assert.ok(history.messages.every((message,i)=>i===0 || BigInt(message.sequence)>BigInt(history.messages[i-1]!.sequence)))
  assert.equal(history.conversation.unread,3)
  const sequence=history.messages.at(-1)!.sequence
  await markConversationRead(f.actor,{deviceId:f.devices[1]!.id},c.id,{sequence})
  await markConversationRead(f.actor,{deviceId:f.devices[0]!.id},c.id,{sequence:replies[0]!.message.sequence})
  const refreshed=await conversationMessages(f.actor,f.scope,c.id)
  assert.equal(refreshed.conversation.unread,0)
  assert.equal(refreshed.conversation.participants.find(person=>person.id===f.actor.userId)!.lastReadSequence,sequence)
  const {conversation:other}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[bea!.userId]})
  await assert.rejects(markConversationRead(f.actor,f.scope,other.id,{sequence}),code('invalid_message_sequence'))
  await assert.rejects(conversationMessages(f.actor,f.scope,other.id,{before:sequence}),code('message_page_changed'))
  await assert.rejects(sendMessage(f.actor,f.scope,other.id,value),code('message_conflict'))
  await assert.rejects(conversationMessages(alex!,{deviceId:f.devices[0]!.id},c.id),code('not_found'))
  await platform.revokeDevice({...f.actor,mfa:true},f.organisation,f.devices[0]!.id)
  await assert.rejects(conversationMessages(f.actor,{deviceId:f.devices[0]!.id},c.id),code('not_found'))
  assert.equal((await conversationMessages(f.actor,{deviceId:f.devices[1]!.id},c.id)).messages.length,4)
  // Swapping two envelopes must fail their conversation/message binding.
  const otherMessage=await sendMessage(f.actor,f.scope,other.id,{id:randomUUID(),text:'Other room'})
  await getPool().query('UPDATE text_messages SET envelope=$2 WHERE id=$1',[otherMessage.message.id,stored.envelope])
  await assert.rejects(conversationMessages(f.actor,f.scope,other.id))
  assert.ok(!(await rows('SELECT details FROM audit_events WHERE organisation_id=$1',[f.organisation])).some(row=>JSON.stringify(row).includes(value.text)))
})
test('history is bounded, expiry removes authority immediately and cleanup erases encrypted content',async t=>{
  const f=await fixture(t),[alex]=f.peers
  const {conversation:c}=await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[alex!.userId]})
  for(let i=0;i<102;i++) {
    const id=randomUUID(),envelope=sealSecret(`Message ${i}`,`message:${f.organisation}:${c.id}:${id}`)
    await getPool().query('INSERT INTO text_messages(id,organisation_id,conversation_id,sender_id,envelope) VALUES($1,$2,$3,$4,$5)',[id,f.organisation,c.id,alex!.userId,envelope])
  }
  const first=await conversationMessages(f.actor,f.scope,c.id)
  assert.equal(first.messages.length,100);assert.ok(first.nextCursor)
  const older=await conversationMessages(f.actor,f.scope,c.id,{before:first.nextCursor!})
  assert.equal(older.messages.length,2);assert.equal(older.nextCursor,null)
  const newer=await conversationMessages(f.actor,f.scope,c.id,{after:older.messages[0]!.sequence})
  assert.equal(newer.messages.length,100);assert.ok(newer.nextCursor)
  const last=first.messages.at(-1)!
  await getPool().query("UPDATE text_messages SET created_at=now()-($2*interval '1 day') WHERE id=$1",[last.id,getConfig().SIPPER_MESSAGE_RETENTION_DAYS+1])
  assert.ok(!(await conversationMessages(f.actor,f.scope,c.id)).messages.some(message=>message.id===last.id))
  await assert.rejects(markConversationRead(f.actor,f.scope,c.id,{sequence:last.sequence}),code('invalid_message_sequence'))
  await pruneMessageHistory()
  assert.equal((await rows('SELECT id FROM text_messages WHERE id=$1',[last.id])).length,0)
  const request={id:randomUUID(),text:'Retry is accepted before a rate check'}
  await sendMessage(f.actor,f.scope,c.id,request)
  for(let i=0;i<60;i++) {
    const id=randomUUID()
    await getPool().query('INSERT INTO text_messages(id,organisation_id,conversation_id,sender_id,envelope) VALUES($1,$2,$3,$4,$5)',[id,f.organisation,c.id,f.actor.userId,sealSecret('Rate fixture',`message:${f.organisation}:${c.id}:${id}`)])
  }
  await assert.rejects(sendMessage(f.actor,f.scope,c.id,{id:randomUUID(),text:'Limited'}),code('message_rate_limit'))
  assert.equal((await sendMessage(f.actor,f.scope,c.id,request)).message.text,request.text)
  await assert.rejects(messagingRequest(f.actor,f.scope,'GET',['unknown'],undefined),code('not_found'))
})
