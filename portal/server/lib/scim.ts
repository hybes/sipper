import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { rows, transaction, type Database } from './db'
import { removeCustomerAccess, revokeMemberInvitations } from './customer-members'
import { bindScimMembership, scimAudit } from './scim-members'
import { scimBase, scimTokenHash } from './scim-settings'
import { SCIM, ScimError, patchResource, resourceInput, scimAttributes, scimGroupInput, scimListQuery, scimProjection, scimSchemas, scimUserInput } from './scim-protocol'

type Kind='Users'|'Groups'
type Reply={status:number;body?:any;etag?:string;location?:string}
interface ScimConnection {id:string;organisation_id:string;tokenHash:string}
const denied=()=>new ScimError(401,undefined,'A valid customer provisioning token is required.')
const missing=()=>new ScimError(404,undefined,'Resource not found.')
const conflict=()=>new ScimError(409,'uniqueness','This user, group or external ID already exists, or belongs to a manually managed membership.')
const etag=(row:any)=>`W/"${row.version}"`
function precondition(row:any,match?:string) {
  if(match && match!=='*' && match!==etag(row)) throw new ScimError(412,undefined,'The resource changed. Retrieve its current version before updating it.')
}
async function resource(db:Database,organisationId:string,kind:Kind,id:string) {
  if(!z.uuid().safeParse(id).success) throw missing()
  const [value]=await rows(kind==='Users'
    ? 'SELECT s.*,o.workspace_id FROM scim_users s JOIN organisations o ON o.id=s.organisation_id WHERE s.organisation_id=$1 AND s.id=$2 AND s.deleted_at IS NULL'
    : 'SELECT s.*,g.name FROM scim_groups s JOIN groups g ON g.id=s.id AND g.organisation_id=s.organisation_id WHERE s.organisation_id=$1 AND s.id=$2',[organisationId,id],db)
  if(!value) throw missing()
  return value
}
async function representation(db:Database,kind:Kind,row:any) {
  const meta={resourceType:kind==='Users'?'User':'Group',created:new Date(row.created_at).toISOString(),lastModified:new Date(row.updated_at).toISOString(),version:etag(row),location:`${scimBase(row.organisation_id)}/${kind}/${row.id}`}
  if(kind==='Groups') {
    const members=await rows('SELECT scim_user_id FROM scim_group_members WHERE group_id=$1 ORDER BY scim_user_id',[row.id],db)
    return {schemas:[SCIM.Group],id:row.id,...(row.external_id?{externalId:row.external_id}:{}),displayName:row.name,
      members:members.map(item=>({value:item.scim_user_id,$ref:`${scimBase(row.organisation_id)}/Users/${item.scim_user_id}`})),meta}
  }
  const p=row.profile
  return {schemas:[SCIM.User],id:row.id,...(row.external_id?{externalId:row.external_id}:{}),userName:row.email,active:row.active,displayName:p.displayname,
    name:{...(p.name.givenname!==undefined?{givenName:p.name.givenname}:{}),...(p.name.familyname!==undefined?{familyName:p.name.familyname}:{}),...(p.name.formatted!==undefined?{formatted:p.name.formatted}:{})},emails:p.emails,meta}
}
async function ownedMembership(db:Database,row:any) {
  if(!row.user_id) return null
  const [member]=await rows('SELECT * FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 FOR UPDATE',[row.organisation_id,row.user_id],db)
  if(!member || member.scim_user_id!==row.id || member.role!=='user' || member.status==='removed') throw new ScimError(403,undefined,'This membership is now controlled by a Sipper administrator. Provisioning cannot change it.')
  return member
}
async function bindExistingIdentity(db:Database,row:any) {
  if(row.user_id) return
  const [identity]=await rows('SELECT id FROM auth_user WHERE lower(email)=$1 AND "emailVerified"=true',[row.email],db)
  if(!identity) return
  const [member]=await rows('SELECT * FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 FOR UPDATE',[row.organisation_id,identity.id],db)
  if(member) {
    const previous=(await rows('SELECT removed_membership,deleted_at FROM scim_users WHERE id=$1',[member.scim_user_id],db))[0]
    if(member.status!=='removed' || !previous?.removed_membership || !previous.deleted_at) throw conflict()
    await db.query(`UPDATE organisation_members SET role='user',status=$3,removed_at=NULL,joined_at=now(),scim_user_id=$4 WHERE organisation_id=$1 AND user_id=$2`,[row.organisation_id,identity.id,row.active?'active':'suspended',row.id])
    await db.query('UPDATE scim_users SET user_id=$2 WHERE id=$1',[row.id,identity.id])
    await scimAudit(db,row.organisation_id,'scim.user_linked',row.id,row.connection_id)
  } else await bindScimMembership(db,row,identity.id)
}
async function saveUser(db:Database,connection:any,existing:any|undefined,body:unknown) {
  const input=scimUserInput.parse(resourceInput('Users',body))
  if(existing && input.username!==existing.email) throw new ScimError(400,'mutability','The sign-in email is fixed. Migrate the identity through a Sipper administrator.')
  if(existing) await ownedMembership(db,existing)
  if(existing && isDeepStrictEqual(input,scimUserInput.parse(scimAttributes(await representation(db,'Users',existing))))) {
    await bindExistingIdentity(db,existing)
    return resource(db,connection.organisation_id,'Users',existing.id)
  }
  const id=existing?.id??randomUUID(),profile=JSON.stringify({displayname:input.displayname,name:input.name,emails:input.emails})
  if(existing) {
    await db.query(`UPDATE scim_users SET external_id=$2,active=$3,profile=$4,updated_at=now(),version=version+1 WHERE id=$1`,[id,input.externalid??null,input.active,profile])
    if(existing.user_id) {
      await db.query('UPDATE organisation_members SET status=$3 WHERE organisation_id=$1 AND user_id=$2',[connection.organisation_id,existing.user_id,input.active?'active':'suspended'])
      if(!input.active) await revokeMemberInvitations(db,connection.organisation_id,existing.user_id,existing.email,false)
    }
  } else await db.query(`INSERT INTO scim_users(id,organisation_id,connection_id,email,external_id,profile,active) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,connection.organisation_id,connection.id,input.username,input.externalid??null,profile,input.active])
  const current=await resource(db,connection.organisation_id,'Users',id)
  await bindExistingIdentity(db,current)
  await scimAudit(db,connection.organisation_id,existing?'scim.user_updated':'scim.user_created',id,connection.id)
  return resource(db,connection.organisation_id,'Users',id)
}
async function saveGroup(db:Database,connection:any,existing:any|undefined,body:unknown) {
  const input=scimGroupInput.parse(resourceInput('Groups',body)),id=existing?.id??randomUUID()
  const ids=[...new Set(input.members.map(item=>item.value))]
  const members=await rows('SELECT id,user_id FROM scim_users WHERE organisation_id=$1 AND connection_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL',[connection.organisation_id,connection.id,ids],db)
  if(members.length!==ids.length) throw new ScimError(400,'invalidValue','Every member must be a current User from this provisioning connection.')
  if(existing && existing.name===input.displayname && existing.external_id===(input.externalid??null)) {
    const previous=await rows('SELECT scim_user_id FROM scim_group_members WHERE group_id=$1 ORDER BY scim_user_id',[id],db)
    if(isDeepStrictEqual(previous.map(row=>row.scim_user_id),[...ids].sort())) return existing
  }
  if(existing) {
    await db.query('UPDATE groups SET name=$2 WHERE id=$1',[id,input.displayname])
    await db.query('UPDATE scim_groups SET external_id=$2,version=version+1,updated_at=now() WHERE id=$1',[id,input.externalid??null])
  } else {
    await db.query('INSERT INTO groups(id,organisation_id,name) VALUES ($1,$2,$3)',[id,connection.organisation_id,input.displayname])
    await db.query('INSERT INTO scim_groups(id,organisation_id,connection_id,external_id) VALUES ($1,$2,$3,$4)',[id,connection.organisation_id,connection.id,input.externalid??null])
  }
  await db.query('DELETE FROM scim_group_members WHERE group_id=$1',[id])
  await db.query('INSERT INTO scim_group_members(organisation_id,group_id,scim_user_id) SELECT $1,$2,unnest($3::uuid[])',[connection.organisation_id,id,ids])
  await db.query('DELETE FROM group_members WHERE group_id=$1',[id])
  await db.query(`INSERT INTO group_members(organisation_id,group_id,user_id)
    SELECT s.organisation_id,$2,s.user_id FROM scim_users s JOIN organisation_members m ON m.organisation_id=s.organisation_id AND m.user_id=s.user_id
    WHERE s.organisation_id=$1 AND s.id=ANY($3::uuid[]) AND m.scim_user_id=s.id AND m.status<>'removed' AND m.role='user'`,[connection.organisation_id,id,ids])
  await scimAudit(db,connection.organisation_id,existing?'scim.group_updated':'scim.group_created',id,connection.id)
  return resource(db,connection.organisation_id,'Groups',id)
}
async function deleteResource(db:Database,connection:any,kind:Kind,row:any) {
  if(kind==='Users') {
    const member=await ownedMembership(db,row)
    if(member) await removeCustomerAccess(db,row.organisation_id,row.user_id,row.email)
    // Groups survive user removal, with a new version for their changed membership.
    await db.query(`UPDATE scim_groups SET version=version+1,updated_at=now() WHERE id IN (SELECT group_id FROM scim_group_members WHERE scim_user_id=$1)`,[row.id])
    await db.query('DELETE FROM scim_group_members WHERE scim_user_id=$1',[row.id])
    await db.query('UPDATE scim_users SET deleted_at=now(),active=false,removed_membership=$2,version=version+1,updated_at=now() WHERE id=$1',[row.id,Boolean(member)])
  } else await db.query('DELETE FROM groups WHERE organisation_id=$1 AND id=$2',[row.organisation_id,row.id])
  await scimAudit(db,row.organisation_id,kind==='Users'?'scim.user_deleted':'scim.group_deleted',row.id,connection.id)
}

export async function authenticateScim(organisationId:string,authorization:string|undefined):Promise<ScimConnection> {
  const match=/^Bearer (sipper_scim_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/i.exec(authorization??'')
  if(!z.uuid().safeParse(organisationId).success || !match || !z.uuid().safeParse(match[2]).success) throw denied()
  const tokenHash=scimTokenHash(match[1]!)
  const [connection]=await rows(`UPDATE scim_connections SET last_request_at=now(),
    request_count=CASE WHEN request_window_at<=now()-interval '1 minute' THEN 1 ELSE request_count+1 END,
    request_window_at=CASE WHEN request_window_at<=now()-interval '1 minute' THEN now() ELSE request_window_at END
    WHERE id=$1 AND organisation_id=$2 AND token_hash=$3 AND token_expires_at>now()
    AND (request_window_at<=now()-interval '1 minute' OR request_count<600) RETURNING id,organisation_id`,[match[2],organisationId,tokenHash])
  if(!connection) {
    if((await rows('SELECT 1 FROM scim_connections WHERE id=$1 AND organisation_id=$2 AND token_hash=$3 AND token_expires_at>now()',[match[2],organisationId,tokenHash])).length) throw new ScimError(429,undefined,'Provisioning rate limit reached. Retry after one minute.')
    throw denied()
  }
  return {id:connection.id,organisation_id:connection.organisation_id,tokenHash}
}

export async function scimRequest(connection:Awaited<ReturnType<typeof authenticateScim>>,method:string,path:string[],query:unknown={},body?:unknown,ifMatch?:string):Promise<Reply> {
  try { return await transaction(async db=>{
    // ponytail: serialise provisioning per customer using its existing lock;
    // split resource locks only if measured provisioning throughput requires it.
    await db.query('SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE',[connection.organisation_id])
    if(!(await rows('SELECT id FROM scim_connections WHERE id=$1 AND organisation_id=$2 AND token_hash=$3 AND token_expires_at>now() FOR SHARE',[connection.id,connection.organisation_id,connection.tokenHash],db)).length) throw denied()
    const endpoint=path[0]
    if(method==='GET' && endpoint==='Schemas' && path.length<=2) {
      const schemas=scimSchemas()
      if(path[1]) {const value=schemas.find(item=>item.id===path[1]);if(!value)throw missing();return {status:200,body:value}}
      return {status:200,body:{schemas:[SCIM.List],totalResults:schemas.length,itemsPerPage:schemas.length,startIndex:1,Resources:schemas}}
    }
    if(method==='GET' && endpoint==='ServiceProviderConfig' && path.length===1) return {status:200,body:{schemas:['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],patch:{supported:true},bulk:{supported:false,maxOperations:0,maxPayloadSize:0},filter:{supported:true,maxResults:100},changePassword:{supported:false},sort:{supported:false},etag:{supported:true},authenticationSchemes:[{type:'oauthbearertoken',name:'Customer provisioning token',description:'Customer-scoped bearer token issued by a Sipper administrator.',primary:true}]}}
    if(method==='GET' && endpoint==='ResourceTypes' && path.length<=2) {
      const types=(['User','Group'] as const).map(name=>({schemas:['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],id:name,name,endpoint:`/${name}s`,schema:SCIM[name],schemaExtensions:[]}))
      if(path[1]) { const value=types.find(item=>item.id===path[1]);if(!value)throw missing();return {status:200,body:value} }
      return {status:200,body:{schemas:[SCIM.List],totalResults:types.length,itemsPerPage:types.length,startIndex:1,Resources:types}}
    }
    if(endpoint!=='Users' && endpoint!=='Groups') throw missing()
    const kind:Kind=endpoint
    if((method==='GET' && path.length===1) || (method==='POST' && path.length===2 && path[1]==='.search')) {
      let input=query
      if(method==='POST') {
        const {schemas,attributes,excludedAttributes,...search}=z.object({schemas:z.array(z.string()).refine(value=>value.includes(SCIM.Search)),attributes:z.array(z.string()).optional(),excludedAttributes:z.array(z.string()).optional()}).passthrough().parse(body)
        input={...search,...(attributes?{attributes:attributes.join(',')}:{}),...(excludedAttributes?{excludedAttributes:excludedAttributes.join(',')}:{})}
      }
      const value=scimListQuery(input,kind),where=`s.organisation_id=$1 ${kind==='Users'?'AND s.deleted_at IS NULL':''} ${value.filter?`AND ${value.filter.column} ${value.filter.column==='s.external_id'?'=':'ILIKE'} $2`:''}`
      const from=kind==='Users'?'scim_users s':'scim_groups s JOIN groups g ON g.id=s.id AND g.organisation_id=s.organisation_id'
      // Equality remains literal; SQL wildcard characters are never interpreted.
      const filterValue=value.filter && value.filter.column!=='s.external_id' ? value.filter.value.replace(/[\\%_]/g,'\\$&') : value.filter?.value
      const params:unknown[]=[connection.organisation_id,...(value.filter?[filterValue]:[])]
      const total=Number((await rows(`SELECT count(*) AS count FROM ${from} WHERE ${where}`,params,db))[0]!.count)
      const found=await rows(`SELECT s.id FROM ${from} WHERE ${where} ORDER BY s.created_at,s.id LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,value.count,value.startIndex-1],db)
      const resources=[]
      for(const item of found) resources.push(scimProjection(await representation(db,kind,await resource(db,connection.organisation_id,kind,item.id)),value.attributes,value.excludedAttributes))
      return {status:200,body:{schemas:[SCIM.List],totalResults:total,startIndex:value.startIndex,itemsPerPage:resources.length,Resources:resources}}
    }
    if(method==='POST' && path.length===1) {
      const created=await (kind==='Users'?saveUser:saveGroup)(db,connection,undefined,body)
      const result=await representation(db,kind,created)
      return {status:201,body:result,etag:etag(created),location:result.meta.location}
    }
    if(path.length!==2) throw missing()
    const existing=await resource(db,connection.organisation_id,kind,path[1]!)
    if(method==='GET') {
      const value=scimListQuery(query,kind)
      return {status:200,body:scimProjection(await representation(db,kind,existing),value.attributes,value.excludedAttributes),etag:etag(existing)}
    }
    precondition(existing,ifMatch)
    if(method==='DELETE') { await deleteResource(db,connection,kind,existing);return {status:204} }
    if(method!=='PUT' && method!=='PATCH') throw new ScimError(405,undefined,'This method is not supported.')
    const value=method==='PATCH'?patchResource(kind,scimAttributes(await representation(db,kind,existing)),body):body
    const updated=await (kind==='Users'?saveUser:saveGroup)(db,connection,existing,value)
    return {status:200,body:await representation(db,kind,updated),etag:etag(updated)}
  }) } catch(error) {
    if((error as {code?:string}).code==='23505') throw conflict()
    throw error
  }
}
