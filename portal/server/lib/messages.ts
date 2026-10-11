import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { rows, transaction, type Database } from './db'
import { requireVerified, type Principal } from './access'
import { requireLicensedMember } from './platform'
import { requireValue, ServiceError } from './errors'
import { sealSecret, openSecret } from './crypto'
import { getConfig } from './config'
import { conversationInput, groupInput, messageInput, messageSequence, type Conversation, type MessageScope, type TextMessage } from '../../shared/messages'

export type ConversationScope = { organisationId: string; deviceId?: never } | { deviceId: string; organisationId?: never }
type Scope = ConversationScope
const pageInput = z.object({ q: z.string().trim().max(160).default(''), after: z.string().max(512).optional() }).strict()
const historyInput = z.object({ before: messageSequence.optional(), after: messageSequence.optional() }).strict().refine(value => !value.before || !value.after)
const notFound = () => new ServiceError(404,'not_found','Conversation unavailable.')
const context = (org: string, conversation: string, id: string) => `message:${org}:${conversation}:${id}`
const since = () => getConfig().SIPPER_MESSAGE_RETENTION_DAYS

export async function conversationAccess(actor: Principal, scope: Scope, db: Database): Promise<MessageScope> {
  requireVerified(actor)
  const device = scope.deviceId ? requireValue((await rows('SELECT organisation_id FROM devices WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',[scope.deviceId,actor.userId],db))[0]) : null
  const orgId = device?.organisation_id ?? scope.organisationId
  const org = requireValue((await rows('SELECT id,workspace_id,name FROM organisations WHERE id=$1',[orgId],db))[0])
  // Use the existing billing/workspace and customer lock order. These shared
  // locks prevent a licence or membership write overtaking this request.
  await db.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[org.workspace_id])
  await db.query('SELECT workspace_id FROM subscriptions WHERE workspace_id=$1 FOR SHARE',[org.workspace_id])
  await db.query('SELECT id FROM organisations WHERE id=$1 FOR SHARE',[org.id])
  if (scope.deviceId && !(await rows('SELECT id FROM devices WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE',[scope.deviceId,actor.userId],db)).length) throw notFound()
  await requireLicensedMember(actor,org.id,db)
  return { schemaVersion:1,organisation:{id:org.id,name:org.name},userId:actor.userId,deviceId:scope.deviceId ?? null,
    expiresAt:new Date(Date.now()+30_000).toISOString(),retentionDays:since() }
}
const access = conversationAccess
async function eligible(db: Database, org: string, ids: string[]) {
  return rows(`SELECT m.user_id AS id,u.name FROM organisation_members m JOIN auth_user u ON u.id=m.user_id AND u."emailVerified"
    JOIN seat_assignments s ON s.workspace_id=m.workspace_id AND s.user_id=m.user_id
    WHERE m.organisation_id=$1 AND m.status='active' AND m.user_id=ANY($2::text[])`,[org,ids],db)
}
async function member(db: Database, scope: MessageScope, id: string, lock=false) {
  return requireValue((await rows(`SELECT c.*,m.joined_sequence FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id AND m.user_id=$3
    WHERE c.organisation_id=$1 AND c.id=$2 ${lock ? 'FOR UPDATE OF c' : 'FOR SHARE OF c'}`,
  [scope.organisation.id,id,scope.userId],db))[0])
}
async function describe(db: Database, scope: MessageScope, conversation: any): Promise<Conversation> {
  const participants = await rows(`SELECT m.user_id AS id,u.name,m.last_read_sequence::text AS "lastReadSequence",m.joined_sequence::text AS "joinedSequence"
    FROM conversation_members m JOIN auth_user u ON u.id=m.user_id WHERE m.conversation_id=$1 ORDER BY u.name,m.user_id`,[conversation.id],db)
  const unread = (await rows(`SELECT count(*)::int AS count FROM text_messages t JOIN conversation_members m ON m.conversation_id=t.conversation_id AND m.user_id=$2
    WHERE t.conversation_id=$1 AND t.sender_id IS DISTINCT FROM $2 AND t.sequence>GREATEST(m.last_read_sequence,m.joined_sequence)
    AND t.created_at>now()-($3*interval '1 day')`,[conversation.id,scope.userId,since()],db))[0]!.count
  return {id:conversation.id,kind:conversation.kind,title:conversation.kind==='group' ? conversation.title : participants.find(p=>p.id!==scope.userId)?.name ?? 'Former member',
    createdAt:conversation.created_at.toISOString(),updatedAt:conversation.updated_at.toISOString(),participants:participants as Conversation['participants'],unread,lastSequence:String(conversation.last_sequence),revision:String(conversation.revision),ownerId:conversation.kind==='group' ? conversation.owner_id : null}
}
function message(org: string, record: any): TextMessage {
  return {id:record.id,sequence:String(record.sequence),senderId:record.sender_id,senderName:record.sender_name ?? 'Former member',
    text:openSecret(record.envelope,context(org,record.conversation_id,record.id)),createdAt:record.created_at.toISOString()}
}
// One per-user transaction lock covers sends to different conversations too.
async function writeLock(db: Database, scope: MessageScope) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`messages:${scope.organisation.id}:${scope.userId}`])
}

