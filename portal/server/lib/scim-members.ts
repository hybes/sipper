import { rows, transaction, type Database } from './db'
import { type Principal } from './access'

export async function scimAudit(db:Database, organisationId:string, action:string, targetId:string, connectionId:string) {
  await db.query(`INSERT INTO audit_events(workspace_id,organisation_id,action,target_id,details)
    SELECT workspace_id,id,$2,$3,$4 FROM organisations WHERE id=$1`,[organisationId,action,targetId,JSON.stringify({connectionId,source:'scim'})])
}

export async function bindScimMembership(db:Database,user:any,identityId:string) {
  await db.query(`INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role,status,scim_user_id)
    VALUES ($1,$2,$3,'user',$4,$5)`,[user.workspace_id,user.organisation_id,identityId,user.active?'active':'suspended',user.id])
  await db.query('UPDATE scim_users SET user_id=$2 WHERE id=$1',[user.id,identityId])
  await db.query(`INSERT INTO group_members(organisation_id,group_id,user_id)
    SELECT organisation_id,group_id,$2 FROM scim_group_members WHERE scim_user_id=$1 ON CONFLICT DO NOTHING`,[user.id,identityId])
  await scimAudit(db,user.organisation_id,'scim.user_linked',user.id,user.connection_id)
}

// Provisioning grants a customer membership, never an authentication credential.
// A new email remains pending until its owner signs in with a verified identity.
export async function claimProvisionedMemberships(actor:Principal) {
  if (!actor.verified) return
  const pending=await rows(`SELECT organisation_id FROM scim_users WHERE email=$1 AND user_id IS NULL AND active=true AND deleted_at IS NULL ORDER BY organisation_id`,[actor.email.toLowerCase()])
  for (const hint of pending) await transaction(async db=> {
    await db.query('SELECT id FROM organisations WHERE id=$1 FOR NO KEY UPDATE',[hint.organisation_id])
    const user=(await rows(`SELECT s.*,o.workspace_id FROM scim_users s JOIN organisations o ON o.id=s.organisation_id
      JOIN auth_user u ON u.id=$2 AND lower(u.email)=s.email AND u."emailVerified"=true
      WHERE s.organisation_id=$1 AND s.email=$3 AND s.user_id IS NULL AND s.active=true AND s.deleted_at IS NULL FOR UPDATE OF s`,[hint.organisation_id,actor.userId,actor.email.toLowerCase()],db))[0]
    if (!user) return
    // An invitation or manual membership created in the meantime wins. SCIM
    // cannot silently adopt it, resume a removed member or demote an admin.
    if ((await rows('SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2',[user.organisation_id,actor.userId],db)).length) return
    await bindScimMembership(db,user,actor.userId)
  })
}
