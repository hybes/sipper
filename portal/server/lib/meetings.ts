import { randomUUID, timingSafeEqual } from 'node:crypto'
import { AccessToken, RoomServiceClient, TokenVerifier, TrackSource } from 'livekit-server-sdk'
import { z } from 'zod'
import { rows, transaction, getPool, type Database } from './db'
import { audit, requireOrganisation, lockManagedOrganisation, canAdministerOrganisation, type Principal } from './access'
import { conversationAccess, type ConversationScope } from './messages'
import { getConfig } from './config'
import { requireValue, ServiceError } from './errors'
import { meetingInput, meetingJoinInput, type Meeting, type MeetingJoin, type MeetingDetails } from '../../shared/meetings'
import type { MessageScope } from '../../shared/messages'
import { userId as routePerson } from './http'

const unavailable = () => new ServiceError(404,'meeting_unavailable','Meeting unavailable.')
export function meetingsAvailable() { return Boolean(getConfig().SIPPER_MEETING_PUBLIC_URL) }
function mediaService() {
  if (!meetingsAvailable()) throw new ServiceError(503,'meetings_not_configured','Meetings are not available yet.')
  const c=getConfig()
  return new RoomServiceClient(c.SIPPER_MEETING_INTERNAL_URL,c.SIPPER_MEETING_API_KEY,c.SIPPER_MEETING_API_SECRET,{requestTimeout:5,failover:false})
}
function describe(record:any):Meeting {
  return {id:record.id,conversationId:record.conversation_id,createdBy:record.created_by,createdAt:record.created_at.toISOString(),
    expiresAt:record.expires_at.toISOString(),endedAt:record.ended_at?.toISOString() ?? null,controlConfirmedAt:record.control_confirmed_at?.toISOString() ?? null}
}
async function participant(db:Database,bound:MessageScope,conversationId:string,lock=false) {
  return requireValue((await rows(`SELECT c.* FROM conversations c JOIN conversation_members p ON p.conversation_id=c.id AND p.user_id=$3
    WHERE c.organisation_id=$1 AND c.id=$2 FOR ${lock ? 'UPDATE' : 'SHARE'} OF c`,[bound.organisation.id,conversationId,bound.userId],db))[0])
}
async function meetingAccess(db:Database,actor:Principal,scope:ConversationScope,id:string,lock=false) {
  await recoveryAvailable(db)
  const bound=await conversationAccess(actor,scope,db)
  const initial=requireValue((await rows('SELECT conversation_id FROM meetings WHERE id=$1 AND organisation_id=$2',[id,bound.organisation.id],db))[0])
  const conversation=await participant(db,bound,initial.conversation_id)
  const meeting=requireValue((await rows(`SELECT * FROM meetings WHERE id=$1 AND organisation_id=$2 FOR ${lock ? 'UPDATE' : 'SHARE'}`,[id,bound.organisation.id],db))[0])
  return {bound,conversation,meeting}
}
async function recoveryAvailable(db:Database) {
  if((await rows('SELECT 1 FROM service_recovery WHERE singleton AND restored_at IS NOT NULL AND released_at IS NULL',[],db)).length) throw new ServiceError(503,'recovery_hold','Meetings are paused while service recovery is completed.')
}
function open(meeting:any) {if(meeting.ended_at || meeting.expires_at.getTime()<=Date.now()) throw unavailable()}
function host(actor:Principal,meeting:any) {if(meeting.created_by!==actor.userId) throw new ServiceError(403,'meeting_host_required','Only the meeting host can do this.')}
export async function currentMeeting(actor:Principal,scope:ConversationScope,conversationId:string) {
  return transaction(async db=>{
    const bound=await conversationAccess(actor,scope,db);await participant(db,bound,conversationId)
    const meeting=(await rows('SELECT * FROM meetings WHERE conversation_id=$1 AND ended_at IS NULL AND expires_at>now()',[conversationId],db))[0]
    return {...bound,available:meetingsAvailable(),meeting:meeting ? describe(meeting) : null}
  })
}
export async function startMeeting(actor:Principal,scope:ConversationScope,conversationId:string,input:unknown) {
  const {id}=meetingInput.parse(input)
  return transaction(async db=>{
    await recoveryAvailable(db)
    const bound=await conversationAccess(actor,scope,db)
    // Lock the conversation before the meeting, matching membership removal.
    await participant(db,bound,conversationId,true)
    const previous=(await rows('SELECT * FROM meetings WHERE id=$1',[id],db))[0]
    if(previous) {
      if(previous.organisation_id!==bound.organisation.id || previous.conversation_id!==conversationId || previous.created_by!==actor.userId) throw new ServiceError(409,'meeting_conflict','Start this meeting again.')
      return {...bound,available:meetingsAvailable(),meeting:describe(previous)}
    }
    await db.query('UPDATE meetings SET ended_at=now() WHERE conversation_id=$1 AND ended_at IS NULL AND expires_at<=now()',[conversationId])
    const current=(await rows('SELECT * FROM meetings WHERE conversation_id=$1 AND ended_at IS NULL',[conversationId],db))[0]
    if(current) return {...bound,available:meetingsAvailable(),meeting:describe(current)}
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`meetings:${bound.organisation.id}:${actor.userId}`])
    if((await rows("SELECT count(*)::int AS n FROM meetings WHERE organisation_id=$1 AND created_by=$2 AND created_at>now()-interval '1 hour'",[bound.organisation.id,actor.userId],db))[0]!.n>=30) throw new ServiceError(429,'meeting_rate_limit','Wait before starting another meeting.')
    const saved=(await rows('INSERT INTO meetings(id,organisation_id,conversation_id,media_room,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [id,bound.organisation.id,conversationId,`sipper-${id}`,actor.userId],db))[0]!
    const workspace=(await rows('SELECT workspace_id FROM organisations WHERE id=$1',[bound.organisation.id],db))[0]!.workspace_id
    await audit(db,actor,workspace,'meeting.started',id,bound.organisation.id)
    return {...bound,available:meetingsAvailable(),meeting:describe(saved)}
  })
}
export async function joinMeeting(actor:Principal,scope:ConversationScope,id:string,input:unknown):Promise<MeetingJoin> {
  const value=meetingJoinInput.parse(input), service=mediaService()
  const grant=await transaction(async db=>{
    const {bound,meeting}=await meetingAccess(db,actor,scope,id,true);open(meeting)
    const auth=requireValue((await rows('SELECT id,"expiresAt" FROM auth_session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now() FOR SHARE',[actor.sessionId ?? null,actor.userId],db))[0])
    if((await rows('SELECT 1 FROM meeting_exclusions WHERE meeting_id=$1 AND user_id=$2',[id,actor.userId],db)).length) throw unavailable()
    const old=(await rows('SELECT * FROM meeting_sessions WHERE id=$1 FOR UPDATE',[value.id],db))[0]
    if(old && (old.meeting_id!==id || old.user_id!==actor.userId || old.device_id!==(bound.deviceId ?? null) || old.auth_session_id!==auth.id || old.revoked_at || old.expires_at<=new Date())) throw new ServiceError(409,'meeting_session_conflict','Join this meeting again.')
    if(!old) {
      // ponytail: 100 simultaneous device sessions per room; increase the SFU
      // capacity and this bound together when larger meetings are required.
      if((await rows('SELECT count(*)::int AS n FROM meeting_sessions WHERE meeting_id=$1 AND revoked_at IS NULL AND expires_at>now()',[id],db))[0]!.n>=100) throw new ServiceError(409,'meeting_full','This meeting is full.')
      await db.query('INSERT INTO meeting_sessions(id,organisation_id,meeting_id,media_room,user_id,device_id,auth_session_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [value.id,bound.organisation.id,id,meeting.media_room,actor.userId,bound.deviceId,auth.id,meeting.expires_at])
    }
    const name=(await rows('SELECT name FROM auth_user WHERE id=$1',[actor.userId],db))[0]!.name
    const ttl=Math.min(120,Math.floor((auth.expiresAt.getTime()-Date.now())/1000),Math.floor((meeting.expires_at.getTime()-Date.now())/1000))
    if(ttl<1) throw unavailable()
    return {bound,room:meeting.media_room,name,ttl}
  })
  try {await service.createRoom({name:grant.room,emptyTimeout:300,departureTimeout:60,maxParticipants:100})}
  catch {throw new ServiceError(503,'meeting_service_unavailable','Could not reach the meeting service. Try again.')}
  const c=getConfig(), identity=`sipper:${value.id}`
  const token=new AccessToken(c.SIPPER_MEETING_API_KEY,c.SIPPER_MEETING_API_SECRET,{identity,name:grant.name,ttl:grant.ttl})
  token.addGrant({room:grant.room,roomJoin:true,canSubscribe:true,canPublish:true,canPublishSources:[TrackSource.MICROPHONE,TrackSource.CAMERA,TrackSource.SCREEN_SHARE,TrackSource.SCREEN_SHARE_AUDIO],canPublishData:false,canUpdateOwnMetadata:false})
  return {schemaVersion:1,organisationId:grant.bound.organisation.id,meetingId:id,sessionId:value.id,identity,url:c.SIPPER_MEETING_PUBLIC_URL,token:await token.toJwt(),expiresAt:new Date(Date.now()+grant.ttl*1000).toISOString()}
}
export async function endMeeting(actor:Principal,scope:ConversationScope,id:string) {
  return transaction(async db=>{
    const {bound,meeting}=await meetingAccess(db,actor,scope,id,true);host(actor,meeting)
    const saved=(await rows('UPDATE meetings SET ended_at=coalesce(ended_at,now()) WHERE id=$1 RETURNING *',[id],db))[0]!
    if(!meeting.ended_at)await meetingAudit(db,actor,bound.organisation.id,'meeting.end_requested',id)
    return {...bound,meeting:describe(saved)}
  })
}
export async function removeMeetingPerson(actor:Principal,scope:ConversationScope,id:string,userId:string) {
  return transaction(async db=>{
    const {bound,meeting}=await meetingAccess(db,actor,scope,id,true);host(actor,meeting);open(meeting)
    if(userId===actor.userId) throw new ServiceError(400,'meeting_self_removal','Leave on this device, or end the meeting for everyone.')
    await db.query('INSERT INTO meeting_exclusions(meeting_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,userId])
    await db.query('UPDATE meeting_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE meeting_id=$1 AND user_id=$2',[id,userId])
    await meetingAudit(db,actor,bound.organisation.id,'meeting.removal_requested',id,{userId})
    return {...bound,meetingId:id,targetUserId:userId,removalRequested:true}
  })
}
async function meetingAudit(db:Database,actor:Principal,organisationId:string,action:string,id:string,details:Record<string,unknown>={}) {
  const workspace=(await rows('SELECT workspace_id FROM organisations WHERE id=$1',[organisationId],db))[0]!.workspace_id
  await audit(db,actor,workspace,action,id,organisationId,details)
}
export async function customerMeetings(actor:Principal,organisationId:string,query:unknown={}) {
  const {before}=z.object({before:z.uuid().optional()}).strict().parse(query)
  const organisation=await requireOrganisation(actor,organisationId,'inspect')
  if(before && !(await rows('SELECT 1 FROM meetings WHERE id=$1 AND organisation_id=$2',[before,organisationId])).length)throw unavailable()
  const records=await rows(`SELECT m.*,u.name AS host_name,
    (SELECT count(*)::int FROM meeting_sessions s WHERE s.meeting_id=m.id AND m.ended_at IS NULL AND m.expires_at>now() AND s.admitted_at IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at>now()) AS admitted_sessions,
    (SELECT count(*)::int FROM meeting_sessions s WHERE s.meeting_id=m.id AND s.revoked_at IS NOT NULL AND s.control_confirmed_at IS NULL) AS removals_pending
    FROM meetings m LEFT JOIN auth_user u ON u.id=m.created_by WHERE m.organisation_id=$1
      AND ($2::uuid IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM meetings WHERE id=$2)) ORDER BY m.created_at DESC,m.id DESC LIMIT 51`,[organisationId,before ?? null])
  return {organisationName:organisation.name,canEndMeetings:await canAdministerOrganisation(actor.userId,organisationId),sampledAt:new Date().toISOString(),meetings:records.slice(0,50).map(row=>({...describe(row),hostName:row.host_name,admittedSessions:row.admitted_sessions,removalsPending:row.removals_pending})),nextCursor:records.length>50 ? records[49]!.id : null}
}
export async function adminEndMeeting(actor:Principal,organisationId:string,id:string) {
  return transaction(async db=>{
    await recoveryAvailable(db)
    const org=await lockManagedOrganisation(actor,organisationId,db)
    const meeting=requireValue((await rows('SELECT * FROM meetings WHERE organisation_id=$1 AND id=$2 FOR UPDATE',[organisationId,id],db))[0])
    const saved=(await rows('UPDATE meetings SET ended_at=coalesce(ended_at,now()) WHERE id=$1 RETURNING *',[id],db))[0]!
    if(!meeting.ended_at)await audit(db,actor,org.workspace_id,'meeting.admin_end_requested',id,organisationId)
    return {meeting:describe(saved)}
  })
}
export async function leaveMeeting(actor:Principal,scope:ConversationScope,id:string,sessionId:string) {
  return transaction(async db=>{
    const {bound}=await meetingAccess(db,actor,scope,id)
    requireValue((await rows('SELECT id FROM meeting_sessions WHERE id=$1 AND meeting_id=$2 AND user_id=$3 AND device_id IS NOT DISTINCT FROM $4 FOR UPDATE',[sessionId,id,actor.userId,bound.deviceId],db))[0])
    await db.query('UPDATE meeting_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1',[sessionId])
    return {...bound,meetingId:id,sessionId,leaveRequested:true}
  })
}
export async function meetingDetails(actor:Principal,scope:ConversationScope,id:string):Promise<MeetingDetails> {
  return transaction(async db=>{
    const {bound,meeting,conversation}=await meetingAccess(db,actor,scope,id)
    const sessions=await rows(`SELECT s.id,s.user_id AS "userId",u.name,s.device_id AS "deviceId",s.revoked_at AS "revokedAt",s.admitted_at AS "admittedAt",s.control_confirmed_at AS "controlConfirmedAt"
      FROM meeting_sessions s LEFT JOIN auth_user u ON u.id=s.user_id WHERE s.meeting_id=$1 ORDER BY (s.revoked_at IS NULL AND s.expires_at>now()) DESC,s.created_at DESC,s.id DESC LIMIT 100`,[id],db)
    // Admission is reported as admission, never as a connected media track.
    const hostName=(await rows('SELECT name FROM auth_user WHERE id=$1',[meeting.created_by],db))[0]?.name ?? null
    const title=conversation.kind==='group' ? conversation.title : (await rows(`SELECT u.name FROM conversation_members p JOIN auth_user u ON u.id=p.user_id
      WHERE p.conversation_id=$1 AND p.user_id<>$2 ORDER BY p.user_id LIMIT 1`,[conversation.id,actor.userId],db))[0]?.name ?? 'Conversation'
    const excluded=(await rows('SELECT 1 FROM meeting_exclusions WHERE meeting_id=$1 AND user_id=$2',[id,actor.userId],db)).length>0
    return {...bound,available:meetingsAvailable(),canJoin:meetingsAvailable() && !meeting.ended_at && meeting.expires_at>new Date() && !excluded,title,hostName,meeting:describe(meeting),sessions:sessions as MeetingDetails['sessions']}
  })
}
export function requireMeetingAdmissionKey(authorization:string|undefined) {
  const expected=Buffer.from(`Bearer ${getConfig().SIPPER_MEETING_ADMISSION_KEY}`), actual=Buffer.from(authorization ?? '')
  if(!meetingsAvailable() || expected.length!==actual.length || !timingSafeEqual(expected,actual)) throw new ServiceError(401,'invalid_service_token','Invalid service token.')
}
export async function admitMeetingConnection(input:unknown) {
  const {token}=z.object({token:z.string().min(1).max(8192)}).strict().parse(input), c=getConfig()
  if(!meetingsAvailable()) throw unavailable()
  let claims
  try {claims=await new TokenVerifier(c.SIPPER_MEETING_API_KEY,c.SIPPER_MEETING_API_SECRET).verify(token,0)} catch {throw unavailable()}
  const sessionId=z.uuid().safeParse(claims.sub?.replace(/^sipper:/,''))
  if(!sessionId.success || claims.sub!==`sipper:${sessionId.data}` || !claims.video?.roomJoin || claims.video.roomAdmin || claims.video.roomCreate || claims.video.roomList || claims.video.roomRecord || claims.video.ingressAdmin || claims.video.destinationRoom || claims.sip || claims.inference || claims.observability) throw unavailable()
  return transaction(async db=>{
    const initial=requireValue((await rows('SELECT organisation_id,user_id,device_id,meeting_id FROM meeting_sessions WHERE id=$1',[sessionId.data],db))[0])
    const user=requireValue((await rows('SELECT email,"emailVerified" FROM auth_user WHERE id=$1',[initial.user_id],db))[0])
    const actor={userId:initial.user_id,email:user.email,verified:user.emailVerified,mfa:false}
    const scope:ConversationScope=initial.device_id ? {deviceId:initial.device_id} : {organisationId:initial.organisation_id}
    const {bound}=await meetingAccess(db,actor,scope,initial.meeting_id)
    await db.query('SELECT a.id FROM auth_session a JOIN meeting_sessions s ON s.auth_session_id=a.id WHERE s.id=$1 FOR SHARE OF a',[sessionId.data])
    const session=requireValue((await rows(`SELECT s.*,m.conversation_id,m.ended_at,m.expires_at AS meeting_expires_at FROM meeting_sessions s JOIN meetings m ON m.id=s.meeting_id
      JOIN auth_session a ON a.id=s.auth_session_id AND a."userId"=s.user_id AND a."expiresAt">now()
      WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND m.ended_at IS NULL AND m.expires_at>now() FOR UPDATE OF s`,[sessionId.data],db))[0])
    if(session.media_room!==claims.video!.room || (await rows('SELECT 1 FROM meeting_exclusions WHERE meeting_id=$1 AND user_id=$2',[session.meeting_id,actor.userId],db)).length) throw unavailable()
    await db.query('UPDATE meeting_sessions SET admitted_at=now() WHERE id=$1',[session.id])
    return {admitted:true,sessionId:session.id,room:session.media_room}
  })
}
export async function meetingRequest(actor:Principal,scope:ConversationScope,method:string,parts:string[],body:unknown) {
  const id=(value:string|undefined)=>z.uuid().parse(value).toLowerCase()
  if(parts.length===3 && parts[0]==='conversations' && parts[2]==='meeting') {
    if(method==='GET') return currentMeeting(actor,scope,id(parts[1]))
    if(method==='POST') return startMeeting(actor,scope,id(parts[1]),body)
  }
  if(parts[0]==='meetings') {
    const meetingId=id(parts[1])
    if(parts.length===2 && method==='GET') return meetingDetails(actor,scope,meetingId)
    if(parts.length===3 && method==='POST') {
      if(parts[2]==='join')return joinMeeting(actor,scope,meetingId,body)
      z.object({}).strict().parse(body)
      if(parts[2]==='end')return endMeeting(actor,scope,meetingId)
    }
    if(parts.length===4 && parts[2]==='people' && method==='DELETE') return removeMeetingPerson(actor,scope,meetingId,routePerson(parts[3]))
    if(parts.length===5 && parts[2]==='sessions' && parts[4]==='leave' && method==='POST') {z.object({}).strict().parse(body);return leaveMeeting(actor,scope,meetingId,id(parts[3]))}
  }
  throw unavailable()
}

export async function reconcileMeetingAccess() {
  await recoveryAvailable(getPool())
  await rows('UPDATE meetings SET ended_at=now() WHERE ended_at IS NULL AND expires_at<=now()')
  // Existing meetings survive transient control-plane failure. Withdrawal is
  // durable; this sweep also catches subscription expiry and restored data.
  await rows(`UPDATE meeting_sessions s SET revoked_at=now() WHERE s.revoked_at IS NULL AND (
    s.expires_at<=now() OR s.auth_session_id IS NULL OR NOT EXISTS(SELECT 1 FROM auth_session a WHERE a.id=s.auth_session_id AND a."expiresAt">now())
    OR NOT EXISTS(SELECT 1 FROM auth_user u JOIN organisation_members m ON m.user_id=u.id AND m.organisation_id=s.organisation_id
      JOIN seat_assignments seat ON seat.workspace_id=m.workspace_id AND seat.user_id=m.user_id JOIN subscriptions sub ON sub.workspace_id=m.workspace_id
      WHERE u.id=s.user_id AND u."emailVerified" AND m.status='active'
      AND (sub.status IN ('active','trialing') OR (sub.status='past_due' AND sub.grace_until>now()))
      AND (sub.paid_until IS NULL OR sub.paid_until>now() OR sub.grace_until>now())
      AND (SELECT count(*) FROM seat_assignments sa WHERE sa.workspace_id=m.workspace_id)<=sub.purchased_seats))`)
  await rows(`DELETE FROM meetings WHERE id IN (SELECT id FROM meetings WHERE ended_at<=now()-($1*interval '1 day')
    AND control_confirmed_at IS NOT NULL ORDER BY ended_at LIMIT 100 FOR UPDATE SKIP LOCKED)`,[getConfig().SIPPER_MESSAGE_RETENTION_DAYS])
}
export async function runOneMeetingControl(service=mediaService()) {
  await recoveryAvailable(getPool())
  const lease=randomUUID()
  const job=(await rows(`UPDATE jobs SET locked_until=now()+interval '30 seconds',lease_id=$1,attempts=attempts+1,last_attempt_at=now() WHERE id=(
    SELECT id FROM jobs WHERE kind='meeting_control' AND completed_at IS NULL AND available_at<=now() AND (locked_until IS NULL OR locked_until<=now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[lease]))[0]
  if(!job)return false
  try {
    const payload=z.discriminatedUnion('action',[
      z.object({action:z.literal('end'),room:z.string().regex(/^sipper-[0-9a-f-]{36}$/),meetingId:z.uuid()}).strict(),
      z.object({action:z.literal('remove'),room:z.string().regex(/^sipper-[0-9a-f-]{36}$/),sessionId:z.uuid()}).strict(),
    ]).parse(job.payload)
    if(payload.action==='end') {if((await service.listRooms([payload.room])).length) await service.deleteRoom(payload.room)}
    else {
      const identity=`sipper:${payload.sessionId}`
      if((await service.listRooms([payload.room])).length && (await service.listParticipants(payload.room)).some(p=>p.identity===identity)) await service.removeParticipant(payload.room,identity)
    }
    await transaction(async db=>{
      const claimed=(await rows("UPDATE jobs SET completed_at=now(),locked_until=NULL,payload='{}',last_error=NULL WHERE id=$1 AND lease_id=$2 RETURNING id",[job.id,lease],db)).length
      if(claimed) await db.query(payload.action==='end' ? 'UPDATE meetings SET control_confirmed_at=now() WHERE id=$1' : 'UPDATE meeting_sessions SET control_confirmed_at=now() WHERE id=$1',[payload.action==='end' ? payload.meetingId : payload.sessionId])
    })
  } catch {
    await rows("UPDATE jobs SET locked_until=NULL,available_at=now()+($3*interval '1 second'),last_error='meeting_control_failed' WHERE id=$1 AND lease_id=$2",[job.id,lease,Math.min(60,2**Math.min(job.attempts,6))])
  }
  return true
}