export async function saveMessagePushToken(actor: Principal, deviceId: string, input: unknown) {
  const value=z.object({token:z.string().min(20).max(4096).regex(/^[a-zA-Z0-9_:-]+$/)}).strict().parse(input)
  return transaction(async db=>{
    const bound=await access(actor,{deviceId},db)
    const platform=(await rows('SELECT platform FROM devices WHERE id=$1',[deviceId],db))[0]!.platform
    if(!['ios','android'].includes(platform)) throw new ServiceError(400,'unsupported_push_platform','Message notifications are available for iOS and Android devices.')
    const provider=platform==='ios' ? 'apns' : 'fcm'
    if(provider==='apns' && (!/^[a-fA-F0-9]+$/.test(value.token) || value.token.length%2!==0 || value.token.length>512))
      throw new ServiceError(400,'invalid_push_token','The notification token is invalid.')
    const token=provider==='apns' ? value.token.toLowerCase() : value.token
    await db.query(`INSERT INTO message_push_endpoints(device_id,provider,token_envelope,token_revision) VALUES($1,$2,$3,$4)
      ON CONFLICT(device_id) DO UPDATE SET provider=$2,token_envelope=$3,token_revision=$4,updated_at=now(),disabled_at=NULL,last_push_status=NULL`,
    [deviceId,provider,sealSecret(token,`message-push:${bound.organisation.id}:${deviceId}`),randomUUID()])
    return {deviceId,registered:true,provider}
  })
}
export async function removeMessagePushToken(actor: Principal, deviceId: string) {
  requireVerified(actor)
  return transaction(async db=>{
    requireValue((await rows('SELECT id FROM devices WHERE id=$1 AND user_id=$2 FOR SHARE',[deviceId,actor.userId],db))[0])
    await db.query('DELETE FROM message_push_endpoints WHERE device_id=$1',[deviceId])
    return {deviceId,removed:true}
  })
}

// Desktop clients poll opaque unread references while running; no body is decrypted here.
export async function messageAlerts(actor: Principal, deviceId: string, query: unknown={}) {
  const value=z.object({after:messageSequence.default('0')}).strict().parse(query)
  return transaction(async db=>{
    const bound=await access(actor,{deviceId},db)
    const found=await rows(`SELECT conversation_id,sequence::text AS sequence,expires_at FROM (
      SELECT DISTINCT ON(t.conversation_id) t.conversation_id,t.sequence,t.created_at+interval '5 minutes' AS expires_at
      FROM text_messages t JOIN conversation_members m ON m.conversation_id=t.conversation_id AND m.user_id=$2
      WHERE t.organisation_id=$1 AND t.sender_id IS DISTINCT FROM $2
      AND t.sequence>GREATEST(m.last_read_sequence,m.joined_sequence,$3::bigint)
      AND t.created_at>$5::timestamptz-interval '5 minutes' AND t.created_at>now()-($4*interval '1 day')
      ORDER BY t.conversation_id,t.sequence DESC
    ) unread ORDER BY unread.sequence LIMIT 101`,[bound.organisation.id,actor.userId,value.after,since(),bound.expiresAt],db)
    const alerts=found.slice(0,100).map(row=>({conversationId:row.conversation_id,sequence:row.sequence,expiresAt:row.expires_at.toISOString()}))
    return {...bound,alerts,nextCursor:found.length>100 ? alerts.at(-1)!.sequence : null}
  })
}

