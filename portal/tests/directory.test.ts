import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool, rows } from '../server/lib/db'
import { directoryContactInput, directoryContactKey, readDirectoryCsv } from '../shared/directory'
import { saveDirectoryContact, deleteDirectoryContact, organisationDirectory, deviceDirectory, deviceDirectoryStatus, importDirectoryContacts } from '../server/lib/directory'
import * as platform from '../server/lib/platform'
import { createGroup, setGroupMembers, setGroupConfigurations } from '../server/lib/management'
import { setCallingPreference, ownCallingPreferences, reportDevice } from '../server/lib/devices'
import { gatewayHeartbeat, admitGatewayOutgoing } from '../server/lib/gateway'
import { incomingGatewayCall, gatewayCall } from '../server/lib/mobile-calls'
import { removeMember } from '../server/lib/customer-members'
import { gatewayFixture } from './gateway-fixture'

process.env.SIPPER_GATEWAY_ID=`directory-${randomUUID()}`
process.env.SIPPER_GATEWAY_PUBLIC_HOST='localhost'
after(()=>getPool().end())
const denied=(code:string)=>(error:any)=>error.code===code
const contact={name:'Reception',company:'Fictional company',numbers:[{label:'Work',number:'+1 (202) 555-0101'},{label:'Extension',number:'101'}]}

