// Starts the actual built portal and gateway process against the disposable SIP fixture.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { rows } from '../server/lib/db'
import { gatewayCall } from '../server/lib/mobile-calls'
import type { gatewayFixture } from '../tests/gateway-fixture'
import { Phone, header } from './gateway-sip-fixture'
import { Ari } from '../../gateway/src/ari.mjs'
import { setMemberStatus } from '../server/lib/platform'
import { requestCallEnd } from '../server/lib/service-operations'
import { transferSmoke } from './gateway-transfer-smoke'
import { deploymentSmoke } from './gateway-deployment-smoke'

async function until(check: () => Promise<boolean> | boolean, description: string, timeout = 20000) {
  for (let i = 0; i < timeout / 100; i++) { if (await check()) return; await delay(100) }
  throw new Error(`Timed out: ${description}`)
}
async function listen(server: net.Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return (server.address() as net.AddressInfo).port
}

export async function processSmoke({ ari, upstreamAri, phones, fixture: f, upstreamHost, ariPassword, ami, container, directory, command, reconnectPhones }: {
  ari: Ari; upstreamAri: Ari; phones: Phone[]; fixture: Awaited<ReturnType<typeof gatewayFixture>>;
  upstreamHost: string; ariPassword: string; ami: { url: string; password: string };
  container: string; directory: string; command: (program:string,args:string[]) => string; reconnectPhones: () => Promise<void>;
}) {
  const serverFile = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url))
  await access(serverFile)
  const reservation = net.createServer(), portalPort = await listen(reservation)
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const origin = `http://127.0.0.1:${portalPort}`, key = randomBytes(32).toString('base64url')
  const stateDirectory = await mkdtemp(join(tmpdir(), 'sipper-gateway-recovery-')), stateFile = join(stateDirectory, 'controller.sqlite')
  const children: { child: ChildProcess; done: Promise<number | null> }[] = []
  const containerImage = process.env.SIPPER_GATEWAY_TEST_IMAGE
  const controllerContainer = `sipper-controller-test-${randomBytes(6).toString('hex')}`
  const controllerVolume = `${controllerContainer}-state`
  let containerVolumeCreated = false
  let logs = '', blockEvents = false
  const eventSockets = new Set<net.Socket>(), allSockets = new Set<net.Socket>()
  const proxy = net.createServer(client => {
    const target = net.connect(Number(ari.url.port), '127.0.0.1')
    allSockets.add(client); allSockets.add(target)
    client.once('data', bytes => {
      if (bytes.toString().startsWith('GET /ari/events?')) {
        eventSockets.add(client)
        if (blockEvents) { client.destroy(); target.destroy() }
      }
    })
    client.on('error', () => target.destroy()); target.on('error', () => client.destroy())
    client.on('close', () => { allSockets.delete(client); eventSockets.delete(client); target.destroy() })
    target.on('close', () => { allSockets.delete(target); client.destroy() })
    client.pipe(target); target.pipe(client)
  })
  const proxyPort = await listen(proxy)
  function launch(file: string, env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.on('data', bytes => { logs = (logs + bytes).slice(-100_000) })
    child.stderr!.on('data', bytes => { logs = (logs + bytes).slice(-100_000) })
    const done = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
    const value = { child, done }; children.push(value); return value
  }
  const controllerEnv = { ...process.env, SIPPER_PORTAL_URL: origin, SIPPER_GATEWAY_API_KEY: key,
    SIPPER_UPSTREAM_HOSTS: upstreamHost, SIPPER_ARI_PASSWORD: ariPassword, SIPPER_ARI_URL: `http://127.0.0.1:${proxyPort}/ari`,
    SIPPER_AMI_URL: ami.url, SIPPER_AMI_PASSWORD: ami.password, SIPPER_STATE_FILE: stateFile }
  const controllerFile = fileURLToPath(new URL('../../gateway/src/main.mjs', import.meta.url))
  function journal() {
    const db = new DatabaseSync(stateFile, { readOnly: true })
    try { return { calls: db.prepare('SELECT data FROM calls').all().map((row: any) => JSON.parse(row.data)), endings: db.prepare('SELECT id FROM endings').all() } }
    finally { db.close() }
  }
  try {
    const portalServer = launch(serverFile, { ...process.env, NODE_ENV: 'test', NITRO_HOST: '127.0.0.1', NITRO_PORT: String(portalPort),
      SIPPER_BASE_URL: origin, SIPPER_GATEWAY_API_KEY: key, SIPPER_GATEWAY_PUBLIC_HOST: 'localhost', SIPPER_GATEWAY_PUBLIC_PORT: '5061' })
    await until(async () => { try { return (await fetch(`${origin}/api/health`)).ok } catch { return false } }, 'built portal startup')
    const request = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) => fetch(`${origin}/api/gateway/${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    })
    assert.equal((await request('upstreams')).status, 401)
    const validKey = { authorization: `Bearer ${key}` }
    const unowned = await request('upstreams', validKey)
    assert.equal(unowned.status, 409)
    assert.match(unowned.headers.get('cache-control') ?? '', /no-store/)
    assert.equal((await request('heartbeat', validKey, 'POST', {})).status, 415)
    assert.equal((await request('heartbeat', { ...validKey, 'content-type': 'application/json' }, 'POST', {})).status, 400)

    let service = launch(controllerFile, controllerEnv)
    const node = async () => (await rows('SELECT controller_instance,registration_generation,ready_until>now() AS ready,controller_expires_at<=now() AS expired FROM gateway_nodes WHERE id=$1', [f.nodeId]))[0]!
    await until(async () => Boolean((await node()).controller_instance && (await node()).ready), 'standalone controller readiness')
    let instanceId = (await node()).controller_instance
    await until(async () => (await upstreamAri.request('GET', 'endpoints/PJSIP/1001')).state === 'online', 'standalone upstream registration')
    const snapshot = await request('upstreams', { ...validKey, 'x-sipper-controller': instanceId })
    assert.equal(snapshot.status, 200)
    assert.equal((await snapshot.json() as any).accounts.length, 1)
    await until(async () => Number((await rows(`SELECT count(*) AS count FROM gateway_credentials
      WHERE gateway_id=$1 AND registration_state='registered' AND registration_controller=$2 AND registration_ip IS NOT NULL
        AND registration_observed_at>now()-interval '30 seconds'`, [f.nodeId,instanceId]))[0]!.count) === 2, 'controller contact observations reach the portal')
    console.log('PASS: Built gateway HTTP authentication, controller lease checks and standalone upstream registration.')
    console.log('PASS: Standalone controller reports both real device registrations and SIP peer IPs to the built portal.')
    await until(async () => (await rows(`SELECT state FROM gateway_upstream_registrations
      WHERE gateway_id=$1 AND configuration_id=$2 AND controller_instance=$3 AND observed_at>now()-interval '30 seconds'`,
    [f.nodeId,f.configuration.id,instanceId]))[0]?.state === 'registered', 'controller upstream observations reach the portal')
    console.log('PASS: Standalone controller reports real upstream PBX registration through the built portal.')

    // The second process must fail before it can replace the first ARI socket.
    const duplicate = launch(controllerFile, controllerEnv)
    await until(() => duplicate.child.exitCode !== null, 'duplicate controller exit')
    assert.equal(await duplicate.done, 1)
    assert.equal((await node()).controller_instance, instanceId)
    assert.equal((await node()).ready, true)
    console.log('PASS: A second controller cannot steal the lease or withdraw the active gateway.')
    await transferSmoke(ari, phones, f, async () => {
      const previous = (await node()).controller_instance
      service.child.kill('SIGKILL'); await service.done
      await until(async () => (await node()).expired, 'transferred call controller lease expiry', 40000)
      service = launch(controllerFile, controllerEnv)
      await until(async () => (await node()).controller_instance !== previous && (await node()).ready, 'transferred call recovery')
    })
    instanceId = (await node()).controller_instance

    await until(() => !upstreamAri.socket, 'fixture WebSocket closed')
    await upstreamAri.connect()
    const parent = randomUUID()
    await upstreamAri.request('POST', 'channels', undefined, { endpoint: 'PJSIP/1001', app: 'sipper', channelId: parent, timeout: 20, formats: 'ulaw' })
    const ringing = await Promise.all(phones.map(phone => phone.incoming()))
    const callId = header(ringing[0]!, 'X-Sipper-Call-ID'), bridgeId = `sipper-${callId}`
    await phones[0]!.answer(ringing[0]!)
    const cancel = await phones[1]!.receive(message => message.startsWith('CANCEL ') && header(message, 'Call-ID') === header(ringing[1]!, 'Call-ID'))
    phones[1]!.respond(cancel, 200); phones[1]!.respond(ringing[1]!, 487)
    await until(async () => (await gatewayCall(f.nodeId, callId)).state === 'answered', 'HTTP incoming bridge')
    assert.equal((await ari.request('GET', `bridges/${bridgeId}`)).channels.length, 2)
    await until(() => journal().calls.some(call => call.id === callId && call.connected), 'connected call committed to recovery store')
    service.child.kill('SIGKILL'); await service.done
    assert.equal(service.child.signalCode, 'SIGKILL')
    await setMemberStatus(f.actor, f.organisation, f.actor.userId, 'suspended')
    await until(async () => (await node()).expired, 'crashed controller lease expiry', 40000)
    assert.equal((await ari.request('GET', `bridges/${bridgeId}`)).channels.length, 2, 'Controller crash must preserve Asterisk media legs')
    service = launch(controllerFile, controllerEnv)
    await until(async () => (await node()).controller_instance !== instanceId && (await node()).ready, 'replacement restored live call')
    assert.equal((await ari.request('GET', `bridges/${bridgeId}`)).channels.length, 2)
    assert.notEqual(Number(/^SIP\/2.0 (\d+)/.exec((await phones[1]!.call('2000')).response)?.[1]), 200)
    await setMemberStatus(f.actor, f.organisation, f.actor.userId, 'active')
    console.log('PASS: SIGKILL and lease expiry preserve the bridge; the replacement restores it without re-enabling a suspended user.')
    blockEvents = true
    for (const socket of eventSockets) socket.destroy()
    await until(async () => !(await node()).ready, 'readiness withdrawn after event disconnect')
    assert.equal((await ari.request('GET', `bridges/${bridgeId}`)).channels.length, 2, 'Event disconnect must not hang up the established bridge')
    blockEvents = false
    await until(async () => (await node()).ready && eventSockets.size === 1, 'live call connection restored')
    assert.equal((await ari.request('GET', `bridges/${bridgeId}`)).channels.length, 2, 'Reconciliation must preserve both live call legs')
    blockEvents = true
    for (const socket of eventSockets) socket.destroy()
    await until(async () => !(await node()).ready, 'second event disconnect')
    await upstreamAri.request('DELETE', `channels/${parent}`)
    await delay(200)
    blockEvents = false
    const bye = await phones[0]!.receive(message => message.startsWith('BYE ') && header(message, 'Call-ID') === header(ringing[0]!, 'Call-ID'), 20000)
    phones[0]!.respond(bye, 200)
    await until(async () => (await gatewayCall(f.nodeId, callId)).state === 'ended' && (await node()).ready, 'missed hangup reconciled after reconnect')
    assert.equal((await ari.request('GET', 'bridges')).length, 0)
    console.log('PASS: Event reconnect preserves both live legs; a second disconnect and missed hangup are reconciled through HTTP.')

    const endParent=randomUUID()
    await upstreamAri.request('POST','channels',undefined,{endpoint:'PJSIP/1001',app:'sipper',channelId:endParent,timeout:20,formats:'ulaw'})
    const endRinging=await Promise.all(phones.map(phone=>phone.incoming()))
    const endId=header(endRinging[0]!,'X-Sipper-Call-ID')
    await phones[0]!.answer(endRinging[0]!)
    const endCancel=await phones[1]!.receive(message=>message.startsWith('CANCEL ') && header(message,'Call-ID')===header(endRinging[1]!,'Call-ID'))
    phones[1]!.respond(endCancel,200); phones[1]!.respond(endRinging[1]!,487)
    await until(()=>journal().calls.some(call=>call.id===endId&&call.connected),'call ready for explicit termination')
    blockEvents=true
    for(const socket of eventSockets) socket.destroy()
    await until(async ()=>!(await node()).ready,'gateway unavailable before end request')
    await requestCallEnd(f.actor,f.organisation,endId)
    assert.equal((await gatewayCall(f.nodeId,endId)).state,'answered')
    assert.equal((await gatewayCall(f.nodeId,endId)).endRequested,true)
    assert.equal((await ari.request('GET',`bridges/sipper-${endId}`)).channels.length,2,'The request is not proof of hangup')
    blockEvents=false
    const endBye=await phones[0]!.receive(message=>message.startsWith('BYE ') && header(message,'Call-ID')===header(endRinging[0]!,'Call-ID'),20000)
    phones[0]!.respond(endBye,200)
    await until(async ()=>(await gatewayCall(f.nodeId,endId)).state==='ended' && (await ari.request('GET','bridges')).length===0 && (await node()).ready,'requested incoming call ended after reconnect')
    assert.equal((await gatewayCall(f.nodeId,endId)).reason,'admin_ended')
    await until(async ()=>!(await upstreamAri.request('GET','channels')).some((channel: any)=>channel.id===endParent),'upstream dialog disconnected')
    console.log('PASS: An explicit incoming-call end waits through gateway disconnection, then sends SIP BYE, removes both media legs and confirms admin_ended.')

    const endOutgoing=await phones[0]!.call('2000'); assert.match(endOutgoing.response,/^SIP\/2.0 200/)
    await until(()=>journal().calls.some(call=>!call.incoming&&call.connected),'outgoing call ready for explicit termination')
    const endOutgoingId=journal().calls.find(call=>!call.incoming&&call.connected)!.id
    await requestCallEnd(f.actor,f.organisation,endOutgoingId)
    const outgoingBye=await phones[0]!.receive(message=>message.startsWith('BYE ') && header(message,'Call-ID')===endOutgoing.id,20000)
    phones[0]!.respond(outgoingBye,200)
    await until(async ()=>(await gatewayCall(f.nodeId,endOutgoingId)).state==='ended' && (await ari.request('GET','bridges')).length===0,'requested outgoing call disconnected')
    assert.equal((await gatewayCall(f.nodeId,endOutgoingId)).reason,'admin_ended')
    console.log('PASS: Explicit outgoing-call termination reaches the real SIP phone and is confirmed only after bridge teardown.')

    const retryParent = randomUUID()
    await upstreamAri.request('POST', 'channels', undefined, { endpoint: 'PJSIP/1001', app: 'sipper', channelId: retryParent, timeout: 20, formats: 'ulaw' })
    const retryRinging = await Promise.all(phones.map(phone => phone.incoming()))
    const retryId = header(retryRinging[0]!, 'X-Sipper-Call-ID')
    await phones[0]!.answer(retryRinging[0]!)
    const retryCancel = await phones[1]!.receive(message => message.startsWith('CANCEL ') && header(message, 'Call-ID') === header(retryRinging[1]!, 'Call-ID'))
    phones[1]!.respond(retryCancel, 200); phones[1]!.respond(retryRinging[1]!, 487)
    await until(() => journal().calls.some(call => call.id === retryId && call.connected), 'second call committed')
    portalServer.child.kill('SIGSTOP')
    await upstreamAri.request('DELETE', `channels/${retryParent}`)
    const retryBye = await phones[0]!.receive(message => message.startsWith('BYE ') && header(message, 'Call-ID') === header(retryRinging[0]!, 'Call-ID'))
    phones[0]!.respond(retryBye, 200)
    await until(() => journal().endings.some(row => row.id === retryId), 'end report stored while portal is unavailable')
    service.child.kill('SIGKILL'); await service.done
    portalServer.child.kill('SIGCONT')
    await until(async () => (await node()).expired, 'second crashed lease expiry', 40000)
    service = launch(controllerFile, controllerEnv)
    await until(async () => (await gatewayCall(f.nodeId, retryId)).state === 'ended' && journal().endings.length === 0 && (await node()).ready, 'durable call end replayed')
    console.log('PASS: An end report survives unavailable HTTP and SIGKILL, then is acknowledged and removed by the replacement.')

    let outgoing = await phones[0]!.call('2000')
    assert.match(outgoing.response, /^SIP\/2.0 200/)
    await until(async () => (await ari.request('GET', 'bridges')).some((bridge: any) => bridge.channels.length === 2), 'standalone outgoing bridge')
    await until(() => journal().calls.some(call=>!call.incoming && call.connected),'outgoing call journalled')
    let outgoingId = journal().calls.find(call=>!call.incoming && call.connected)!.id
    const outgoingRecord = (await rows('SELECT direction,origin_device_id,caller_envelope,state FROM gateway_calls WHERE id=$1',[outgoingId]))[0]!
    assert.equal(outgoingRecord.direction,'outgoing'); assert.equal(outgoingRecord.origin_device_id,f.devices[0]!.id)
    assert.equal(outgoingRecord.caller_envelope,null); assert.equal(outgoingRecord.state,'answered')
    service.child.kill('SIGKILL'); await service.done
    await until(async () => (await node()).expired,'outgoing crashed lease expiry',40000)
    service = launch(controllerFile,controllerEnv)
    await until(async () => (await node()).ready && journal().calls.some(call=>call.id===outgoingId && call.connected),'outgoing call recovered')
    assert.equal((await gatewayCall(f.nodeId,outgoingId)).state,'answered')
    assert.equal((await ari.request('GET','bridges'))[0].channels.length,2)
    console.log('PASS: Outgoing activity survives controller SIGKILL/restart with the originating device intact.')

    // Unlike controller loss, losing Asterisk destroys the SIP/media dialogs.
    // The running controller must mark those calls failed and rebuild routes.
    const lostOutgoingId=outgoingId, asteriskStart=(await ari.request('GET','asterisk/info')).status.startup_time
    const lostParent=randomUUID()
    await upstreamAri.request('POST','channels',undefined,{endpoint:'PJSIP/1001',app:'sipper',channelId:lostParent,timeout:20,formats:'ulaw'})
    const lostRinging=await Promise.all(phones.map(phone=>phone.incoming()))
    const lostIncomingId=header(lostRinging[1]!,'X-Sipper-Call-ID')
    await phones[1]!.answer(lostRinging[1]!)
    const lostCancel=await phones[0]!.receive(message=>message.startsWith('CANCEL ') && header(message,'Call-ID')===header(lostRinging[0]!,'Call-ID'))
    phones[0]!.respond(lostCancel,200); phones[0]!.respond(lostRinging[0]!,487)
    await until(async ()=>(await gatewayCall(f.nodeId,lostIncomingId)).state==='answered','incoming call before Asterisk loss')
    assert.equal((await ari.request('GET','bridges')).length,2)
    const beforeRestart = await node()
    command('docker',['kill','--signal','KILL',container])
    await until(async ()=>!(await node()).ready,'Asterisk failure withdraws readiness')
    assert.equal(service.child.exitCode,null,'The controller stays alive while Asterisk is unavailable')
    command('docker',['start',container])
    assert.equal(Number(command('docker',['port',container,'8088/tcp']).split(':').at(-1)),Number(ari.url.port),'The fixture ARI endpoint must survive restart')
    assert.equal(Number(command('docker',['port',container,'5038/tcp']).split(':').at(-1)),Number(new URL(ami.url).port),'The fixture AMI endpoint must survive restart')
    await until(async ()=>{try{return (await ari.request('GET','asterisk/info')).status.startup_time!==asteriskStart}catch{return false}},'Asterisk restarted',30000)
    await until(async ()=>(await node()).ready,'routes reconciled after Asterisk restart',30000)
    const recovered = await node()
    assert.equal(recovered.controller_instance,beforeRestart.controller_instance)
    assert.notEqual(recovered.registration_generation,beforeRestart.registration_generation)
    const endpoint = (await rows('SELECT username FROM gateway_credentials WHERE gateway_id=$1 AND device_id=$2',[f.nodeId,f.devices[0]!.id]))[0]!.username
    for (const [path,report] of [
      ['registrations',{endpoint,state:'registered',ip:'127.0.0.1',observedAt:new Date().toISOString()}],
      ['upstream-registrations',{configurationId:f.configuration.id,revision:1,state:'registered',observedAt:new Date().toISOString()}],
    ] as const) {
      const late = await request(path,{...validKey,'content-type':'application/json','x-sipper-controller':recovered.controller_instance},'POST',{
        registrationGeneration:beforeRestart.registration_generation,reports:[report],
      })
      assert.equal(late.status,409)
      assert.equal((await late.json()).code,'registration_generation_changed')
    }
    await until(async ()=>(await gatewayCall(f.nodeId,lostOutgoingId)).state==='ended' && (await gatewayCall(f.nodeId,lostIncomingId)).state==='ended','interrupted calls ended')
    assert.equal((await gatewayCall(f.nodeId,lostOutgoingId)).reason,'failed')
    assert.equal((await gatewayCall(f.nodeId,lostIncomingId)).reason,'failed')
    assert.equal(journal().calls.length,0)
    await until(()=>journal().endings.length===0,'interrupted end reports acknowledged')
    await upstreamAri.request('DELETE',`channels/${lostParent}`)
    await reconnectPhones()
    for(const phone of phones) assert.equal(await phone.register(),200)
    const restartedAt=(await ari.request('GET','asterisk/info')).status.startup_time
    await until(async ()=>(await rows("SELECT 1 FROM gateway_upstream_registrations r JOIN gateway_nodes n ON n.id=r.gateway_id AND n.registration_generation=r.registration_generation WHERE r.gateway_id=$1 AND r.configuration_id=$2 AND r.state='registered' AND r.observed_at>$3::timestamptz",[f.nodeId,f.configuration.id,restartedAt])).length===1,'upstream registration observed after restart',30000)
    await until(async ()=>(await rows("SELECT 1 FROM gateway_credentials g JOIN gateway_nodes n ON n.id=g.gateway_id AND n.registration_generation=g.registration_generation WHERE g.gateway_id=$1 AND g.registration_state='registered' AND g.registration_observed_at>$2::timestamptz",[f.nodeId,restartedAt])).length===2,'fresh device registration generation after restart',30000)
    console.log('PASS: The same controller rejects pre-recovery device/upstream snapshots and reports fresh registrations under the new readiness generation.')
    const freshParent=randomUUID()
    await upstreamAri.request('POST','channels',undefined,{endpoint:'PJSIP/1001',app:'sipper',channelId:freshParent,timeout:20,formats:'ulaw'})
    const freshRinging=await Promise.all(phones.map(phone=>phone.incoming()))
    const freshIncomingId=header(freshRinging[0]!,'X-Sipper-Call-ID')
    await phones[0]!.answer(freshRinging[0]!)
    const freshCancel=await phones[1]!.receive(message=>message.startsWith('CANCEL ') && header(message,'Call-ID')===header(freshRinging[1]!,'Call-ID'))
    phones[1]!.respond(freshCancel,200); phones[1]!.respond(freshRinging[1]!,487)
    await until(async ()=>(await gatewayCall(f.nodeId,freshIncomingId)).state==='answered','fresh incoming call after Asterisk recovery')
    await upstreamAri.request('DELETE',`channels/${freshParent}`)
    const freshBye=await phones[0]!.receive(message=>message.startsWith('BYE ') && header(message,'Call-ID')===header(freshRinging[0]!,'Call-ID'))
    phones[0]!.respond(freshBye,200)
    await until(async ()=>(await gatewayCall(f.nodeId,freshIncomingId)).state==='ended','fresh incoming hangup after Asterisk recovery')
    outgoing=await phones[0]!.call('2000');assert.match(outgoing.response,/^SIP\/2.0 200/)
    await until(()=>journal().calls.some(call=>!call.incoming&&call.connected),'new outgoing call after Asterisk recovery')
    outgoingId=journal().calls.find(call=>!call.incoming&&call.connected)!.id
    assert.equal((await gatewayCall(f.nodeId,outgoingId)).state,'answered')
    console.log('PASS: Asterisk SIGKILL withdraws readiness, marks interrupted conversations failed, restores routes and allows fresh TLS registration plus incoming/outgoing calls.')
    service.child.kill('SIGTERM')
    await until(async () => !(await node()).ready, 'draining readiness')
    assert.equal(service.child.exitCode, null, 'A draining controller must stay until the conversation ends')
    assert.equal((await ari.request('GET', 'bridges'))[0].channels.length, 2)
    await phones[0]!.bye(outgoing)
    await until(() => service.child.exitCode !== null, 'graceful controller drain')
    assert.equal(await service.done, 0)
    assert.equal((await node()).controller_instance, null)
    assert.equal((await ari.request('GET', 'bridges')).length, 0)
    assert.equal(journal().calls.length, 0)
    assert.equal(journal().endings.length, 0)
    assert.equal((await gatewayCall(f.nodeId,outgoingId)).state,'ended')
    console.log('PASS: The fresh outgoing call after Asterisk recovery ends after real SIP hangup.')
    console.log('PASS: Graceful shutdown withdraws new-call readiness, preserves the active call and releases ownership after hangup.')
    if (containerImage) {
      // Host networking is only for reaching this rehearsal's loopback services.
      // Production controllers share the private Asterisk network namespace.
      const privateEnv = join(stateDirectory, 'container.env')
      await writeFile(privateEnv, Object.entries({
        SIPPER_PORTAL_URL: origin, SIPPER_GATEWAY_API_KEY: key,
        SIPPER_UPSTREAM_HOSTS: upstreamHost, SIPPER_ARI_PASSWORD: ariPassword,
        SIPPER_ARI_URL: controllerEnv.SIPPER_ARI_URL, SIPPER_AMI_URL: ami.url,
        SIPPER_AMI_PASSWORD: ami.password, SIPPER_STATE_FILE: '/var/lib/sipper-gateway/controller.sqlite',
      }).map(([name,value])=>`${name}=${value}`).join('\n')+'\n', {mode:0o600})
      command('docker',['volume','create',controllerVolume]); containerVolumeCreated=true
      const startContainer = () => command('docker',['run','-d','--name',controllerContainer,'--network','host',
        '--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--init',
        '--tmpfs','/tmp:rw,noexec,nosuid,size=16m,mode=1777','--env-file',privateEnv,
        '--mount',`type=volume,src=${controllerVolume},dst=/var/lib/sipper-gateway`,containerImage])
      const containerJournal = () => JSON.parse(command('docker',['exec',controllerContainer,'node','--input-type=module','-e',
        `import {DatabaseSync} from 'node:sqlite';import {statSync} from 'node:fs';
        const path='/var/lib/sipper-gateway/controller.sqlite',db=new DatabaseSync(path,{readOnly:true});
        console.log(JSON.stringify({uid:process.getuid(),mode:statSync(path).mode&511,directoryMode:statSync('/var/lib/sipper-gateway').mode&511,
        calls:db.prepare('SELECT data FROM calls').all().map(row=>JSON.parse(row.data)),endings:db.prepare('SELECT id FROM endings').all()}));db.close();`]))
      const containerLogs = () => {
        const result=spawnSync('docker',['logs',controllerContainer],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024})
        assert.equal(result.status,0,'Controller container logs must be readable')
        const output=result.stdout+result.stderr
        assert.ok(![key,ariPassword,ami.password].some(secret=>output.includes(secret)),'Container logs must omit authentication secrets')
        logs=(logs+output).slice(-100_000)
      }
      startContainer()
      await until(async ()=>(await node()).ready,'container controller readiness',30000)
      await until(async ()=>(await upstreamAri.request('GET','endpoints/PJSIP/1001')).state==='online','container upstream registration')
      const initialContainer=containerJournal()
      assert.equal(initialContainer.uid,1000); assert.equal(initialContainer.mode,0o600); assert.equal(initialContainer.directoryMode,0o700)
      let containerInstance=(await node()).controller_instance
      let containerCall=await phones[0]!.call('2000'); assert.match(containerCall.response,/^SIP\/2.0 200/)
      await until(()=>containerJournal().calls.some((call:any)=>!call.incoming&&call.connected),'container call persisted')
      const persisted=containerJournal().calls.find((call:any)=>!call.incoming&&call.connected)
      command('docker',['kill','--signal','KILL',controllerContainer]); containerLogs()
      assert.equal(command('docker',['inspect','--format','{{.State.ExitCode}}',controllerContainer]),'137')
      assert.equal((await ari.request('GET',`bridges/${persisted.bridge}`)).channels.length,2)
      await until(async ()=>(await node()).expired,'container controller lease expiry',40000)
      command('docker',['rm',controllerContainer]); startContainer()
      await until(async ()=>(await node()).ready&&(await node()).controller_instance!==containerInstance,'replacement container recovery',30000)
      assert.equal((await ari.request('GET',`bridges/${persisted.bridge}`)).channels.length,2)
      const adopted=containerJournal().calls.find((call:any)=>call.id===persisted.id)
      assert.equal(adopted.originDeviceId,f.devices[0]!.id)
      console.log('PASS: Non-root read-only controller container preserves its private journal and live bridge across container replacement.')

      // A simultaneous controller/media loss must not restore an imaginary call.
      containerInstance=(await node()).controller_instance
      const mediaStart=(await ari.request('GET','asterisk/info')).status.startup_time
      command('docker',['kill','--signal','KILL',controllerContainer]); containerLogs()
      command('docker',['kill','--signal','KILL',container])
      await until(async ()=>(await node()).expired&&!(await node()).ready,'combined loss withdraws gateway readiness',40000)
      command('docker',['start',container])
      await until(async ()=>{try{return (await ari.request('GET','asterisk/info')).status.startup_time!==mediaStart}catch{return false}},'media restart after combined loss',30000)
      command('docker',['rm',controllerContainer]); startContainer()
      await until(async ()=>(await node()).ready&&(await node()).controller_instance!==containerInstance,'controller/media recovery',30000)
      await until(async ()=>(await gatewayCall(f.nodeId,persisted.id)).state==='ended','lost container conversation reported')
      assert.equal((await gatewayCall(f.nodeId,persisted.id)).reason,'failed')
      assert.equal((await ari.request('GET','bridges')).length,0)
      await until(()=>containerJournal().calls.length===0&&containerJournal().endings.length===0,'cold recovery journal acknowledged')
      await reconnectPhones(); for(const phone of phones) assert.equal(await phone.register(),200)
      await until(async ()=>(await upstreamAri.request('GET','endpoints/PJSIP/1001')).state==='online','upstream restored after combined loss')
      containerCall=await phones[0]!.call('2000'); assert.match(containerCall.response,/^SIP\/2.0 200/)
      await until(()=>containerJournal().calls.some((call:any)=>call.connected),'fresh call after combined loss')
      await phones[0]!.bye(containerCall)
      await until(()=>containerJournal().calls.length===0&&containerJournal().endings.length===0,'new container call ended')
      command('docker',['kill','--signal','TERM',controllerContainer])
      await until(()=>command('docker',['inspect','--format','{{.State.Running}}',controllerContainer])==='false','container graceful exit')
      assert.equal(command('docker',['inspect','--format','{{.State.ExitCode}}',controllerContainer]),'0')
      assert.equal((await node()).controller_instance,null)
      containerLogs()
      console.log('PASS: Combined controller/media loss fails the interrupted call, restores fresh TLS registration/calling and drains cleanly. Physical host/power-loss recovery remains separate.')
    }
    if(process.env.SIPPER_GATEWAY_COMPOSE) await deploymentSmoke({directory,stateDirectory,origin,key,upstreamHost,upstreamAri,ariPassword,amiPassword:ami.password,fixture:f,command})
    assert.ok(![key,ariPassword,ami.password].some(secret=>logs.includes(secret)), 'Service logs must omit authentication secrets')
    // The enclosing fixture still checks device revocation and readiness expiry.
    await rows("UPDATE gateway_nodes SET ready_until=now()+interval '10 minutes' WHERE id=$1 RETURNING id", [f.nodeId])
  } finally {
    let cleanupError: unknown
    if (containerVolumeCreated) {
      try {
        if(command('docker',['ps','-aq','--filter',`name=^/${controllerContainer}$`])) command('docker',['rm','-f',controllerContainer])
      } catch(error) { cleanupError=error }
      try { command('docker',['volume','rm',controllerVolume]) } catch(error) { cleanupError ??= error }
    }
    upstreamAri.close()
    for (const { child, done } of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGCONT'); child.kill('SIGTERM') }
      const exited = await Promise.race([done.then(() => true), delay(2000).then(() => false)])
      if (!exited) { child.kill('SIGKILL'); await done }
    }
    for (const socket of allSockets) socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    await writeFile('/tmp/sipper-gateway-process-test.log', logs, { mode: 0o600 })
    await rm(stateDirectory, { recursive: true, force: true })
    if(cleanupError) throw cleanupError
  }
}