export async function messagePeople(actor: Principal, scope: Scope, query: unknown={}) {
  const value=pageInput.parse(query)
  return transaction(async db=>{
    const bound=await access(actor,scope,db), pattern=`%${value.q.replace(/[\\%_]/g,'\\$&')}%`
    const people=await rows(`SELECT m.user_id AS id,u.name FROM organisation_members m JOIN auth_user u ON u.id=m.user_id AND u."emailVerified"
      JOIN seat_assignments s ON s.workspace_id=m.workspace_id AND s.user_id=m.user_id
      WHERE m.organisation_id=$1 AND m.status='active' AND m.user_id<>$2 AND ($3::text IS NULL OR m.user_id>$3)
      AND u.name ILIKE $4 ORDER BY m.user_id LIMIT 101`,[bound.organisation.id,actor.userId,value.after ?? null,pattern],db)
    return {...bound,people:people.slice(0,100),nextCursor:people.length>100 ? people[99]!.id : null}
  })
}
export async function createConversation(actor: Principal, scope: Scope, input: unknown) {
  const value=conversationInput.parse(input)
  if(value.userIds.includes(actor.userId)) throw new ServiceError(400,'invalid_recipients','Choose other people for this conversation.')
  const ids=[actor.userId,...value.userIds].sort(), kind=ids.length===2 ? 'direct' : 'group'
  const key=kind==='direct' ? createHash('sha256').update(JSON.stringify(ids)).digest('hex') : null
  return transaction(async db=>{
    const bound=await access(actor,scope,db);await writeLock(db,bound)
    if((await eligible(db,bound.organisation.id,ids)).length!==ids.length) throw new ServiceError(400,'invalid_recipients','Choose active licensed people from this customer.')
    const existing=(await rows('SELECT * FROM conversations WHERE organisation_id=$1 AND (id=$2 OR ($3::text IS NOT NULL AND direct_key=$3)) FOR UPDATE',[bound.organisation.id,value.id,key],db))[0]
    if(existing) {
      const actual=(await rows('SELECT user_id FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id',[existing.id],db)).map(row=>row.user_id)
      if(existing.kind!==kind || (kind==='direct' ? existing.direct_key!==key || actual.some(id=>!ids.includes(id)) : JSON.stringify(ids)!==JSON.stringify(actual) || existing.title!==value.title)) throw new ServiceError(409,'conversation_conflict','This conversation request has changed. Start again.')
      if(kind==='direct') {
        await db.query(`INSERT INTO conversation_members(organisation_id,conversation_id,user_id,joined_sequence,last_read_sequence)
          SELECT $1,$2,unnest($3::text[]),$4,$4 ON CONFLICT DO NOTHING`,[bound.organisation.id,existing.id,ids,existing.last_sequence])
      }
      return {...bound,conversation:await describe(db,bound,existing)}
    }
    if((await rows("SELECT count(*)::int AS count FROM conversations WHERE organisation_id=$1 AND created_by=$2 AND created_at>now()-interval '1 hour'",[bound.organisation.id,actor.userId],db))[0]!.count>=30) throw new ServiceError(429,'message_rate_limit','Wait before starting another conversation.')
    const saved=(await rows(`INSERT INTO conversations(id,organisation_id,kind,title,direct_key,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING RETURNING *`,[value.id,bound.organisation.id,kind,kind==='group' ? value.title : '',key,actor.userId],db))[0]
    // The other participant can concurrently start the same direct conversation.
    if(!saved) {
      const concurrent=(await rows('SELECT * FROM conversations WHERE organisation_id=$1 AND direct_key=$2',[bound.organisation.id,key],db))[0]
      if(!concurrent) throw new ServiceError(409,'conversation_conflict','Start this conversation again.')
      return {...bound,conversation:await describe(db,bound,concurrent)}
    }
    if(kind==='group') saved.owner_id=actor.userId
    if(kind==='group') await db.query('UPDATE conversations SET owner_id=$2 WHERE id=$1',[saved.id,actor.userId])
    await db.query('INSERT INTO conversation_members(organisation_id,conversation_id,user_id) SELECT $1,$2,unnest($3::text[])',[bound.organisation.id,saved.id,ids])
    return {...bound,conversation:await describe(db,bound,saved)}
  })
}
export async function conversations(actor: Principal, scope: Scope, query: unknown={}) {
  // ponytail: a page of 100 makes at most 200 metadata queries; batch the
  // participant/unread projections when measured polling load needs it.
  const value=pageInput.omit({q:true}).parse(query)
  let cursor: [string,string] | undefined
  if(value.after) {
    try { cursor=z.tuple([messageSequence,z.uuid()]).parse(JSON.parse(Buffer.from(value.after,'base64url').toString())) }
    catch { throw new ServiceError(400,'invalid_cursor','Refresh the conversation list.') }
  }
  return transaction(async db=>{
    const bound=await access(actor,scope,db)
    const found=await rows(`SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id AND m.user_id=$2
      WHERE c.organisation_id=$1 AND ($3::bigint IS NULL OR (c.last_sequence,c.id)<($3::bigint,$4::uuid))
      ORDER BY c.last_sequence DESC,c.id DESC LIMIT 101 FOR SHARE OF c`,[bound.organisation.id,actor.userId,cursor?.[0] ?? null,cursor?.[1] ?? null],db)
    const last=found[99]
    return {...bound,conversations:await Promise.all(found.slice(0,100).map(row=>describe(db,bound,row))),
      nextCursor:found.length>100 ? Buffer.from(JSON.stringify([String(last!.last_sequence),last!.id])).toString('base64url') : null}
  })
}
export async function conversationMessages(actor: Principal, scope: Scope, conversationId: string, query: unknown={}) {
  const value=historyInput.parse(query)
  return transaction(async db=>{
    const bound=await access(actor,scope,db), conversation=await member(db,bound,conversationId)
    if(value.before || value.after) {
      if(!(await rows('SELECT id FROM text_messages WHERE conversation_id=$1 AND sequence=$2 AND sequence>$4 AND created_at>now()-($3*interval \'1 day\')',[conversation.id,value.before ?? value.after,since(),conversation.joined_sequence],db)).length) throw new ServiceError(409,'message_page_changed','Refresh the conversation; the previous page is no longer available.')
    }
    const found=await rows(`SELECT t.*,u.name AS sender_name FROM text_messages t LEFT JOIN auth_user u ON u.id=t.sender_id
      WHERE t.conversation_id=$1 AND t.sequence>$5 AND t.created_at>now()-($2*interval '1 day')
        AND ($3::bigint IS NULL OR t.sequence<$3) AND ($4::bigint IS NULL OR t.sequence>$4)
      ORDER BY t.sequence ${value.after ? 'ASC' : 'DESC'} LIMIT 101`,[conversation.id,since(),value.before ?? null,value.after ?? null,conversation.joined_sequence],db)
    const selected=found.slice(0,100), page=value.after ? selected : selected.reverse()
    return {...bound,conversation:await describe(db,bound,conversation),messages:page.map(row=>message(bound.organisation.id,row)),
      nextCursor:found.length>100 ? String(value.after ? page.at(-1)!.sequence : page[0]!.sequence) : null}
  })
}
export async function sendMessage(actor: Principal, scope: Scope, conversationId: string, input: unknown) {
  const value=messageInput.parse(input)
  return transaction(async db=>{
    const bound=await access(actor,scope,db);await writeLock(db,bound)
    // Serialise the sequence assignment and commit per conversation, so a later
    // delivery watermark cannot skip an earlier uncommitted message.
    const conversation=await member(db,bound,conversationId,true)
    const existing=(await rows('SELECT t.*,u.name AS sender_name FROM text_messages t LEFT JOIN auth_user u ON u.id=t.sender_id WHERE t.id=$1',[value.id],db))[0]
    if(existing) {
      if(existing.conversation_id!==conversation.id || existing.sender_id!==actor.userId || BigInt(existing.sequence)<=BigInt(conversation.joined_sequence) || existing.created_at.getTime()<=Date.now()-since()*86400_000) throw new ServiceError(409,'message_conflict','Start this message again.')
      const previous=message(bound.organisation.id,existing)
      if(previous.text!==value.text) throw new ServiceError(409,'message_conflict','The pending message text has changed. Start again.')
      return {...bound,message:previous}
    }
    const recipients=(await rows('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id<>$2',[conversation.id,actor.userId],db)).map(row=>row.user_id)
    if(!(await eligible(db,bound.organisation.id,recipients)).length) throw new ServiceError(409,'recipients_unavailable','No other participant currently has access to this customer.')
    if((await rows("SELECT count(*)::int AS count FROM text_messages WHERE organisation_id=$1 AND sender_id=$2 AND created_at>now()-interval '1 minute'",[bound.organisation.id,actor.userId],db))[0]!.count>=60) throw new ServiceError(429,'message_rate_limit','Wait before sending another message.')
    const saved=(await rows(`INSERT INTO text_messages(id,organisation_id,conversation_id,sender_id,envelope) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [value.id,bound.organisation.id,conversation.id,actor.userId,JSON.stringify(sealSecret(value.text,context(bound.organisation.id,conversation.id,value.id)))],db))[0]!
    await db.query('UPDATE conversations SET last_sequence=$2,updated_at=now() WHERE id=$1',[conversation.id,saved.sequence])
    // References only; a worker rechecks membership, unread state, licence and device.
    await db.query(`INSERT INTO jobs(kind,deduplication_key,payload)
      SELECT 'message_push','message_push:'||$1::text||':'||d.device_id::text,jsonb_build_object('messageId',$1::text,'deviceId',d.device_id)
      FROM eligible_message_devices d JOIN conversation_members m ON m.conversation_id=$2 AND m.user_id=d.user_id
      JOIN message_push_endpoints e ON e.device_id=d.device_id AND e.disabled_at IS NULL
      WHERE d.organisation_id=$3 AND d.user_id<>$4 AND $5>GREATEST(m.last_read_sequence,m.joined_sequence)
      ON CONFLICT(deduplication_key) DO NOTHING`,[saved.id,conversation.id,bound.organisation.id,actor.userId,saved.sequence])
    return {...bound,message:message(bound.organisation.id,{...saved,sender_name:(await rows('SELECT name FROM auth_user WHERE id=$1',[actor.userId],db))[0]!.name})}
  })
}
export async function markConversationRead(actor: Principal, scope: Scope, conversationId: string, input: unknown) {
  const value=z.object({sequence:messageSequence}).strict().parse(input)
  return transaction(async db=>{
    const bound=await access(actor,scope,db), conversation=await member(db,bound,conversationId)
    if(!(await rows('SELECT id FROM text_messages WHERE conversation_id=$1 AND sequence=$2 AND sequence>$4 AND created_at>now()-($3*interval \'1 day\')',[conversationId,value.sequence,since(),conversation.joined_sequence],db)).length) throw new ServiceError(400,'invalid_message_sequence','Choose a message from this conversation.')
    const updated=(await rows(`UPDATE conversation_members SET last_read_sequence=GREATEST(last_read_sequence,$3)
      WHERE conversation_id=$1 AND user_id=$2 RETURNING last_read_sequence::text AS sequence`,[conversationId,actor.userId,value.sequence],db))[0]!
    return {...bound,sequence:updated.sequence}
  })
}
// Full desired state plus a revision avoids lost updates and makes an exact
// retry a no-op, including a response lost after ownership was transferred.
export async function updateMessageGroup(actor: Principal, scope: Scope, conversationId: string, input: unknown) {
  const value=groupInput.parse(input)
  return transaction(async db=>{
    const bound=await access(actor,scope,db);await writeLock(db,bound)
    const conversation=await member(db,bound,conversationId,true)
    if(conversation.kind!=='group') throw new ServiceError(400,'invalid_message_group','Only groups can be managed.')
    const actual=(await rows('SELECT user_id FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id',[conversationId],db)).map(row=>row.user_id)
    const ids=[...value.userIds].sort()
    if(conversation.title===value.title && conversation.owner_id===value.ownerId && JSON.stringify(actual)===JSON.stringify(ids))
      return {...bound,conversation:await describe(db,bound,conversation)}
    if(conversation.owner_id!==actor.userId) throw new ServiceError(409,'group_owner_required','Only the group owner can change its name or people.')
    if(String(conversation.revision)!==value.revision) throw new ServiceError(409,'conversation_conflict','The group changed. Reload it before making changes.')
    if(!ids.includes(actor.userId)) throw new ServiceError(400,'invalid_message_group','Use Leave group to remove yourself.')
    const added=ids.filter(id=>!actual.includes(id)), required=[...new Set([...added,value.ownerId])]
    if((await eligible(db,bound.organisation.id,required)).length!==required.length)
      throw new ServiceError(400,'invalid_recipients','Choose active licensed people from this customer.')
    await db.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND NOT(user_id=ANY($2::text[]))',[conversationId,ids])
    await db.query(`INSERT INTO conversation_members(organisation_id,conversation_id,user_id,joined_sequence,last_read_sequence)
      SELECT $1,$2,unnest($3::text[]),$4,$4`,[bound.organisation.id,conversationId,added,conversation.last_sequence])
    const saved=(await rows('UPDATE conversations SET title=$2,owner_id=$3,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
      [conversationId,value.title,value.ownerId],db))[0]!
    return {...bound,conversation:await describe(db,bound,saved)}
  })
}
export async function leaveMessageGroup(actor: Principal, scope: Scope, conversationId: string) {
  return transaction(async db=>{
    const bound=await access(actor,scope,db);await writeLock(db,bound)
    const conversation=(await rows(`SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id AND m.user_id=$3
      WHERE c.organisation_id=$1 AND c.id=$2 FOR UPDATE OF c`,[bound.organisation.id,conversationId,actor.userId],db))[0]
    if(conversation?.kind==='direct') throw new ServiceError(400,'invalid_message_group','One-to-one conversations cannot be left.')
    if(conversation) await db.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[conversationId,actor.userId])
    // Same answer for an already-left or unknown group: no existence oracle.
    return {...bound,conversationId,left:true}
  })
}
export async function messagingRequest(actor: Principal, scope: Scope, method: string, parts: string[], body: unknown, query: unknown={}) {
  if(scope.deviceId && parts.length===1 && parts[0]==='alerts' && method==='GET') return messageAlerts(actor,scope.deviceId,query)
  if(scope.deviceId && parts.length===1 && parts[0]==='push') {
    if(method==='PUT') return saveMessagePushToken(actor,scope.deviceId,body)
    if(method==='DELETE') return removeMessagePushToken(actor,scope.deviceId)
  }
  if(parts.length===1 && parts[0]==='people' && method==='GET') return messagePeople(actor,scope,query)
  if(parts[0]==='conversations') {
    if(parts.length===1 && method==='GET') return conversations(actor,scope,query)
    if(parts.length===1 && method==='POST') return createConversation(actor,scope,body)
    const id=z.uuid().parse(parts[1]).toLowerCase()
    if(parts.length===2 && method==='GET') return conversationMessages(actor,scope,id,query)
    if(parts.length===2 && method==='POST') return sendMessage(actor,scope,id,body)
    if(parts.length===3 && parts[2]==='group' && method==='PUT') return updateMessageGroup(actor,scope,id,body)
    if(parts.length===3 && parts[2]==='leave' && method==='POST') return leaveMessageGroup(actor,scope,id)
    if(parts.length===3 && parts[2]==='read' && method==='POST') return markConversationRead(actor,scope,id,body)
  }
  throw notFound()
}
export async function pruneMessageHistory() {
  // ponytail: 1,000 expired messages per minute; use a separate maintenance
  // worker if expired traffic exceeds this. Reads enforce expiry immediately.
  return rows(`DELETE FROM text_messages WHERE id IN (SELECT id FROM text_messages WHERE created_at<=now()-($1*interval '1 day')
    ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED) RETURNING id`,[since()])
}