test('directory status requires voluntary sharing, a current link, active licensed peers and the exact customer/device/revision',async t=>{
  const f=await gatewayFixture(); t.after(f.cleanup)
  const colleagueId=randomUUID(), colleague={userId:colleagueId,email:`${colleagueId}@example.invalid`,verified:true,mfa:false}
  await getPool().query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[colleagueId,'Colleague fixture',colleague.email])
  t.after(()=>getPool().query('DELETE FROM auth_user WHERE id=$1',[colleagueId]))
  await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')",[f.workspace,f.organisation,colleagueId])
  await getPool().query('UPDATE subscriptions SET purchased_seats=2 WHERE workspace_id=$1',[f.workspace])
  await platform.assignSeat(f.actor,f.workspace,colleagueId)
  const member=await saveDirectoryContact(f.actor,f.organisation,null,{...contact,memberUserId:colleagueId})
  const unlinked=await saveDirectoryContact(f.actor,f.organisation,null,{...contact,name:'Unlinked'})
  const deviceId=f.devices[0]!.id, native={...f.actor,mfa:false}
  const revision=async()=>(await deviceDirectory(native,deviceId)).revision
  const status=async(ids=[member.id,unlinked.id])=>deviceDirectoryStatus(native,deviceId,{contactIds:ids,revision:await revision()})
  const unavailable={contactId:member.id,availability:null,doNotDisturb:null,activity:null}
  assert.equal((await ownCallingPreferences(colleague)).organisations[0]!.share_status,false)
  assert.deepEqual((await status()).contacts.find(c=>c.contactId===member.id),unavailable)
  for (const input of [{shareStatus:'true'},{shareStatus:true,userId:f.actor.userId}]) await assert.rejects(setCallingPreference(colleague,f.organisation,input))
  await assert.rejects(setCallingPreference({...colleague,verified:false},f.organisation,{shareStatus:true}),denied('email_verification_required'))
  await Promise.all([setCallingPreference(colleague,f.organisation,{shareStatus:true}),setCallingPreference(colleague,f.organisation,{availability:'away',doNotDisturb:true})])
  const result=await status(), expiry=Date.parse(result.expiresAt)
  assert.ok(expiry>Date.now() && expiry<=Date.now()+30_000)
  assert.equal(result.organisationId,f.organisation);assert.equal(result.deviceId,deviceId)
  assert.deepEqual(result.contacts.find(c=>c.contactId===member.id),{contactId:member.id,availability:'away',doNotDisturb:true,activity:null})
  assert.deepEqual(result.contacts.find(c=>c.contactId===unlinked.id),{contactId:unlinked.id,availability:null,doNotDisturb:null,activity:null})
  assert.ok(!JSON.stringify(result).includes(colleagueId) && !JSON.stringify(result).includes(colleague.email))
  assert.ok(!JSON.stringify(await deviceDirectory(native,deviceId)).includes('memberUserId'))
  assert.equal((await organisationDirectory(f.actor,f.organisation)).contacts.find(c=>c.id===member.id)!.memberUserId,colleagueId)
  await assert.rejects(deviceDirectoryStatus(colleague,deviceId,{contactIds:[member.id],revision:await revision()}),denied('device_unavailable'))
  await assert.rejects(deviceDirectoryStatus({...native,verified:false},deviceId,{contactIds:[member.id],revision:await revision()}),denied('email_verification_required'))
  for(const ids of [[],[member.id,member.id],Array(101).fill(member.id),[randomUUID()]]) await assert.rejects(status(ids))
  const other=await platform.createOrganisation(f.actor,f.workspace,{name:'Separate status customer'})
  await assert.rejects(saveDirectoryContact(f.actor,other.id,null,{...contact,memberUserId:colleagueId}),denied('invalid_directory_member'))
  const foreign=await saveDirectoryContact(f.actor,other.id,null,contact)
  await assert.rejects(status([foreign.id]),denied('not_found'))
  await assert.rejects(getPool().query('UPDATE directory_contacts SET member_user_id=$2 WHERE id=$1',[foreign.id,colleagueId]),e=>(e as any).code==='23503')
  const oldRevision=await revision()
  await saveDirectoryContact(f.actor,f.organisation,member.id,{...contact,revision:1}) // Older admin clients preserve the link.
  assert.equal((await organisationDirectory(f.actor,f.organisation)).contacts.find(c=>c.id===member.id)!.memberUserId,colleagueId)
  await assert.rejects(deviceDirectoryStatus(native,deviceId,{contactIds:[member.id],revision:oldRevision}),denied('directory_changed'))
  await setCallingPreference(colleague,f.organisation,{shareStatus:false})
  assert.deepEqual((await status([member.id])).contacts,[unavailable])
  await setCallingPreference(colleague,f.organisation,{shareStatus:true})
  await platform.setMemberStatus(f.actor,f.organisation,colleagueId,'suspended')
  assert.deepEqual((await status([member.id])).contacts,[unavailable])
  await platform.setMemberStatus(f.actor,f.organisation,colleagueId,'active')
  await platform.releaseSeat(f.actor,f.workspace,colleagueId)
  assert.deepEqual((await status([member.id])).contacts,[unavailable])
  await platform.assignSeat(f.actor,f.workspace,colleagueId)
  assert.equal((await status([member.id])).contacts[0]!.availability,'away')
  await platform.setMemberStatus(f.actor,f.organisation,f.actor.userId,'suspended')
  await assert.rejects(status(),denied('managed_access_unavailable'))
  await platform.setMemberStatus(f.actor,f.organisation,f.actor.userId,'active')
  await removeMember(f.actor,f.organisation,colleagueId)
  assert.deepEqual((await status([member.id])).contacts,[unavailable])
  assert.equal((await rows('SELECT share_status FROM organisation_members WHERE organisation_id=$1 AND user_id=$2',[f.organisation,colleagueId]))[0]!.share_status,false)
  await getPool().query('DELETE FROM organisation_members WHERE organisation_id=$1 AND user_id=$2',[f.organisation,colleagueId])
  assert.equal((await organisationDirectory(f.actor,f.organisation)).contacts.find(c=>c.id===member.id)!.memberUserId,null)
  await platform.revokeDevice(f.actor,f.organisation,deviceId)
  await assert.rejects(deviceDirectoryStatus(native,deviceId,{contactIds:[member.id],revision:oldRevision}),denied('device_unavailable'))
})

