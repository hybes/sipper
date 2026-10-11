// Real strict single-contact and multiple-contact PBX behaviour, not a live provider.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import tls from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'
import type { Ari } from '../../gateway/src/ari.mjs'
import type { Calls } from '../../gateway/src/calls.mjs'
import type { Upstreams } from '../../gateway/src/upstreams.mjs'
import type { gatewayFixture } from '../tests/gateway-fixture'
import { gatewayUpstreams } from '../server/lib/gateway'
import { gatewayCall } from '../server/lib/mobile-calls'
import { updateConfiguration } from '../server/lib/management'
import { Phone, header } from './gateway-sip-fixture'

export async function providerSmoke({ari,upstreamAri,upstreams,calls,phones,fixture:f,pbx,directory,upstreamPassword,command}: {
  ari:Ari;upstreamAri:Ari;upstreams:Upstreams;calls:Calls;phones:Phone[];fixture:Awaited<ReturnType<typeof gatewayFixture>>;
  pbx:string;directory:string;upstreamPassword:string;command:(program:string,args:string[])=>string;
}) {
  async function until(check:()=>Promise<boolean>|boolean, description:string, timeout=40000) {
    const deadline=Date.now()+timeout
    while(Date.now()<deadline) { if(await check()) return; await delay(100) }
    throw new Error(`Timed out: ${description}`)
  }
  let providerUsername='1001'
  const aor=async()=>Object.fromEntries((await upstreamAri.request('GET',`asterisk/config/dynamic/res_pjsip/aor/${providerUsername}`)).filter((field:any)=>field.attribute!=='contact').map((field:any)=>[field.attribute,field.value]))
  const contacts=async(username=providerUsername):Promise<string[]> => (await upstreamAri.request('GET',`asterisk/config/dynamic/res_pjsip/aor/${username}`)).filter((field:any)=>field.attribute==='contact'&&field.value).map((field:any)=>field.value)
  const expiry=async(uri:string)=>{
    // Asterisk's location.c names dynamic contacts as AOR;@MD5(uri), and its
    // contact serializer supplies expiration_time in Unix seconds.
    const id=`${providerUsername};@${createHash('md5').update(uri).digest('hex')}`
    const fields=await upstreamAri.request('GET',`asterisk/config/dynamic/res_pjsip/contact/${encodeURIComponent(id)}`)
    const value=Number(fields.find((field:any)=>field.attribute==='expiration_time')?.value)
    assert.ok(Number.isSafeInteger(value)&&value>0,'Provider contact must have a real expiry')
    return value
  }
  const port=Number(command('docker',['port',pbx,'5061/tcp']).split(':').at(-1))
  const socket=tls.connect({host:'127.0.0.1',port,servername:pbx,ca:await readFile(join(directory,'server.crt')),minVersion:'TLSv1.2'})
  const deskAccount={password:upstreamPassword,settings:{username:'1001',domain:pbx}}
  const desk=new Phone(socket,deskAccount)
  try {
    await once(socket,'secureConnect');assert.equal(socket.authorized,true)
    assert.equal((await aor()).max_contacts,'1');assert.equal((await aor()).remove_existing,'false')
    assert.equal(await desk.register(),403,'Strict single-contact provider must reject a second phone')
    const before=await contacts();assert.equal(before.length,1)
    const previous=([...upstreams.accounts.values()] as any[])[0]!, oldUri=before[0]!
    assert.ok(oldUri.includes(previous.id),'The retained provider contact must belong to Sipper')
    const initialExpiry=await expiry(oldUri)
    assert.ok(initialExpiry*1000<=Date.now()+35000,'The fixture must cap registration lifetime so renewal is exercised')
    const conversation=await phones[0]!.call('2000');assert.match(conversation.response,/^SIP\/2.0 200/)
    await until(()=>[...calls.calls.values()].some(call=>call.upstream===previous.id&&call.connected),'call connected through original provider route')
    const bridge=([...calls.calls.values()] as any[]).find(call=>call.upstream===previous.id&&call.connected)!.bridge
    const account=(await gatewayUpstreams(f.nodeId)).accounts[0]!
    let saved=await updateConfiguration(f.actor,f.organisation,f.configuration.id,{revision:account.revision,label:'Provider replacement fixture',mode:'gateway',settings:account.settings})
    const changed=(await gatewayUpstreams(f.nodeId)).accounts
    await upstreams.reconcile(changed,calls.inUse)
    assert.deepEqual([...upstreams.accounts.keys()],[previous.id],'Live calls must defer upstream revision replacement')
    await until(async()=>await expiry(oldUri)>initialExpiry,'automatic upstream registration renewal')
    const renewedExpiry=await expiry(oldUri)
    assert.ok(renewedExpiry*1000>Date.now()+20000,'Renewed contact must outlive the replacement check')
    assert.deepEqual(await contacts(),[oldUri],'Renewal must retain exactly one provider contact')
    assert.equal((await ari.request('GET',`bridges/${bridge}`)).channels.length,2)
    await phones[0]!.bye(conversation)
    await until(()=>calls.calls.size===0&&calls.pendingEnds.size===0,'original conversation ended')
    await upstreams.reconcile(changed,calls.inUse)
    const replacement=([...upstreams.accounts.values()] as any[])[0]!
    assert.notEqual(replacement.id,previous.id)
    await until(async()=>!(await contacts()).includes(oldUri),'authenticated removal of original provider contact',5000)
    assert.ok(Date.now()<renewedExpiry*1000,'Replacement must unregister rather than wait for the original contact to expire')
    await until(async()=>{const current=await contacts();return current.length===1&&current[0]!.includes(replacement.id)},'strict provider route replacement',20000)
    const fresh=await phones[0]!.call('2000');assert.match(fresh.response,/^SIP\/2.0 200/)
    await phones[0]!.bye(fresh);await until(()=>calls.calls.size===0&&calls.pendingEnds.size===0,'replacement route call ended')
    console.log('PASS: Strict one-contact provider rejects another phone; automatic renewal and deferred revision replacement preserve the established bridge and restore fresh calling.')

    saved=await updateConfiguration(f.actor,f.organisation,f.configuration.id,{revision:saved.revision,label:'Multiple-contact fixture',mode:'gateway',settings:{...account.settings,username:'1002',authUsername:'1002'}})
    await upstreams.reconcile((await gatewayUpstreams(f.nodeId)).accounts,calls.inUse)
    const multiple=([...upstreams.accounts.values()] as any[])[0]!
    providerUsername='1002';deskAccount.settings.username=providerUsername
    assert.equal((await aor()).max_contacts,'2');assert.equal((await aor()).remove_existing,'false')
    await until(async()=>{const current=await contacts();return current.length===1&&current[0]!.includes(multiple.id)},'multiple-contact provider registration',20000)
    assert.equal((await contacts('1001')).length,0,'Changing provider account must unregister the previous identity')
    assert.equal(await desk.register(),200);assert.equal((await contacts()).length,2)
    for(const winner of ['sipper','desk'] as const) {
      const parent=randomUUID()
      await upstreamAri.request('POST','channels',undefined,{endpoint:`Local/${providerUsername}@fixture-inbound/n`,app:'sipper',channelId:parent,timeout:20,formats:'ulaw'})
      const offers=await Promise.all([phones[0]!.incoming(),phones[1]!.incoming(),desk.incoming()])
      const callId=header(offers[0]!,'X-Sipper-Call-ID')
      if(winner==='sipper') {
        await phones[0]!.answer(offers[0]!)
        for(const [phone,offer] of [[phones[1]!,offers[1]!],[desk,offers[2]!]] as const) {
          const cancel=await phone.receive(message=>message.startsWith('CANCEL ')&&header(message,'Call-ID')===header(offer,'Call-ID'))
          phone.respond(cancel,200);phone.respond(offer,487)
        }
        await until(async()=>(await gatewayCall(f.nodeId,callId)).state==='answered','managed phone wins provider fork')
        assert.equal((await gatewayCall(f.nodeId,callId)).winnerDeviceId,f.devices[0]!.id)
      } else {
        await desk.answer(offers[2]!)
        for(const [phone,offer] of [[phones[0]!,offers[0]!],[phones[1]!,offers[1]!]] as const) {
          const cancel=await phone.receive(message=>message.startsWith('CANCEL ')&&header(message,'Call-ID')===header(offer,'Call-ID'))
          phone.respond(cancel,200);phone.respond(offer,487)
        }
        await until(async()=>(await gatewayCall(f.nodeId,callId)).state==='ended','provider answer dismisses both managed recipients')
        assert.equal((await gatewayCall(f.nodeId,callId)).winnerDeviceId,null,'An external phone is not a Sipper device winner')
      }
      await upstreamAri.request('DELETE',`channels/${parent}`)
      const winnerPhone=winner==='sipper'?phones[0]!:desk, offer=winner==='sipper'?offers[0]!:offers[2]!
      const bye=await winnerPhone.receive(message=>message.startsWith('BYE ')&&header(message,'Call-ID')===header(offer,'Call-ID'))
      winnerPhone.respond(bye,200)
      await until(()=>calls.calls.size===0&&calls.pendingEnds.size===0,'provider fork hangup reported')
      assert.equal((await contacts()).length,2,'Call teardown must retain both registrations')
    }
    assert.equal(await desk.register(undefined,0),200)
    await until(async()=>(await contacts()).length===1,'external phone unregister leaves Sipper contact')
    console.log('PASS: Two-contact provider forks to Sipper and another phone; either answer cancels the other branch, preserves exact Sipper winner attribution and cleans up on hangup.')
    await updateConfiguration(f.actor,f.organisation,f.configuration.id,{revision:saved.revision,label:'Restored single-contact fixture',mode:'gateway',settings:account.settings})
    await upstreams.reconcile((await gatewayUpstreams(f.nodeId)).accounts,calls.inUse)
    const restored=([...upstreams.accounts.values()] as any[])[0]!
    providerUsername='1001'
    await until(async()=>{const current=await contacts();return current.length===1&&current[0]!.includes(restored.id)},'single-contact profile restored for controller recovery checks',20000)
  } finally {
    if(socket.authorized&&!socket.destroyed) await desk.register(undefined,0).catch(()=>{})
    socket.destroy()
  }
}
