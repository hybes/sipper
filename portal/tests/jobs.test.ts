import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import { sealSecret, openSecret } from '../server/lib/crypto'
import { createWorkspace, createOrganisation, inviteMember } from '../server/lib/platform'
import { inviteWorkspaceStaff } from '../server/lib/workspace-staff'
import { failedInvitationEmails, retryInvitationEmail, serviceOverview } from '../server/lib/service-operations'
import { runOneJob, pruneInvitationEmails } from '../server/lib/jobs'
import type { Principal } from '../server/lib/access'

assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
after(async () => getPool().end())
const denied = (code: string) => (error: any) => error.code === code

async function fixture(t: any) {
  const ids = [randomUUID(),randomUUID()], jobs: string[] = []
  const actors = ids.map(id => ({ userId:id, email:`${id}@example.invalid`, verified:true, mfa:true }))
  for (const actor of actors) await getPool().query('INSERT INTO auth_user (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,true,true,now(),now())',[actor.userId,'Fictional email operator',actor.email])
  const [creator, owner] = actors as [Principal,Principal]
  await getPool().query('INSERT INTO platform_owners (user_id) VALUES ($1)',[owner.userId])
  const workspace = (await createWorkspace(creator,{name:'Example email workspace',kind:'business'})).id
  const organisation = (await createOrganisation(creator,workspace,{name:'Example email customer'})).id
  t.after(async () => {
    await getPool().query('DELETE FROM jobs WHERE id=ANY($1::uuid[])',[jobs])
    await getPool().query('DELETE FROM workspaces WHERE id=$1',[workspace])
    await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])',[ids])
  })
  async function invite(kind: 'customer' | 'workspace' = 'customer') {
    const email = `invite-${randomUUID()}@example.invalid`
    const invitation = kind === 'customer' ? await inviteMember(creator,organisation,{email,role:'user'})
      : await inviteWorkspaceStaff(creator,workspace,{email,role:'support'})
    const key = `${kind === 'customer' ? 'invitation' : 'workspace-invitation'}:${invitation.id}`
    const job = (await rows('SELECT * FROM jobs WHERE deduplication_key=$1',[key]))[0]!
    jobs.push(job.id)
    await getPool().query("UPDATE jobs SET available_at=now()-interval '10 years' WHERE id=$1",[job.id])
    return { id:invitation.id,jobId:job.id,email,key,kind, message:JSON.parse(openSecret(job.payload,`mail:${job.id}`)) }
  }
  return { creator,owner,workspace,organisation,invite,jobs }
}

test('email recovery is owner/MFA protected, preserves the original invitation and queues one audited retry under concurrency',async t => {
  const f = await fixture(t)
  for (const kind of ['customer','workspace'] as const) {
    const mail = await f.invite(kind)
    await getPool().query("UPDATE jobs SET attempts=10,last_error='delivery_failed' WHERE id=$1",[mail.jobId])
    for (const actor of [f.creator,{...f.owner,mfa:false},{...f.owner,verified:false}]) {
      const code = !actor.verified ? 'email_verification_required' : !actor.mfa ? 'mfa_required' : 'not_found'
      await assert.rejects(failedInvitationEmails(actor),denied(code))
      await assert.rejects(retryInvitationEmail(actor,mail.jobId),denied(code))
    }
    const listed = (await failedInvitationEmails(f.owner)).failures.find(job=>job.id===mail.jobId)!
    assert.equal(listed.canRetry,true); assert.equal(listed.invitation!.email,mail.email)
    assert.equal(listed.invitation!.workspaceName,'Example email workspace')
    assert.deepEqual(Object.keys(listed).sort(),['id','attempts','createdAt','lastAttemptAt','invitation','canRetry'].sort())
    for (const privateValue of [mail.message.text,'payload','deduplication_key','token_hash','delivery_failed']) assert.ok(!JSON.stringify(listed).includes(privateValue))
    assert.deepEqual(await Promise.all(Array.from({length:5},()=>retryInvitationEmail(f.owner,mail.jobId))),Array(5).fill({queued:true}))
    const queued = (await rows('SELECT * FROM jobs WHERE id=$1',[mail.jobId]))[0]!
    assert.equal(queued.attempts,0); assert.equal(queued.completed_at,null)
    assert.deepEqual(JSON.parse(openSecret(queued.payload,`mail:${mail.jobId}`)),mail.message)
    assert.equal((await rows('SELECT id FROM jobs WHERE deduplication_key=$1',[mail.key])).length,1)
    const audits = await rows("SELECT actor_id,details FROM audit_events WHERE target_id=$1 AND action='email.retry_queued'",[mail.jobId])
    assert.deepEqual(audits,[{actor_id:f.owner.userId,details:{kind}}])
    let sent: unknown[] = []
    assert.equal(await runOneJob(async (...values) => {sent=values}),true)
    assert.deepEqual(sent,[mail.email,mail.message.subject,mail.message.text])
    const completed = (await rows('SELECT * FROM jobs WHERE id=$1',[mail.jobId]))[0]!
    assert.ok(completed.completed_at); assert.ok(completed.last_attempt_at); assert.deepEqual(completed.payload,{}); assert.equal(completed.last_error,null)
    await assert.rejects(retryInvitationEmail(f.owner,mail.jobId),denied('delivery_changed'))
  }
})