test('shared call activity needs separate consent and reports only fresh assigned device or gateway state',async t=>{
  const f=await gatewayFixture(); t.after(f.cleanup)
  const userId=randomUUID(), colleague={userId,email:`${userId}@example.invalid`,verified:true,mfa:false}
  await getPool().query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[userId,'Activity fixture',colleague.email])
  t.after(()=>getPool().query('DELETE FROM auth_user WHERE id=$1',[userId]))
  await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')",[f.workspace,f.organisation,userId])
  await getPool().query('UPDATE subscriptions SET purchased_seats=2 WHERE workspace_id=$1',[f.workspace]); await platform.assignSeat(f.actor,f.workspace,userId)
  const peer=await platform.enrolDevice(colleague,f.organisation,{installationId:randomUUID(),name:'Activity phone',platform:'android',appVersion:'test',osVersion:'test'})
  const linked=await saveDirectoryContact(f.actor,f.organisation,null,{...contact,memberUserId:userId})
  const own=await saveDirectoryContact(f.actor,f.organisation,null,{...contact,name:'Viewer',memberUserId:f.actor.userId})
  const revision=(await deviceDirectory(f.actor,f.devices[0]!.id)).revision
  const snapshot=()=>deviceDirectoryStatus(f.actor,f.devices[0]!.id,{revision,contactIds:[linked.id,own.id]})
  const activity=async()=>(await snapshot()).contacts.find(c=>c.contactId===linked.id)!.activity
  assert.equal((await ownCallingPreferences(colleague)).organisations[0]!.share_activity,false)
  await assert.rejects(setCallingPreference(colleague,f.organisation,{shareActivity:'true'}))
  await assert.rejects(setCallingPreference({...colleague,verified:false},f.organisation,{shareActivity:true}))
  const direct=await platform.createConfiguration(f.actor,f.organisation,{label:'Direct fixture',mode:'direct',password:'fictional-direct',settings:{username:'100',domain:'example.invalid',server:'sip.example.invalid'}})
  await platform.assignConfiguration(f.actor,f.organisation,direct.id,userId)
  async function report(counts:Record<string,number>={connected:1}) {
    const configuration=await platform.provisionDevice(colleague,peer.id)
    await reportDevice(colleague,peer.id,{appliedRevision:configuration.revision,directCalls:[{accountId:direct.id,ringing:0,dialling:0,connected:0,held:0,...counts}]})
  }
  await report(); await setCallingPreference(colleague,f.organisation,{shareStatus:true,availability:'away'})
  assert.equal(await activity(),null,'Manual preference sharing does not authorise call activity')
  await Promise.all([setCallingPreference(colleague,f.organisation,{shareActivity:true}),setCallingPreference(colleague,f.organisation,{shareStatus:false})])
  assert.equal((await snapshot()).contacts.find(c=>c.contactId===linked.id)!.availability,null)
  for (const [key,state] of [['connected','in_call'],['held','on_hold'],['ringing','ringing'],['dialling','dialling']]) {
    // Reports and their freshness checks must share the database's clock.
    if(key==='connected')t.mock.timers.enable({apis:['Date'],now:Date.now()+30_000})
    try {await report({[key!]:1})} finally {t.mock.timers.reset()}
    assert.equal((await activity())!.state,state); assert.equal((await activity())!.source,'device')
  }
  const response=JSON.stringify(await snapshot())
  for (const secret of [userId,colleague.email,peer.id,direct.id,'fictional-direct','sip.example.invalid','caller','destination','ringingCount']) assert.equal(response.includes(secret),false)
  await report({}); assert.equal(await activity(),null,'Zero counts do not establish availability')
  await report()
  await getPool().query("UPDATE devices SET status=jsonb_set(status,'{directCalls,observedAt}',to_jsonb(now()-interval '170 seconds')) WHERE id=$1",[peer.id])
  assert.ok(Date.parse((await snapshot()).expiresAt)<Date.now()+11_000,'Reading must not extend an old report')
  await getPool().query("UPDATE devices SET status=jsonb_set(status,'{directCalls,observedAt}',to_jsonb(now()+interval '1 second')) WHERE id=$1",[peer.id])
  assert.equal(await activity(),null,'Future observations are still rejected')
  await getPool().query("UPDATE devices SET status=jsonb_set(status,'{directCalls,observedAt}',to_jsonb(now()-interval '181 seconds')) WHERE id=$1",[peer.id])
  assert.equal(await activity(),null)
  await report(); await reportDevice(colleague,peer.id,{registrations:[]}); assert.equal(await activity(),null,'Unapplied settings are unconfirmed')
  await report(); await getPool().query('DELETE FROM sip_assignments WHERE configuration_id=$1 AND user_id=$2',[direct.id,userId]); assert.equal(await activity(),null)
  const group=await createGroup(f.actor,f.organisation,{name:'Activity group'})
  await setGroupMembers(f.actor,f.organisation,group.id,{userIds:[userId]}); await setGroupConfigurations(f.actor,f.organisation,group.id,{configurationIds:[direct.id]})
  assert.equal((await activity())!.state,'in_call','Current group assignment counts')
  await platform.setMemberStatus(f.actor,f.organisation,userId,'suspended'); assert.equal(await activity(),null)
  await platform.setMemberStatus(f.actor,f.organisation,userId,'active'); await platform.releaseSeat(f.actor,f.workspace,userId); assert.equal(await activity(),null)
  await platform.assignSeat(f.actor,f.workspace,userId)
  await getPool().query('UPDATE auth_user SET "emailVerified"=false WHERE id=$1',[userId]); assert.equal(await activity(),null)
  await getPool().query('UPDATE auth_user SET "emailVerified"=true WHERE id=$1',[userId])
  await setCallingPreference(colleague,f.organisation,{shareActivity:false}); assert.equal(await activity(),null)
  await setCallingPreference(colleague,f.organisation,{shareActivity:true}); await report({})
  await platform.assignConfiguration(f.actor,f.organisation,f.configuration.id,userId)
  const instanceId=randomUUID(); await gatewayHeartbeat(f.nodeId,{instanceId,ready:true})
  const cfg=await platform.provisionDevice(colleague,peer.id), gateway=cfg.accounts.find(a=>a.mode==='gateway')!
  await setCallingPreference(f.actor,f.organisation,{shareActivity:true})
  const outgoing=randomUUID(); await admitGatewayOutgoing(f.nodeId,{callId:outgoing,endpoint:gateway.settings.username,destination:'2001'})
  assert.equal((await activity())!.state,'dialling'); assert.equal((await activity())!.source,'gateway')
  assert.equal((await snapshot()).contacts.find(c=>c.contactId===own.id)!.activity,null,'Sharing an account does not attribute another member’s call')
  await gatewayCall(f.nodeId,outgoing,{event:'connected',deviceId:peer.id}); assert.equal((await activity())!.state,'in_call')
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:false}); assert.equal(await activity(),null,'Unready gateway is unconfirmed')
  await gatewayHeartbeat(f.nodeId,{instanceId,ready:true}); await gatewayCall(f.nodeId,outgoing,{event:'ended',reason:'completed'})
  const incoming=randomUUID(); await incomingGatewayCall(f.nodeId,{callId:incoming,configurationId:f.configuration.id,configurationRevision:1,caller:{name:'Not shared',number:'2002'}})
  assert.equal((await activity())!.state,'ringing')
  await gatewayCall(f.nodeId,incoming,{event:'answer',deviceId:f.devices[0]!.id}); await gatewayCall(f.nodeId,incoming,{event:'connected',deviceId:f.devices[0]!.id})
  assert.equal(await activity(),null,'Only the winning member is in the answered call')
  assert.equal((await snapshot()).contacts.find(c=>c.contactId===own.id)!.activity!.state,'in_call')
  await gatewayCall(f.nodeId,incoming,{event:'ended',reason:'completed'})
  await report(); await platform.revokeDevice(f.actor,f.organisation,peer.id); assert.equal(await activity(),null)
  await removeMember(f.actor,f.organisation,userId)
  assert.equal((await rows('SELECT share_activity FROM organisation_members WHERE organisation_id=$1 AND user_id=$2',[f.organisation,userId]))[0]!.share_activity,false)
})

