import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { AccessToken, TokenVerifier } from 'livekit-server-sdk'
import { getPool, rows } from '../server/lib/db'
import { getConfig } from '../server/lib/config'
import { gatewayFixture } from './gateway-fixture'
import * as platform from '../server/lib/platform'
import { userId as routePerson } from '../server/lib/http'
import { createConversation, updateMessageGroup } from '../server/lib/messages'
import { admitMeetingConnection, currentMeeting, startMeeting, joinMeeting, endMeeting, leaveMeeting, removeMeetingPerson, meetingDetails, meetingRequest, reconcileMeetingAccess, runOneMeetingControl, requireMeetingAdmissionKey,customerMeetings,adminEndMeeting } from '../server/lib/meetings'

process.env.SIPPER_GATEWAY_ID=`meetings-${randomUUID()}`
process.env.SIPPER_MEETING_PUBLIC_URL='ws://127.0.0.1:17881'
process.env.SIPPER_MEETING_API_KEY='fictional-meeting-key'
process.env.SIPPER_MEETING_API_SECRET=randomUUID()+randomUUID()
process.env.SIPPER_MEETING_ADMISSION_KEY=randomUUID()+randomUUID()
const mediaRooms=new Map<string,Set<string>>(),requests:string[]=[]
let failControl=false,createHold:Promise<void>|undefined,createEntered:(()=>void)|undefined
// This server tests the actual SDK's signed requests and protobuf JSON contract.
// It is not evidence of WebRTC, audio, video or a running LiveKit media server.
const media=http.createServer(async(req,res)=>{
  try {
    const claims=await new TokenVerifier(process.env.SIPPER_MEETING_API_KEY!,process.env.SIPPER_MEETING_API_SECRET!).verify((req.headers.authorization ?? '').replace(/^Bearer /,''),0)
    assert.ok(claims.video?.roomCreate || claims.video?.roomList || claims.video?.roomAdmin)
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw),method=req.url!.split('/').at(-1)!;requests.push(method)
    res.setHeader('content-type','application/json')
    if(failControl && method!=='CreateRoom') {res.writeHead(503);res.end('{"code":"unavailable","msg":"Fixture failure"}');return}
    if(method==='CreateRoom') {createEntered?.();await createHold;mediaRooms.set(body.name,mediaRooms.get(body.name) ?? new Set());res.end(JSON.stringify({name:body.name,sid:'RM_fixture'}));return}
    if(method==='ListRooms') {res.end(JSON.stringify({rooms:[...mediaRooms.keys()].filter(room=>!body.names?.length || body.names.includes(room)).map(name=>({name,sid:'RM_fixture'}))}));return}
    if(method==='ListParticipants') {res.end(JSON.stringify({participants:[...(mediaRooms.get(body.room) ?? [])].map(identity=>({identity,sid:'PA_fixture'}))}));return}
    if(method==='RemoveParticipant')mediaRooms.get(body.room)?.delete(body.identity)
    else if(method==='DeleteRoom')mediaRooms.delete(body.room)
    else assert.fail(`Unexpected method ${method}`)
    res.end('{}')
  } catch {res.writeHead(500);res.end('{"code":"internal","msg":"Fixture failed"}')}
})
before(async()=>{await new Promise<void>(resolve=>media.listen(0,'127.0.0.1',resolve));process.env.SIPPER_MEETING_INTERNAL_URL=`http://127.0.0.1:${(media.address() as any).port}`})
after(async()=>{await new Promise<void>(resolve=>media.close(()=>resolve()));await getPool().end()})
const rejects=(fn:Promise<unknown>)=>assert.rejects(fn)
test('opaque person route segments decode once and reject malformed escapes',()=>{
  const id='alèx/fixture?x#y%z'
  assert.equal(routePerson(encodeURIComponent(id)),id)
  assert.equal(routePerson('%252F'),'%2F')
  assert.throws(()=>routePerson('bad%'),{status:400,code:'invalid_input'})
  assert.throws(()=>routePerson(encodeURIComponent('x'.repeat(129))))
})
test('missing meeting settings disable joins and partial or unsafe settings fail closed',()=>{
  const blank={...process.env,SIPPER_MEETING_PUBLIC_URL:'',SIPPER_MEETING_INTERNAL_URL:'',SIPPER_MEETING_API_KEY:'',SIPPER_MEETING_API_SECRET:'',SIPPER_MEETING_ADMISSION_KEY:''}
  const script=`import('./server/lib/meetings.ts').then(async m=>{if(m.meetingsAvailable())process.exit(1);try{await m.joinMeeting({}, {},'unused', {id:'${randomUUID()}'})}catch(e){process.exit(e.code==='meetings_not_configured' ? 0 : 1)}process.exit(1)})`
  assert.equal(spawnSync(process.execPath,['--import','tsx','-e',script],{env:blank,stdio:'pipe'}).status,0)
  for(const values of [
    {SIPPER_MEETING_PUBLIC_URL:'wss://meet.example.invalid'},
    {SIPPER_MEETING_PUBLIC_URL:'https://meet.example.invalid'},
    {SIPPER_MEETING_INTERNAL_URL:'http://media.example.invalid/path'},
    {SIPPER_MEETING_API_SECRET:process.env.SIPPER_MEETING_ADMISSION_KEY},
  ]) {
    const child=spawnSync(process.execPath,['--import','tsx','-e',"import('./server/lib/config.ts').then(m=>{try{m.getConfig();process.exit(1)}catch{process.exit(0)}})"],{env:{...(Object.keys(values).length===1 && values.SIPPER_MEETING_PUBLIC_URL==='wss://meet.example.invalid' ? blank : process.env),...values},stdio:'pipe'})
    assert.equal(child.status,0)
  }
})
async function fixture(t:any) {
  const f=await gatewayFixture(),peerId=randomUUID(),peer={userId:peerId,email:`${peerId}@example.invalid`,verified:true,mfa:false,sessionId:randomUUID()}
  const actor={...f.actor,sessionId:randomUUID()},scope={organisationId:f.organisation}
  await getPool().query('UPDATE subscriptions SET purchased_seats=3 WHERE workspace_id=$1',[f.workspace])
  await getPool().query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[peerId,'Meeting peer fixture',peer.email])
  await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')",[f.workspace,f.organisation,peerId])
  await platform.assignSeat(actor,f.workspace,peerId)
  for(const user of [actor,peer])await getPool().query('INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 day\',now(),now())',[user.sessionId,randomUUID(),user.userId])
  const device=await platform.enrolDevice(peer,f.organisation,{installationId:randomUUID(),name:'Meeting device fixture',platform:'android',appVersion:'test',osVersion:'test'})
  const {conversation}=await createConversation(actor,scope,{id:randomUUID(),userIds:[peerId]})
  t.after(async()=>{
    const names=(await rows('SELECT media_room FROM meetings WHERE organisation_id=$1',[f.organisation])).map(m=>m.media_room)
    const keys=[...(await rows('SELECT id FROM meetings WHERE organisation_id=$1',[f.organisation])).map(m=>`meeting_end:${m.id}`),
      ...(await rows('SELECT id FROM meeting_sessions WHERE organisation_id=$1',[f.organisation])).map(s=>`meeting_remove:${s.id}`)]
    await f.cleanup();await getPool().query('DELETE FROM auth_user WHERE id=$1',[peerId])
    await getPool().query("DELETE FROM jobs WHERE kind='meeting_control' AND deduplication_key=ANY($1::text[])",[keys])
    for(const name of names)mediaRooms.delete(name)
  })
  return {...f,actor,peer,scope,conversation,device}
}
test('meeting lifecycle uses current conversation access, one room and exact retry identities',async t=>{
  const f=await fixture(t),id=randomUUID()
  assert.equal((await currentMeeting(f.actor,f.scope,f.conversation.id)).meeting,null)
  const starts=await Promise.all([startMeeting(f.actor,f.scope,f.conversation.id,{id}),startMeeting(f.peer,{deviceId:f.device.id},f.conversation.id,{id:randomUUID()})])
  assert.equal(starts[0]!.meeting.id,starts[1]!.meeting.id)
  const meeting=starts[0]!.meeting,host=meeting.createdBy===f.actor.userId ? f.actor : f.peer,other=host===f.actor ? f.peer : f.actor
  assert.equal((await startMeeting(host,f.scope,f.conversation.id,{id:meeting.id})).meeting.id,meeting.id)
  await rejects(startMeeting(other,f.scope,f.conversation.id,{id:meeting.id}))
  const joinId=randomUUID(),grant=await joinMeeting(f.peer,{deviceId:f.device.id},meeting.id,{id:joinId})
  assert.equal(grant.identity,`sipper:${joinId}`);assert.equal(grant.url,getConfig().SIPPER_MEETING_PUBLIC_URL)
  const claims=await new TokenVerifier(getConfig().SIPPER_MEETING_API_KEY,getConfig().SIPPER_MEETING_API_SECRET).verify(grant.token,0)
  assert.equal(claims.video?.room,`sipper-${meeting.id}`);assert.equal(claims.video?.canPublishData,false);assert.equal(claims.video?.roomAdmin,undefined)
  assert.equal((await admitMeetingConnection({token:grant.token})).sessionId,joinId)
  await Promise.all([admitMeetingConnection({token:grant.token}),admitMeetingConnection({token:grant.token})])
  assert.equal((await joinMeeting(f.peer,{deviceId:f.device.id},meeting.id,{id:joinId})).sessionId,joinId)
  const details=await meetingDetails(f.peer,{deviceId:f.device.id},meeting.id)
  assert.equal(details.sessions.length,1);assert.ok(details.sessions[0]!.admittedAt);assert.ok(!JSON.stringify(details).includes(grant.token))
  await rejects(joinMeeting(f.actor,f.scope,meeting.id,{id:joinId}))
  await rejects(endMeeting(other,f.scope,meeting.id))
  await rejects(leaveMeeting(f.actor,f.scope,meeting.id,joinId))
  await leaveMeeting(f.peer,{deviceId:f.device.id},meeting.id,joinId)
  await rejects(admitMeetingConnection({token:grant.token}));await rejects(joinMeeting(f.peer,{deviceId:f.device.id},meeting.id,{id:joinId}))
  const next=await joinMeeting(f.peer,{deviceId:f.device.id},meeting.id,{id:randomUUID()})
  assert.notEqual(next.sessionId,joinId)
  await endMeeting(host,f.scope,meeting.id)
  await rejects(admitMeetingConnection({token:next.token}));await rejects(joinMeeting(other,f.scope,meeting.id,{id:randomUUID()}))
  assert.equal((await currentMeeting(f.actor,f.scope,f.conversation.id)).meeting,null)
  const later=await startMeeting(f.actor,f.scope,f.conversation.id,{id:randomUUID()});assert.notEqual(later.meeting.id,meeting.id)
  await rejects(meetingRequest(f.actor,f.scope,'POST',['meetings',later.meeting.id,'end'],{forged:true}))
})
test('withdrawal persists across restoration and excludes every device without consuming another seat',async t=>{
  const f=await fixture(t),meeting=(await startMeeting(f.actor,f.scope,f.conversation.id,{id:randomUUID()})).meeting
  await assert.rejects(removeMeetingPerson(f.actor,f.scope,meeting.id,f.actor.userId),{code:'meeting_self_removal'})
  assert.equal((await rows('SELECT 1 FROM meeting_exclusions WHERE meeting_id=$1 AND user_id=$2',[meeting.id,f.actor.userId])).length,0)
  const join=()=>joinMeeting(f.peer,{deviceId:f.device.id},meeting.id,{id:randomUUID()})
  let grant=await join()
  const secondDevice=await platform.enrolDevice(f.peer,f.organisation,{installationId:randomUUID(),name:'Second fixture',platform:'windows',appVersion:'test',osVersion:'test'})
  const second=await joinMeeting(f.peer,{deviceId:secondDevice.id},meeting.id,{id:randomUUID()})
  assert.equal((await rows('SELECT count(*)::int AS n FROM seat_assignments WHERE workspace_id=$1 AND user_id=$2',[f.workspace,f.peer.userId]))[0]!.n,1)
  await platform.revokeDevice(f.actor,f.organisation,secondDevice.id);await rejects(admitMeetingConnection({token:second.token}))
  assert.equal((await admitMeetingConnection({token:grant.token})).admitted,true)
  await platform.setMemberStatus(f.actor,f.organisation,f.peer.userId,'suspended');await rejects(admitMeetingConnection({token:grant.token}))
  await platform.setMemberStatus(f.actor,f.organisation,f.peer.userId,'active');await rejects(admitMeetingConnection({token:grant.token}))
  grant=await join();await platform.releaseSeat(f.actor,f.workspace,f.peer.userId);await rejects(admitMeetingConnection({token:grant.token}))
  await platform.assignSeat(f.actor,f.workspace,f.peer.userId);await rejects(admitMeetingConnection({token:grant.token}))
  grant=await join();await getPool().query('DELETE FROM auth_session WHERE id=$1',[f.peer.sessionId]);await rejects(admitMeetingConnection({token:grant.token}))
  f.peer.sessionId=randomUUID();await getPool().query('INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 day\',now(),now())',[f.peer.sessionId,randomUUID(),f.peer.userId])
  await rejects(admitMeetingConnection({token:grant.token}));grant=await join()
  const removal=await meetingRequest(f.actor,f.scope,'DELETE',['meetings',meeting.id,'people',f.peer.userId.replace('-','%2D')],undefined)
  assert.equal(removal.userId,f.actor.userId);assert.equal(removal.targetUserId,f.peer.userId)
  await rejects(admitMeetingConnection({token:grant.token}));await rejects(join())
})
test('group removal invalidates old tokens even after rejoining, and foreign customers cannot inspect or join',async t=>{
  const f=await fixture(t),thirdId=randomUUID()
  await getPool().query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[thirdId,'Third fixture',`${thirdId}@example.invalid`])
  t.after(()=>getPool().query('DELETE FROM auth_user WHERE id=$1',[thirdId]))
  await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')",[f.workspace,f.organisation,thirdId]);await platform.assignSeat(f.actor,f.workspace,thirdId)
  let group=(await createConversation(f.actor,f.scope,{id:randomUUID(),userIds:[f.peer.userId,thirdId],title:'Meeting group fixture'})).conversation
  const meeting=(await startMeeting(f.actor,f.scope,group.id,{id:randomUUID()})).meeting,grant=await joinMeeting(f.peer,f.scope,meeting.id,{id:randomUUID()})
  group=(await updateMessageGroup(f.actor,f.scope,group.id,{revision:group.revision,title:group.title,userIds:[f.actor.userId,thirdId],ownerId:f.actor.userId})).conversation
  await rejects(admitMeetingConnection({token:grant.token}))
  group=(await updateMessageGroup(f.actor,f.scope,group.id,{revision:group.revision,title:group.title,userIds:[f.actor.userId,f.peer.userId,thirdId],ownerId:f.actor.userId})).conversation
  await rejects(admitMeetingConnection({token:grant.token}))
  assert.ok((await joinMeeting(f.peer,f.scope,meeting.id,{id:randomUUID()})).token)
  const other=await platform.createOrganisation(f.actor,f.workspace,{name:'Other fictional customer'})
  await rejects(meetingDetails(f.peer,{organisationId:other.id},meeting.id))
  await rejects(currentMeeting(f.peer,{organisationId:other.id},group.id))
  await rejects(joinMeeting(f.actor,{deviceId:f.device.id},meeting.id,{id:randomUUID()}))
  await rejects(meetingDetails({...f.peer,verified:false},f.scope,meeting.id))
})
test('media tokens fail closed on tampering, expiry, administrative grants, expired billing and recovery hold',async t=>{
  const f=await fixture(t),meeting=(await startMeeting(f.actor,f.scope,f.conversation.id,{id:randomUUID()})).meeting
  let grant=await joinMeeting(f.peer,f.scope,meeting.id,{id:randomUUID()})
  await rejects(admitMeetingConnection({token:grant.token.slice(0,-4)+'AAAA'}));await rejects(admitMeetingConnection({token:grant.token,organisationId:f.organisation}))
  assert.throws(()=>requireMeetingAdmissionKey('Bearer invalid'))
  requireMeetingAdmissionKey(`Bearer ${getConfig().SIPPER_MEETING_ADMISSION_KEY}`)
  for(const [ttl,admin,room] of [[-1,false,`sipper-${meeting.id}`],[120,true,`sipper-${meeting.id}`],[120,false,`sipper-${randomUUID()}`]] as const) {
    const token=new AccessToken(getConfig().SIPPER_MEETING_API_KEY,getConfig().SIPPER_MEETING_API_SECRET,{identity:grant.identity,ttl})
    token.addGrant({room,roomJoin:true,roomAdmin:admin});await rejects(admitMeetingConnection({token:await token.toJwt()}))
  }
  await getPool().query("UPDATE subscriptions SET paid_until=now()-interval '1 second',grace_until=NULL WHERE workspace_id=$1",[f.workspace]);await rejects(admitMeetingConnection({token:grant.token}))
  await reconcileMeetingAccess();await getPool().query("UPDATE subscriptions SET paid_until=now()+interval '1 day' WHERE workspace_id=$1",[f.workspace]);await rejects(admitMeetingConnection({token:grant.token}))
  grant=await joinMeeting(f.peer,f.scope,meeting.id,{id:randomUUID()})
  await getPool().query('UPDATE service_recovery SET restored_at=now(),released_at=NULL WHERE singleton')
  try {await rejects(admitMeetingConnection({token:grant.token}));await rejects(reconcileMeetingAccess());await rejects(runOneMeetingControl())}
  finally {await getPool().query('UPDATE service_recovery SET restored_at=NULL,released_at=NULL WHERE singleton')}
  assert.equal((await admitMeetingConnection({token:grant.token})).admitted,true)
  await getPool().query("UPDATE meetings SET expires_at=now()-interval '1 second' WHERE id=$1",[meeting.id])
  await rejects(admitMeetingConnection({token:grant.token}));await reconcileMeetingAccess()
  assert.ok((await meetingDetails(f.actor,f.scope,meeting.id)).meeting.endedAt)
})
test('server removal and end requests survive a media outage, retry and only then confirm completion',async t=>{
  const f=await fixture(t),meeting=(await startMeeting(f.actor,f.scope,f.conversation.id,{id:randomUUID()})).meeting
  const grant=await joinMeeting(f.peer,f.scope,meeting.id,{id:randomUUID()}),room=`sipper-${meeting.id}`
  mediaRooms.get(room)!.add(grant.identity)
  await leaveMeeting(f.peer,f.scope,meeting.id,grant.sessionId)
  failControl=true
  try {assert.equal(await runOneMeetingControl(),true)} finally {failControl=false}
  const queued=(await rows("SELECT * FROM jobs WHERE deduplication_key=$1",[`meeting_remove:${grant.sessionId}`]))[0]!
  assert.equal(queued.completed_at,null);assert.equal(queued.last_error,'meeting_control_failed');assert.ok(!JSON.stringify(queued).includes(grant.token))
  assert.equal((await meetingDetails(f.actor,f.scope,meeting.id)).sessions[0]!.controlConfirmedAt,null)
  await getPool().query('UPDATE jobs SET available_at=now() WHERE id=$1',[queued.id]);assert.equal(await runOneMeetingControl(),true)
  assert.ok(!mediaRooms.get(room)!.has(grant.identity));assert.ok((await meetingDetails(f.actor,f.scope,meeting.id)).sessions[0]!.controlConfirmedAt)
  await endMeeting(f.actor,f.scope,meeting.id);assert.equal((await meetingDetails(f.actor,f.scope,meeting.id)).meeting.controlConfirmedAt,null)
  while(await runOneMeetingControl()) {}
  assert.equal(mediaRooms.has(room),false);assert.ok((await meetingDetails(f.actor,f.scope,meeting.id)).meeting.controlConfirmedAt)
  assert.ok(requests.includes('RemoveParticipant'));assert.ok(requests.includes('DeleteRoom'))
})
test('management sees scoped admission history without join authority and can request an audited end with MFA',async t=>{
  const f=await fixture(t),meeting=(await startMeeting(f.peer,f.scope,f.conversation.id,{id:randomUUID()})).meeting
  const grant=await joinMeeting(f.peer,{deviceId:f.device.id},meeting.id,{id:randomUUID()});await admitMeetingConnection({token:grant.token})
  const activity=await customerMeetings(f.actor,f.organisation)
  assert.equal(activity.canEndMeetings,true);assert.equal(activity.meetings.length,1);assert.equal(activity.meetings[0]!.admittedSessions,1)
  assert.ok(!JSON.stringify(activity).includes(grant.token));assert.ok(!JSON.stringify(activity).includes('pbx.example.invalid'))
  await rejects(customerMeetings(f.peer,f.organisation));await rejects(adminEndMeeting(f.peer,f.organisation,meeting.id))
  await rejects(adminEndMeeting({...f.actor,mfa:false},f.organisation,meeting.id))
  const other=await platform.createOrganisation(f.actor,f.workspace,{name:'Other management fixture'})
  await rejects(customerMeetings(f.actor,other.id,{before:meeting.id}));await rejects(adminEndMeeting(f.actor,other.id,meeting.id))
  const end=await adminEndMeeting(f.actor,f.organisation,meeting.id);assert.ok(end.meeting.endedAt);assert.equal(end.meeting.controlConfirmedAt,null)
  assert.equal((await customerMeetings(f.actor,f.organisation)).meetings[0]!.admittedSessions,0)
  await rejects(admitMeetingConnection({token:grant.token}))
  assert.equal((await rows("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='meeting.admin_end_requested'",[meeting.id]))[0]!.n,1)
  await adminEndMeeting(f.actor,f.organisation,meeting.id)
  assert.equal((await rows("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='meeting.admin_end_requested'",[meeting.id]))[0]!.n,1)
})

