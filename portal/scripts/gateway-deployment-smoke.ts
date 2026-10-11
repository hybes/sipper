// Exercise the actual deployment pair against the existing fictional SIP fixture.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tls from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'
import { rows } from '../server/lib/db'
import { provisionDevice } from '../server/lib/platform'
import { gatewayCall } from '../server/lib/mobile-calls'
import type { gatewayFixture } from '../tests/gateway-fixture'
import { Phone, header } from './gateway-sip-fixture'
import type { Ari } from '../../gateway/src/ari.mjs'

export async function deploymentSmoke({ directory, stateDirectory, origin, key, upstreamHost, upstreamAri, ariPassword, amiPassword, fixture: f, command }: {
  directory: string; stateDirectory: string; origin: string; key: string; upstreamHost: string; upstreamAri: Ari;
  ariPassword: string; amiPassword: string; fixture: Awaited<ReturnType<typeof gatewayFixture>>;
  command: (program:string,args:string[])=>string;
}) {
  assert.ok(![process.env.SIPPER_ANDROID_SERIAL,process.env.SIPPER_IOS_GATEWAY,process.env.SIPPER_MACOS_GATEWAY,process.env.SIPPER_WINDOWS_GATEWAY].some(Boolean),'Run the deployment rehearsal separately from native stages')
  const name=`sipper-gateway-deployment-${randomBytes(6).toString('hex')}`, relay=`${name}-relay`
  const controllerImage=process.env.SIPPER_GATEWAY_TEST_IMAGE ?? 'sipper-controller:local'
  const settings=join(stateDirectory,'deployment.env'), controllerEnv=join(stateDirectory,'deployment-controller.env'), override=join(stateDirectory,'deployment.yml')
  const compose=['compose','--env-file',settings,'-p',name,'-f',fileURLToPath(new URL('../../infra/compose.gateway.yml',import.meta.url)),'-f',override]
  const sockets: TLSSocket[]=[]
  const secrets=[key,ariPassword,amiPassword,(await readFile(join(directory,'container.env'),'utf8')).match(/^SIPPER_DB_PASSWORD=(.+)$/m)![1]!]
  const run=(...args:string[])=>command('docker',[...compose,...args])
  const node=async ()=>(await rows('SELECT controller_instance,ready_until>now() AS ready,controller_expires_at<=now() AS expired FROM gateway_nodes WHERE id=$1',[f.nodeId]))[0]!
  async function until(check:()=>Promise<boolean>|boolean, description:string, timeout=30000) {
    const deadline=Date.now()+timeout
    while(Date.now()<deadline) { if(await check()) return; await delay(200) }
    throw new Error(`Timed out: ${description}`)
  }
  let asterisk='',controller=''
  const exec=(code:string)=>JSON.parse(command('docker',['exec',controller,'node','--input-type=module','-e',code]))
  const journal=()=>exec(`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.SIPPER_STATE_FILE,{readOnly:true});console.log(JSON.stringify({calls:db.prepare('SELECT data FROM calls').all().map(row=>JSON.parse(row.data)),endings:db.prepare('SELECT id FROM endings').all()}));db.close()`)
  const ari=(path:string)=>exec(`import {Ari} from './src/ari.mjs';const ari=new Ari({url:process.env.SIPPER_ARI_URL,password:process.env.SIPPER_ARI_PASSWORD});console.log(JSON.stringify(await ari.request('GET',${JSON.stringify(path)})))`)
  try {
    await writeFile(controllerEnv,`SIPPER_PORTAL_URL=http://127.0.0.1:3100\nSIPPER_GATEWAY_API_KEY=${key}\nSIPPER_UPSTREAM_HOSTS=${upstreamHost}\nSIPPER_ARI_PASSWORD=${ariPassword}\nSIPPER_AMI_PASSWORD=${amiPassword}\n`,{mode:0o600})
    await writeFile(settings,Object.entries({
      SIPPER_ASTERISK_IMAGE:'sipper-asterisk:22.11.0',SIPPER_CONTROLLER_IMAGE:controllerImage,
      SIPPER_ASTERISK_ENV_FILE:join(directory,'container.env'),SIPPER_CONTROLLER_ENV_FILE:controllerEnv,
      SIPPER_GATEWAY_TLS_DIRECTORY:directory,SIPPER_GATEWAY_BIND_IP:'127.0.0.1',SIPPER_GATEWAY_TLS_PORT:'0',
      SIPPER_GATEWAY_RTP_START:'27000',SIPPER_GATEWAY_RTP_END:'27031',
    }).map(([name,value])=>`${name}=${value}`).join('\n')+'\n',{mode:0o600})
    await writeFile(override,`services:\n  asterisk:\n    volumes:\n      - type: bind\n        source: ${join(directory,'extconfig.conf')}\n        target: /etc/asterisk/extconfig.conf\n        read_only: true\n        bind: {create_host_path: false}\nnetworks:\n  default:\n    external: true\n    name: sipper-platform-dev_default\n`,{mode:0o600})
    run('config','--quiet')
    run('up','-d','--no-build','asterisk')
    asterisk=run('ps','-q','asterisk')
    await until(()=>command('docker',['inspect','--format','{{.State.Health.Status}}',asterisk])==='healthy','packaged Asterisk health')
    assert.equal(command('docker',['inspect','--format','{{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.Config.StopTimeout}}',asterisk]),'true asterisk -1')
    const permissions=JSON.parse(command('docker',['exec',asterisk,'python3','-c',"import json,os,stat; print(json.dumps({'uid':os.getuid(),'config':stat.S_IMODE(os.stat('/etc/asterisk').st_mode),'password':stat.S_IMODE(os.stat('/etc/asterisk/res_pgsql.conf').st_mode),'defaults':os.path.isfile('/etc/asterisk/modules.conf')}))"]))
    assert.deepEqual(permissions,{uid:10001,config:0o700,password:0o600,defaults:true})
    // Test-only portal forwarding; production uses the public HTTPS portal. This
    // companion publishes no port and has no database, SIP or service credential.
    command('docker',['run','-d','--name',relay,'--network',`container:${asterisk}`,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','node',controllerImage,
      '-e',`const net=require('net');net.createServer(c=>{const p=net.connect(${new URL(origin).port},'host.docker.internal');c.on('error',()=>p.destroy());p.on('error',()=>c.destroy());c.pipe(p);p.pipe(c)}).listen(3100,'127.0.0.1')`])
    run('up','-d','--no-build','controller'); controller=run('ps','-q','controller')
    await until(async ()=>(await node()).ready,'shared-namespace controller readiness')
    assert.equal(command('docker',['inspect','--format','{{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.Config.StopTimeout}}',controller]),'true node -1')
    assert.equal(command('docker',['inspect','--format','{{.HostConfig.NetworkMode}}',controller]),`container:${asterisk}`)
    const address=JSON.parse(command('docker',['exec',controller,'node','-e',"console.log(JSON.stringify(Object.values(require('os').networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal).address))"]))
    command('docker',['run','--rm','--network','sipper-platform-dev_default','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','node',controllerImage,'-e',
      `const net=require('net'),assert=require('assert/strict');Promise.all([8088,5038].map(port=>new Promise((resolve,reject)=>{const s=net.connect(port,${JSON.stringify(address)});s.setTimeout(3000);s.on('connect',()=>{s.destroy();reject(Error('Private management interface exposed'))});s.on('timeout',()=>{s.destroy();reject(Error('Probe timed out'))});s.on('error',e=>{assert.equal(e.code,'ECONNREFUSED');resolve()})}))).catch(()=>process.exit(1))`])
    assert.deepEqual(command('docker',['port',asterisk]).split('\n').map(line=>line.split(' -> ')[0]).filter(line=>!line.endsWith('/udp')),['5061/tcp'])
    console.log('PASS: Deployed Asterisk/controller use read-only roots, private generated config, infinite graceful-stop timeouts and a shared network namespace; ARI/AMI reject other containers.')
    await until(async ()=>(await upstreamAri.request('GET','endpoints/PJSIP/1001')).state==='online','deployed upstream registration')
    const port=Number(run('port','asterisk','5061').split(':').at(-1)), ca=await readFile(join(directory,'server.crt'))
    const phones=[]
    for(const device of f.devices) {
      const configuration=await provisionDevice(f.actor,device.id)
      const socket=tls.connect({host:'127.0.0.1',port,servername:'localhost',ca,minVersion:'TLSv1.2'})
      sockets.push(socket); await once(socket,'secureConnect'); assert.equal(socket.authorized,true)
      const phone=new Phone(socket,configuration.accounts[0]!); phones.push(phone); assert.equal(await phone.register(),200)
    }
    await until(async ()=>Number((await rows("SELECT count(*) AS count FROM gateway_credentials WHERE gateway_id=$1 AND registration_state='registered' AND registration_controller=$2",[f.nodeId,(await node()).controller_instance]))[0]!.count)===2,'deployed registration reports')
    const outgoing=await phones[0]!.call('2000'); assert.match(outgoing.response,/^SIP\/2.0 200/); assert.match(outgoing.response,/a=crypto:/)
    await until(()=>journal().calls.some((call:any)=>!call.incoming&&call.connected),'deployed outgoing bridge')
    const outgoingId=journal().calls.find((call:any)=>!call.incoming&&call.connected).id
    assert.equal((await gatewayCall(f.nodeId,outgoingId)).state,'answered')
    await phones[0]!.bye(outgoing)
    await until(()=>journal().calls.length===0&&journal().endings.length===0,'deployed outgoing hangup')
    const parent=randomUUID()
    await upstreamAri.request('POST','channels',undefined,{endpoint:'PJSIP/1001',app:'sipper',channelId:parent,timeout:20,formats:'ulaw'})
    const ringing=await Promise.all(phones.map(phone=>phone.incoming())), incomingId=header(ringing[0]!,'X-Sipper-Call-ID')
    await phones[0]!.answer(ringing[0]!)
    const cancel=await phones[1]!.receive(message=>message.startsWith('CANCEL ')&&header(message,'Call-ID')===header(ringing[1]!,'Call-ID'))
    phones[1]!.respond(cancel,200);phones[1]!.respond(ringing[1]!,487)
    await until(()=>journal().calls.some((call:any)=>call.id===incomingId&&call.connected),'deployed incoming bridge')
    const stopping=new Promise<number|null>(resolve=>{
      const child=spawn('docker',['stop','--timeout=-1',controller],{stdio:'ignore'})
      child.once('exit',resolve);child.once('error',()=>resolve(1))
    })
    await until(async ()=>!(await node()).ready,'deployment drain withdraws readiness')
    assert.equal(command('docker',['inspect','--format','{{.State.Running}}',controller]),'true')
    assert.equal(ari(`bridges/sipper-${incomingId}`).channels.length,2)
    await upstreamAri.request('DELETE',`channels/${parent}`)
    const bye=await phones[0]!.receive(message=>message.startsWith('BYE ')&&header(message,'Call-ID')===header(ringing[0]!,'Call-ID'))
    phones[0]!.respond(bye,200)
    await until(()=>command('docker',['inspect','--format','{{.State.Running}}',controller])==='false','deployed graceful drain')
    assert.equal(await stopping,0)
    assert.equal(command('docker',['inspect','--format','{{.State.ExitCode}}',controller]),'0')
    assert.equal((await node()).controller_instance,null)
    assert.equal((await gatewayCall(f.nodeId,incomingId)).state,'ended')
    console.log('PASS: Actual deployment pair registers both phones, reports their registrations, connects encrypted incoming/outgoing SIP and keeps an active bridge while draining until hangup.')
    for(const id of [asterisk,controller]) {
      const result=spawnSync('docker',['logs',id],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024})
      assert.equal(result.status,0)
      assert.ok(!secrets.some(secret=>(result.stdout+result.stderr).includes(secret)),'Deployment logs must omit service secrets')
    }
  } finally {
    for(const socket of sockets) socket.destroy()
    let diagnostics=''
    for(const id of [asterisk,controller].filter(Boolean)) {
      const result=spawnSync('docker',['logs','--tail','100',id],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024})
      if(result.status===0) diagnostics+=result.stdout+result.stderr
    }
    for(const secret of secrets) diagnostics=diagnostics.replaceAll(secret,'[redacted]')
    await writeFile('/tmp/sipper-gateway-deployment.log',diagnostics,{mode:0o600})
    // Force-remove only this rehearsal's resources on failure too, so an
    // intentionally infinite production drain cannot strand the test cleanup.
    const owned=spawnSync('docker',[...compose,'ps','-aq'],{encoding:'utf8',timeout:30000})
    const ids=owned.stdout?.trim().split(/\s+/).filter(id=>/^[a-f0-9]{12,64}$/.test(id)) ?? []
    if(ids.length) command('docker',['rm','-f',...ids])
    spawnSync('docker',['rm','-f',relay],{stdio:'ignore',timeout:30000})
    run('down','--volumes','--remove-orphans')
  }
}
