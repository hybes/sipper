import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { audit, lockManagedOrganisation, requireOrganisation, type Principal } from './access'
import { rows, transaction } from './db'
import { getConfig } from './config'
import { ServiceError } from './errors'

export function scimBase(organisationId:string) { return `${getConfig().SIPPER_BASE_URL}/api/scim/v2/${organisationId}` }
export function scimTokenHash(token:string) { return createHash('sha256').update(token).digest('hex') }
export async function scimSettings(actor:Principal,organisationId:string) {
  const organisation=await requireOrganisation(actor,organisationId)
  const connection=(await rows(`SELECT id,created_at,rotated_at,last_request_at,token_expires_at,
    token_hash IS NOT NULL AND token_expires_at>now() AS enabled FROM scim_connections WHERE organisation_id=$1`,[organisationId]))[0]??null
  const counts=(await rows(`SELECT count(*)::integer AS total,count(*) FILTER(WHERE user_id IS NULL)::integer AS pending
    FROM scim_users WHERE organisation_id=$1 AND deleted_at IS NULL`,[organisationId]))[0]
  return {organisation:{id:organisation.id,name:organisation.name},baseURL:scimBase(organisationId),connection,users:counts}
}
export async function rotateScimToken(actor:Principal,organisationId:string,input:unknown) {
  z.object({}).strict().parse(input)
  return transaction(async db=>{
    const organisation=await lockManagedOrganisation(actor,organisationId,db)
    const connection=(await rows(`INSERT INTO scim_connections(organisation_id) VALUES ($1)
      ON CONFLICT(organisation_id) DO UPDATE SET organisation_id=EXCLUDED.organisation_id RETURNING id`,[organisationId],db))[0]!
    const token=`sipper_scim_${connection.id}.${randomBytes(32).toString('base64url')}`
    const [record]=await rows(`UPDATE scim_connections SET token_hash=$2,token_expires_at=now()+interval '365 days',rotated_at=now()
      WHERE id=$1 RETURNING token_expires_at`,[connection.id,scimTokenHash(token)],db)
    await audit(db,actor,organisation.workspace_id,'scim.token_rotated',connection.id,organisationId)
    return {token,expiresAt:record!.token_expires_at,baseURL:scimBase(organisationId)}
  })
}
export async function revokeScimToken(actor:Principal,organisationId:string) {
  return transaction(async db=>{
    const organisation=await lockManagedOrganisation(actor,organisationId,db)
    const connection=(await rows(`UPDATE scim_connections SET token_hash=NULL,token_expires_at=NULL WHERE organisation_id=$1 AND token_hash IS NOT NULL RETURNING id`,[organisationId],db))[0]
    if(connection) await audit(db,actor,organisation.workspace_id,'scim.token_revoked',connection.id,organisationId)
    return {revoked:true}
  })
}

export async function provisionedUsers(actor:Principal,organisationId:string,input:unknown={}) {
  await requireOrganisation(actor,organisationId)
  const value=z.object({q:z.string().trim().max(160).default(''),after:z.uuid().optional()}).strict().parse(input)
  const cursor=value.after ? (await rows('SELECT email FROM scim_users WHERE organisation_id=$1 AND id=$2',[organisationId,value.after]))[0] : null
  if(value.after && !cursor) throw new ServiceError(404,'not_found','Provisioned user not found.')
  const records=await rows(`SELECT s.id,s.email,s.profile->>'displayname' AS name,s.active,s.created_at,s.updated_at,s.user_id,
    m.status AS membership_status,m.role AS membership_role,
    coalesce(m.scim_user_id=s.id AND m.role='user' AND m.status<>'removed',false) AS controls_membership,
    s.user_id IS NULL AND EXISTS(SELECT 1 FROM organisation_members pending JOIN auth_user u ON u.id=pending.user_id
      WHERE pending.organisation_id=s.organisation_id AND lower(u.email)=s.email) AS membership_conflict
    FROM scim_users s LEFT JOIN organisation_members m ON m.organisation_id=s.organisation_id AND m.user_id=s.user_id
    WHERE s.organisation_id=$1 AND s.deleted_at IS NULL AND ($2::text IS NULL OR s.email>$2)
    AND ($3='' OR strpos(lower(s.email||' '||coalesce(s.profile->>'displayname','')),lower($3))>0)
    ORDER BY s.email LIMIT 51`,[organisationId,cursor?.email??null,value.q])
  return {users:records.slice(0,50),nextCursor:records.length>50?records[49]!.id:null}
}