test('cancelling a join while room creation is pending fences the late token and cannot revive the session',async t=>{
  const f=await fixture(t),meeting=(await startMeeting(f.actor,f.scope,f.conversation.id,{id:randomUUID()})).meeting,id=randomUUID()
  let release!:()=>void
  createHold=new Promise<void>(resolve=>{release=resolve})
  const entered=new Promise<void>(resolve=>{createEntered=resolve}),joining=joinMeeting(f.peer,f.scope,meeting.id,{id})
  try {
    await Promise.race([entered,joining.then(()=>{throw Error('Room creation was not held')})]);await leaveMeeting(f.peer,f.scope,meeting.id,id);release()
    const late=await joining
    assert.ok(Date.parse(late.expiresAt)>Date.now());await rejects(admitMeetingConnection({token:late.token}));await rejects(joinMeeting(f.peer,f.scope,meeting.id,{id}))
    const replacement=await joinMeeting(f.peer,f.scope,meeting.id,{id:randomUUID()})
    assert.equal((await admitMeetingConnection({token:replacement.token})).sessionId,replacement.sessionId)
  } finally {release();createHold=undefined;createEntered=undefined;await joining.catch(()=>{})}
})

test('the bounded participant map retains current sessions after more than 100 retired attempts',async t=>{
  const f=await fixture(t),meeting=(await startMeeting(f.actor,f.scope,f.conversation.id,{id:randomUUID()})).meeting
  await getPool().query(`INSERT INTO meeting_sessions(id,organisation_id,meeting_id,media_room,user_id,auth_session_id,expires_at,revoked_at)
    SELECT gen_random_uuid(),$1,$2,$3,$4,$5,now()+interval '1 hour',now() FROM generate_series(1,101)`,[f.organisation,meeting.id,`sipper-${meeting.id}`,f.actor.userId,f.actor.sessionId])
  const grant=await joinMeeting(f.peer,f.scope,meeting.id,{id:randomUUID()}),details=await meetingDetails(f.actor,f.scope,meeting.id)
  assert.equal(details.sessions.length,100);assert.equal(details.sessions[0]!.id,grant.sessionId)
  assert.equal(details.title,'Meeting peer fixture');assert.equal(details.canJoin,true)
})