test('the worker skips expired, revoked, accepted and deleted customer/staff invitations before decrypting or sending',async t => {
  const f = await fixture(t)
  for (const kind of ['customer','workspace'] as const) for (const state of ['expired','revoked','accepted','deleted']) {
    const mail = await f.invite(kind), table = kind === 'customer' ? 'invitations' : 'workspace_invitations'
    const change = state === 'deleted' ? `DELETE FROM ${table} WHERE id=$1` : `UPDATE ${table} SET ${state === 'expired' ? "expires_at=now()-interval '1 second'" : state === 'revoked' ? 'revoked_at=now()' : 'accepted_at=now()'} WHERE id=$1`
    await getPool().query(change,[mail.id])
    await getPool().query("UPDATE jobs SET payload='{}' WHERE id=$1",[mail.jobId])
    let sent=0
    assert.equal(await runOneJob(async()=>{sent++}),true); assert.equal(sent,0)
    const job=(await rows('SELECT completed_at,payload,last_error FROM jobs WHERE id=$1',[mail.jobId]))[0]!
    assert.ok(job.completed_at); assert.deepEqual(job.payload,{}); assert.equal(job.last_error,'invitation_unavailable')
  }
})

test('queued mail cannot outlive its creator’s authority or invite a suspended customer member',async t => {
  const f = await fixture(t), customer = await f.invite(), staff = await f.invite('workspace')
  await getPool().query("UPDATE workspace_members SET role='billing' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,f.creator.userId])
  for (const mail of [customer,staff]) {
    await getPool().query('UPDATE jobs SET attempts=10 WHERE id=$1',[mail.jobId])
    assert.equal((await failedInvitationEmails(f.owner)).failures.find(job=>job.id===mail.jobId)!.canRetry,false)
    await assert.rejects(retryInvitationEmail(f.owner,mail.jobId),denied('invitation_unavailable'))
    await getPool().query('UPDATE jobs SET attempts=0 WHERE id=$1',[mail.jobId])
    let sent=0; await runOneJob(async()=>{sent++}); assert.equal(sent,0)
  }
  await getPool().query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,f.creator.userId])
  const mail=await f.invite()
  await getPool().query('UPDATE auth_user SET email=$2 WHERE id=$1',[f.owner.userId,mail.email])
  await getPool().query("INSERT INTO organisation_members (workspace_id,organisation_id,user_id,role,status) VALUES ($1,$2,$3,'user','suspended')",[f.workspace,f.organisation,f.owner.userId])
  let sent=0; await runOneJob(async()=>{sent++}); assert.equal(sent,0)
  assert.equal((await rows('SELECT last_error FROM jobs WHERE id=$1',[mail.jobId]))[0]!.last_error,'invitation_unavailable')
})

test('email retry rechecks validity and processing state, and records only safe failure categories',async t => {
  const f = await fixture(t), mail = await f.invite()
  await getPool().query("UPDATE jobs SET attempts=10,locked_until=now()+interval '1 minute' WHERE id=$1",[mail.jobId])
  await assert.rejects(retryInvitationEmail(f.owner,mail.jobId),denied('delivery_processing'))
  await getPool().query('UPDATE jobs SET locked_until=NULL,attempts=9 WHERE id=$1',[mail.jobId])
  await runOneJob(async()=>{throw new Error('private-provider-credential-and-email-body')})
  const failed=(await rows('SELECT attempts,last_error,completed_at,payload,locked_until FROM jobs WHERE id=$1',[mail.jobId]))[0]!
  assert.equal(failed.attempts,10); assert.equal(failed.last_error,'delivery_failed'); assert.equal(failed.completed_at,null); assert.equal(failed.locked_until,null)
  assert.ok(!JSON.stringify(failed).includes('private-provider'))
  await getPool().query('UPDATE invitations SET revoked_at=now() WHERE id=$1',[mail.id])
  await assert.rejects(retryInvitationEmail(f.owner,mail.jobId),denied('invitation_unavailable'))
  assert.equal((await rows("SELECT 1 FROM audit_events WHERE target_id=$1 AND action='email.retry_queued'",[mail.jobId])).length,0)
  const pushId=randomUUID(); f.jobs.push(pushId)
  await getPool().query("INSERT INTO jobs (id,kind,payload) VALUES ($1,'call_push','{}')",[pushId])
  await assert.rejects(retryInvitationEmail(f.owner,pushId),denied('not_found'))
  await assert.rejects(retryInvitationEmail(f.owner,randomUUID()),denied('not_found'))
})