test('shared contacts validate dialable numbers and reject malformed, duplicate or excessive fields',()=>{
  assert.equal(directoryContactInput.parse(contact).numbers[0]!.number,'+12025550101')
  for(const input of [
    {...contact,name:'\n'}, {...contact,company:'control\u0085text'}, {...contact,organisationId:randomUUID()},
    {...contact,numbers:[]}, {...contact,numbers:Array(6).fill({label:'Work',number:'101'})},
    {...contact,numbers:[{label:'Work',number:'101'},{label:'Mobile',number:'(101)'}]},
    ...['sip:101@pbx.example.invalid','https://example.invalid','101\r\nINVITE','＋101','1e3','+','1+2'].map(number=>({...contact,numbers:[{label:'Work',number}]})),
  ]) assert.equal(directoryContactInput.safeParse(input).success,false)
})

test('directory CSV reuses quoting and limits while preserving invalid rows for review',()=>{
  const parsed=readDirectoryCsv('\uFEFFname,company,number,label,number2,label2\r\n"Reception, desk","Example ""Ltd""",+1 (202) 555-0101,Work,101,Extension\r\nBad,,sip:101@pbx.example.invalid,,,\r\n')
  assert.equal(parsed[0]!.name,'Reception, desk'); assert.equal(parsed[0]!.company,'Example "Ltd"')
  assert.deepEqual(parsed[0]!.numbers,contact.numbers)
  assert.equal(directoryContactInput.safeParse(parsed[1]).success,false)
  assert.equal(readDirectoryCsv('number,name\n101,Reception')[0]!.numbers[0]!.label,'Work')
  const normalised=directoryContactInput.parse(contact)
  assert.equal(directoryContactKey(normalised),directoryContactKey({...normalised,numbers:[...normalised.numbers].reverse()}))
  for(const source of ['name,number,password\nDesk,101,secret','name,name,number\nA,B,101','name\nDesk','name,number\nDesk',
    'name,number\n"open,101','name,number\n"closed"oops,101','name,number\n',
    'name,number\n'+Array(101).fill('Desk,101').join('\n'),'name,number\n'+('é'.repeat(33000))+',101']) assert.throws(()=>readDirectoryCsv(source))
  assert.equal(readDirectoryCsv('name,number\n'+Array(100).fill('Desk,101').join('\n')).length,100)
})

