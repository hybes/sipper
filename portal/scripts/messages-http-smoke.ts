// Repeatable real local HTTP acceptance; optional disposable browser fixture.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { createVerifiedLocalUser, totp } from '../tests/auth-helper'
import { getConfig } from '../server/lib/config'
import { getPool } from '../server/lib/db'
import { sessionPrincipal } from '../server/lib/http'
import * as platform from '../server/lib/platform'
import { configureTestBilling } from '../server/lib/billing'

const config=getConfig()
if(config.NODE_ENV!=='development' || !['localhost','127.0.0.1'].includes(new URL(config.SIPPER_BASE_URL).hostname) || config.SIPPER_ALLOW_TEST_BILLING!=='true') throw new Error('Messaging HTTP checks require the local development portal with test billing')
const users:Awaited<ReturnType<typeof createVerifiedLocalUser>>[]=[],fixtureFile='.data/messages-ui-fixture.json'
let workspace:string|undefined
let createdFixture=false
try {
  for(const name of ['Messaging QA administrator','Alex Morgan · QA','Bea Ellis · QA'])users.push(await createVerifiedLocalUser(name))
  const [admin,alex,bea]=users
  const enabled=await admin!.client.call('/two-factor/enable',{password:admin!.password});assert.equal(enabled.status,200)
  const secret=new URL(enabled.data.totpURI).searchParams.get('secret')!
  assert.equal((await admin!.client.call('/two-factor/verify-totp',{code:totp(secret)})).status,200)
  const actor=await sessionPrincipal(admin!.client.headers())
  workspace=(await platform.createWorkspace(actor,{name:'Messaging UI QA',kind:'business'})).id
  const organisation=await platform.createOrganisation(actor,workspace,{name:'Example Studio · Messaging QA'})
  await configureTestBilling(actor,workspace,{quantity:3})
  for(const user of users) {
    await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')",[workspace,organisation.id,user.userId])
    await platform.assignSeat(actor,workspace,user.userId)
  }
  const base=`${config.SIPPER_BASE_URL}/api/platform/me/messages/${organisation.id}`
  const headers=(user:typeof admin)=>{const h=user!.client.headers();h.set('origin',new URL(config.SIPPER_BASE_URL).origin);h.set('content-type','application/json');return h}
  const call=async(user:typeof admin,path:string,method='GET',body?:unknown)=>{
    const response=await fetch(`${base}/${path}`,{method,headers:headers(user),...(body===undefined ? {} : {body:JSON.stringify(body)})})
    return {response,data:await response.json() as any}
  }
  assert.equal((await fetch(`${base}/conversations`)).status,401)
  const invalid=new Headers(headers(alex));invalid.set('origin','https://outside.example.invalid')
  assert.equal((await fetch(`${base}/conversations`,{method:'POST',headers:invalid,body:'{}'})).status,403)
  invalid.set('origin',new URL(config.SIPPER_BASE_URL).origin);invalid.set('content-type','text/plain')
  assert.equal((await fetch(`${base}/conversations`,{method:'POST',headers:invalid,body:'{}'})).status,415)
  const created=await call(admin,'conversations','POST',{id:randomUUID(),userIds:[alex!.userId]})
  assert.equal(created.response.status,200);assert.match(created.response.headers.get('cache-control')! ,/no-store/)
  const id=created.data.conversation.id,value={id:randomUUID(),text:'Welcome to the messaging check. Plain markup stays text: <b>hello</b>.'}
  const sent=await call(admin,`conversations/${id}`,'POST',value),retry=await call(admin,`conversations/${id}`,'POST',value)
  assert.equal(sent.response.status,200);assert.equal(retry.data.message.sequence,sent.data.message.sequence)
  const history=await call(alex,`conversations/${id}`)
  assert.equal(history.response.status,200);assert.equal(history.data.messages.length,1);assert.equal(history.data.messages[0].text,value.text)
  assert.equal(history.data.conversation.unread,1);assert.equal(history.data.userId,alex!.userId)
  assert.equal((await call(alex,`conversations/${id}?before=1.1`)).response.status,400)
  assert.equal((await call(bea,`conversations/${id}`)).response.status,404)
  assert.equal((await call(alex,`conversations/${id}/read`,'POST',{sequence:sent.data.message.sequence})).response.status,200)
  assert.equal((await call(alex,`conversations/${id}`)).data.conversation.unread,0)
  let group=(await call(alex,'conversations','POST',{id:randomUUID(),userIds:[admin!.userId,bea!.userId],title:'Messaging group · QA'})).data.conversation
  assert.equal(group.ownerId,alex!.userId)
  const groupPath=`conversations/${group.id}`
  const oldGroup=await call(alex,groupPath,'POST',{id:randomUUID(),text:'Before the group membership change.'})
  const edit={revision:group.revision,title:'Updated group · QA',userIds:[alex!.userId,admin!.userId],ownerId:alex!.userId}
  const changed=await call(alex,`${groupPath}/group`,'PUT',edit)
  assert.equal(changed.response.status,200);group=changed.data.conversation
  assert.equal((await call(alex,`${groupPath}/group`,'PUT',edit)).data.conversation.revision,group.revision)
  assert.equal((await call(bea,groupPath)).response.status,404)
  assert.equal((await call(admin,`${groupPath}/group`,'PUT',{...edit,revision:group.revision,title:'Not owner'})).response.status,409)
  assert.equal((await call(alex,`${groupPath}/group`,'PUT',{...edit,title:'Stale revision'})).response.status,409)
  group=(await call(alex,`${groupPath}/group`,'PUT',{...edit,revision:group.revision,userIds:[alex!.userId,admin!.userId,bea!.userId],ownerId:bea!.userId})).data.conversation
  assert.equal(group.ownerId,bea!.userId)
  assert.equal((await call(bea,groupPath)).data.messages.length,0)
  assert.equal((await call(bea,`${groupPath}?before=${oldGroup.data.message.sequence}`)).response.status,409)
  assert.equal((await call(alex,`${groupPath}/leave`,'POST',{})).response.status,200)
  assert.equal((await call(alex,`${groupPath}/leave`,'POST',{})).response.status,200)
  assert.equal((await call(alex,groupPath)).response.status,404)
  group=(await call(bea,groupPath)).data.conversation
  group=(await call(bea,`${groupPath}/group`,'PUT',{revision:group.revision,title:'Messaging group · QA',userIds:[alex!.userId,...group.participants.map((p:any)=>p.id)],ownerId:alex!.userId})).data.conversation
  assert.equal((await call(alex,groupPath)).data.messages.length,0)
  const newGroup=await call(bea,groupPath,'POST',{id:randomUUID(),text:'Group lifecycle QA. Markup stays text: <b>hello</b>.'})
  assert.equal(newGroup.response.status,200)
  assert.deepEqual((await call(alex,groupPath)).data.messages.map((m:any)=>m.id),[newGroup.data.message.id])
  console.log('PASS: Real group rename/remove/rejoin, owner enforcement, stale revision denial, exact retries, transferred ownership, idempotent leaving and post-join history.')
  console.log('PASS: Real authenticated messaging HTTP, origin/JSON/no-store guards, exact text, nonce retry, bounded sequence validation, non-participant denial and cross-session read state.')
  if(process.env.SIPPER_MESSAGE_UI_QA==='1') {
    await mkdir('.data',{recursive:true})
    await writeFile(fixtureFile,JSON.stringify({email:alex!.email,password:alex!.password,userId:alex!.userId,userIds:users.map(user=>user.userId),organisationId:organisation.id,workspaceId:workspace,conversationId:id,groupId:group.id,pid:process.pid}),{mode:0o600,flag:'wx'})
    createdFixture=true
    console.log('Disposable messaging browser fixture ready; credentials are in the private fixture file.')
    const keepAlive=setInterval(()=>{},1000)
    // Keep handlers during cleanup: package runners can forward a second signal.
    try {await new Promise<void>(resolve=>{process.on('SIGINT',()=>resolve());process.on('SIGTERM',()=>resolve())})}
    finally {clearInterval(keepAlive)}
  }
} finally {
  try {
    if(workspace) {
      await getPool().query('DELETE FROM audit_events WHERE workspace_id=$1',[workspace])
      await getPool().query('DELETE FROM workspaces WHERE id=$1',[workspace])
    }
    if(users.length)await getPool().query('DELETE FROM auth_user WHERE id=ANY($1::text[])',[users.map(user=>user.userId)])
    if(createdFixture)await unlink(fixtureFile).catch(()=>{})
  } finally {await getPool().end()}
}