test('cleanup erases expired/revoked/accepted exhausted payloads while preserving active leases and valid mail',async t => {
  const f=await fixture(t), before=await serviceOverview(f.owner)
  const mails=[]
  for (const kind of ['customer','workspace'] as const) for (const state of ['expired','revoked','accepted','deleted','processing','valid']) {
    const mail=await f.invite(kind); mails.push({...mail,state})
    const table=kind==='customer'?'invitations':'workspace_invitations'
    await getPool().query('UPDATE jobs SET attempts=10 WHERE id=$1',[mail.jobId])
    if (state==='processing') await getPool().query("UPDATE jobs SET locked_until=now()+interval '2 minutes' WHERE id=$1",[mail.jobId])
    if (state==='deleted') await getPool().query(`DELETE FROM ${table} WHERE id=$1`,[mail.id])
    else if (state!=='valid') await getPool().query(`UPDATE ${table} SET ${state==='revoked'?'revoked_at=now()':state==='accepted'?'accepted_at=now()':"expires_at=now()-interval '1 second'"} WHERE id=$1`,[mail.id])
  }
  await pruneInvitationEmails()
  for(const mail of mails) {
    const job=(await rows('SELECT completed_at,payload FROM jobs WHERE id=$1',[mail.jobId]))[0]!
    if(['valid','processing'].includes(mail.state)) {assert.equal(job.completed_at,null);assert.ok(job.payload.data)}
    else {assert.ok(job.completed_at);assert.deepEqual(job.payload,{})}
  }
  const after=await serviceOverview(f.owner)
  assert.equal(after.queues.find(row=>row.kind==='email')!.skipped_24h-(before.queues.find(row=>row.kind==='email')?.skipped_24h??0),8)
})

test('failure pages are bounded, stable and secret-free even with missing or malformed invitation references',async t => {
  const f=await fixture(t)
  for(let i=0;i<53;i++) {
    const id=randomUUID();f.jobs.push(id)
    await getPool().query(`INSERT INTO jobs (id,kind,payload,deduplication_key,attempts,created_at)
      VALUES ($1,'email','{"secret":"private-queued-body"}',$2,10,CASE WHEN $3<3 THEN NULL ELSE now()+($3*interval '1 second') END)`,[id,i%2===0?`invitation:not-a-uuid-${i}`:`workspace-invitation:${randomUUID()}`,i])
  }
  const first=await failedInvitationEmails(f.owner),second=await failedInvitationEmails(f.owner,first.nextCursor!)
  assert.equal(first.failures.length,50);assert.equal(second.failures.length,3);assert.equal(second.nextCursor,null)
  assert.equal(new Set([...first.failures,...second.failures].map(job=>job.id)).size,53)
  assert.ok(second.failures.every(job=>job.createdAt===null && job.lastAttemptAt===null))
  assert.deepEqual((await failedInvitationEmails(f.owner,second.failures[0]!.id)).failures.map(job=>job.id),second.failures.slice(1).map(job=>job.id))
  assert.ok(first.failures.every(job=>!job.canRetry && job.invitation===null))
  for(const secret of ['private-queued-body','payload','deduplication_key','not-a-uuid'])assert.ok(!JSON.stringify([first,second]).includes(secret))
  await assert.rejects(failedInvitationEmails(f.owner,'not-a-uuid'))
  await assert.rejects(failedInvitationEmails(f.owner,randomUUID()),denied('not_found'))
})

test('a queued invitation email cannot deliver to a different recipient or store its provider error text',async t=>{
  const f=await fixture(t),mail=await f.invite()
  const body={...mail.message,to:'different-recipient@example.invalid'}
  const payload=sealSecret(JSON.stringify(body),`mail:${mail.jobId}`)
  await getPool().query('UPDATE jobs SET payload=$2 WHERE id=$1',[mail.jobId,JSON.stringify(payload)])
  let sent=0;await runOneJob(async()=>{sent++});assert.equal(sent,0)
  const job=(await rows('SELECT attempts,completed_at,last_error FROM jobs WHERE id=$1',[mail.jobId]))[0]!
  assert.equal(job.attempts,1);assert.equal(job.completed_at,null);assert.equal(job.last_error,'delivery_failed')
  assert.ok(!JSON.stringify(job).includes(body.to))
})