test('directory imports validate each row, skip normalised duplicates and serialise retries without exposing contact data',async t=>{
  const f=await gatewayFixture(); t.after(f.cleanup)
  const existing=await saveDirectoryContact(f.actor,f.organisation,null,contact)
  const before=await organisationDirectory(f.actor,f.organisation)
  const fresh={...contact,name:'Shared support'}, invalid={...contact,name:'Invalid row',numbers:[{label:'Work',number:'sip:101@private.invalid'}]}
  const entries=[contact,fresh,{...fresh,numbers:[{label:'Extension',number:'(101)'},{label:'Work',number:'+12025550101'}]},invalid]
  await assert.rejects(importDirectoryContacts({...f.actor,mfa:false},f.organisation,{entries}),denied('mfa_required'))
  await assert.rejects(importDirectoryContacts({...f.actor,verified:false},f.organisation,{entries}),denied('email_verification_required'))
  await assert.rejects(importDirectoryContacts({...f.actor,userId:randomUUID()},f.organisation,{entries}),denied('not_found'))
  await assert.rejects(importDirectoryContacts(f.actor,f.organisation,{entries:Array(101).fill(fresh)}))
  const result=await importDirectoryContacts(f.actor,f.organisation,{entries})
  assert.deepEqual(result.results.map(row=>row.status),['skipped','imported','skipped','invalid'])
  assert.deepEqual(result.results.map(row=>row.index),[0,1,2,3])
  const afterImport=await organisationDirectory(f.actor,f.organisation)
  assert.notEqual(afterImport.revision,before.revision); assert.equal(afterImport.contacts.length,2)
  assert.equal(afterImport.contacts.find(row=>row.id===existing.id)!.revision,1)
  assert.equal((await deviceDirectory({...f.actor,mfa:false},f.devices[0]!.id)).contacts.find(row=>row.name===fresh.name)!.numbers[0]!.number,'+12025550101')
  const retry=await importDirectoryContacts(f.actor,f.organisation,{entries})
  assert.deepEqual(retry.results.map(row=>row.status),['skipped','skipped','skipped','invalid'])
  assert.equal((await organisationDirectory(f.actor,f.organisation)).revision,afterImport.revision)
  const simultaneous=await Promise.all([1,2].map(()=>importDirectoryContacts(f.actor,f.organisation,{entries:[{...contact,name:'Concurrent import'}]})))
  assert.deepEqual(simultaneous.flatMap(result=>result.results.map(row=>row.status)).sort(),['imported','skipped'])
  const other=await platform.createOrganisation(f.actor,f.workspace,{name:'Separate directory'})
  assert.equal((await importDirectoryContacts(f.actor,other.id,{entries:[contact]})).results[0]!.status,'imported')
  const rejected=await importDirectoryContacts(f.actor,f.organisation,{entries:[{...contact,organisationId:other.id}]})
  assert.equal(rejected.results[0]!.status,'invalid')
  const audit=await rows("SELECT details FROM audit_events WHERE organisation_id=$1 AND action='directory.imported' ORDER BY id",[f.organisation])
  assert.deepEqual(audit.map(row=>row.details),[{imported:1,skipped:2,invalid:1},{imported:1,skipped:0,invalid:0}])
  assert.ok(!JSON.stringify(result).includes(fresh.name)); assert.ok(!JSON.stringify(audit).includes(contact.numbers[0]!.number))
  assert.equal((await rows('SELECT revision FROM sip_configurations WHERE id=$1',[f.configuration.id]))[0]!.revision,1)
})

test('directory paging, concurrent edits, audit privacy and client access follow organisation and licence boundaries',async t=>{
  const f=await gatewayFixture(); t.after(f.cleanup)
  const adminId=randomUUID(), admin={userId:adminId,email:`${adminId}@example.invalid`,verified:true,mfa:true}
  await getPool().query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[adminId,'Directory administrator',admin.email])
  t.after(()=>getPool().query('DELETE FROM auth_user WHERE id=$1',[adminId]))
  await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'admin')",[f.workspace,f.organisation,adminId])
  const other=(await platform.createOrganisation(f.actor,f.workspace,{name:'Other directory'})).id
  const foreign=await saveDirectoryContact(f.actor,other,null,{...contact,name:'Other customer only'})
  await assert.rejects(organisationDirectory(admin,other),denied('not_found'))
  await assert.rejects(saveDirectoryContact({...admin,mfa:false},f.organisation,null,contact),denied('mfa_required'))
  await assert.rejects(organisationDirectory({...admin,verified:false},f.organisation),denied('email_verification_required'))
  assert.equal((await organisationDirectory(admin,f.organisation)).contacts.length,0)
  const saved=await saveDirectoryContact(admin,f.organisation,null,contact)
  const original=await organisationDirectory(admin,f.organisation)
  assert.equal(original.contacts[0]!.numbers[0]!.number,'+12025550101')
  assert.deepEqual(Object.keys(original.contacts[0]!).sort(),['company','id','memberUserId','name','numbers','revision','updatedAt'])
  assert.equal((await organisationDirectory(admin,f.organisation,{q:'(202) 555-0101'})).contacts[0]!.id,saved.id)
  await saveDirectoryContact(admin,f.organisation,null,{...contact,name:'10% Support'})
  assert.equal((await organisationDirectory(admin,f.organisation,{q:'%'})).contacts.length,1)
  assert.equal((await organisationDirectory(admin,f.organisation,{q:'_'})).contacts.length,0)
  const edits=await Promise.allSettled(['Updated A','Updated B'].map(name=>saveDirectoryContact(admin,f.organisation,saved.id,{...contact,name,revision:1})))
  assert.equal(edits.filter(result=>result.status==='fulfilled').length,1)
  assert.equal(edits.filter(result=>result.status==='rejected' && result.reason.code==='directory_changed').length,1)
  await assert.rejects(deleteDirectoryContact(admin,f.organisation,saved.id,1),denied('directory_changed'))
  await assert.rejects(saveDirectoryContact(admin,f.organisation,foreign.id,{...contact,revision:1}),denied('not_found'))
  await assert.rejects(deleteDirectoryContact(admin,f.organisation,foreign.id,1),denied('not_found'))
  // Repeated names force pagination to use the UUID tie-break as well as name.
  await getPool().query(`INSERT INTO directory_contacts(organisation_id,name,numbers)
    SELECT $1,'Person','[{"label":"Work","number":"101"}]'::jsonb FROM generate_series(1,101)`,[f.organisation])
  await getPool().query('UPDATE organisations SET directory_revision=gen_random_uuid() WHERE id=$1',[f.organisation])
  const first=await organisationDirectory(admin,f.organisation)
  assert.equal(first.contacts.length,100); assert.ok(first.nextCursor)
  const second=await organisationDirectory(admin,f.organisation,{after:first.nextCursor,revision:first.revision})
  assert.equal(second.contacts.length,3); assert.equal(second.nextCursor,null)
  assert.equal(new Set([...first.contacts,...second.contacts].map(item=>item.id)).size,103)
  await assert.rejects(organisationDirectory(admin,f.organisation,{after:first.nextCursor}))
  await assert.rejects(organisationDirectory(admin,f.organisation,{after:foreign.id,revision:first.revision}),denied('not_found'))
  await deleteDirectoryContact(admin,f.organisation,saved.id,2)
  await assert.rejects(organisationDirectory(admin,f.organisation,{after:first.nextCursor,revision:first.revision}),denied('directory_changed'))
  const native={...f.actor,mfa:false}, deviceId=f.devices[0]!.id
  const page=await deviceDirectory(native,deviceId)
  assert.equal(page.deviceId,deviceId); assert.equal(page.organisation.id,f.organisation)
  assert.ok(Date.parse(page.expiresAt)>Date.now() && Date.parse(page.expiresAt)<=Date.now()+86400_000)
  assert.ok(!JSON.stringify(page).includes('Other customer only'))
  await assert.rejects(deviceDirectory(admin,deviceId),denied('device_unavailable'))
  await assert.rejects(deviceDirectory({...native,verified:false},deviceId),denied('email_verification_required'))
  await platform.setMemberStatus(f.actor,f.organisation,f.actor.userId,'suspended')
  await assert.rejects(deviceDirectory(native,deviceId),denied('managed_access_unavailable'))
  await platform.setMemberStatus(f.actor,f.organisation,f.actor.userId,'active')
  await platform.releaseSeat(f.actor,f.workspace,f.actor.userId)
  await assert.rejects(deviceDirectory(native,deviceId),denied('managed_access_unavailable'))
  await platform.assignSeat(f.actor,f.workspace,f.actor.userId)
  await platform.revokeDevice(f.actor,f.organisation,deviceId)
  await assert.rejects(deviceDirectory(native,deviceId),denied('device_unavailable'))
  const audit=await rows("SELECT details FROM audit_events WHERE organisation_id=$1 AND action LIKE 'directory_contact.%'",[f.organisation])
  assert.ok(audit.length>=4); assert.ok(audit.every(item=>JSON.stringify(item.details)==='{}'))
  assert.equal((await rows('SELECT revision FROM sip_configurations WHERE id=$1',[f.configuration.id]))[0]!.revision,1)
})
