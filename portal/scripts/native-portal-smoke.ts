// Isolated real portal + native SDK acceptance. Browser gestures and audio are separate checks.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { open, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import dgram from 'node:dgram'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { getPool } from '../server/lib/db'
import { createVerifiedLocalUser, totp } from '../tests/auth-helper'
import { sessionPrincipal } from '../server/lib/http'
import * as platform from '../server/lib/platform'
import { configureTestBilling } from '../server/lib/billing'
import { saveDirectoryContact } from '../server/lib/directory'
import { setCallingPreference } from '../server/lib/devices'
import * as messaging from '../server/lib/messages'
import { runOnePushJob } from '../server/lib/push-jobs'

const native = process.argv[2] ?? 'android'
assert.ok(['android', 'ios', 'windows'].includes(native), 'Choose android, ios or windows')
const redirect = native === 'windows' ? 'sipper://oauth/callback' : native === 'ios' ? 'com.hybes.sipper:/oauth/callback' : 'com.hybes.sipper.development:/oauth/callback'
const serial = process.env.SIPPER_ANDROID_SERIAL ?? ''
if (native === 'android') assert.match(serial, /^emulator-\d+$/, 'Set SIPPER_ANDROID_SERIAL to the disposable SipperUIQA emulator')
const adb = process.env.SIPPER_TEST_ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
const adminURL = new URL(process.env.SIPPER_TEST_DATABASE_URL ?? 'postgresql://sipper:sipper_local_only@127.0.0.1:5547/sipper_test')
assert.ok(['localhost', '127.0.0.1'].includes(adminURL.hostname) && adminURL.pathname.endsWith('_test'), 'Use only the local test database')
const database = `sipper_${native}_${randomBytes(6).toString('hex')}_test`
const dbURL = new URL(adminURL); dbURL.pathname = `/${database}`
const admin = new pg.Client({ connectionString: adminURL.href })
const logPath = `/tmp/sipper-${native}-portal-test.log`
const log = await open(logPath, 'w', 0o600)
const pkg = 'com.hybes.sipper.android.development', children: ChildProcess[] = []
const vaultName = `portal-test-${randomBytes(12).toString('hex')}`
let created = false, reversed = false, port = 0, touchedDevice = false
let simulator: string | undefined, directory: string | undefined
async function command(program: string, args: string[], input?: string, timeout = 120_000) {
  const child = spawn(program, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let hardStop: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => { child.kill('SIGTERM'); hardStop = setTimeout(() => child.kill('SIGKILL'), 5000) }, timeout)
  child.stdout.on('data', bytes => { output += bytes.toString(); if (program === 'xcodebuild' || args.includes('--test')) void log.write(bytes) })
  child.stderr.on('data', bytes => { void log.write(bytes) })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, `Fixture command failed; see ${logPath}`)
    return output
  } finally { clearTimeout(timer); clearTimeout(hardStop) }
}
const device = (args: string[], input?: string) => command(adb, ['-s', serial, ...args], input)
async function writeDevice(file: string, value: unknown) {
  assert.match(file, /^portal-test(?:-reply)?\.json$/)
  if (native !== 'android') {
    await writeFile(join(directory!, `${file}.tmp`), JSON.stringify(value), {mode:0o600})
    await rename(join(directory!, `${file}.tmp`), join(directory!, file))
  } else await device(['shell', `run-as ${pkg} sh -c 'umask 077; mkdir -p files; cat > files/${file}.tmp; mv files/${file}.tmp files/${file}'`], JSON.stringify(value))
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = once(child, 'exit'); child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await ended } finally { clearTimeout(timer) }
}
try {
  if (native === 'android') {
    assert.equal((await device(['emu', 'avd', 'name'])).split(/\r?\n/)[0], 'SipperUIQA')
    assert.equal((await device(['shell','getprop','ro.boot.qemu.avd_name'])).trim(),'SipperUIQA','The ADB channel must belong to SipperUIQA, not another emulator sharing its port')
    assert.equal((await device(['shell','getprop','sys.boot_completed'])).trim(),'1','Wait for SipperUIQA to finish booting before running acceptance')
    const clockStarted=Date.now(), deviceClock=Number((await device(['shell','date','+%s'])).trim())*1000
    assert.ok(Number.isFinite(deviceClock) && Math.abs(deviceClock-(clockStarted+Date.now())/2)<10_000,
      'Synchronise SipperUIQA with the host clock before acceptance; short-lived access replies must remain bounded')
  }
  else if (native === 'ios') {
    const inventory = JSON.parse(await command('xcrun', ['simctl','list','devices','available','--json']))
    const templates = Object.entries(inventory.devices as Record<string, {name:string;deviceTypeIdentifier:string}[]>).flatMap(([runtime, devices]) => devices.filter(d => d.name === 'Sipper iOS QA').map(d => ({runtime,...d})))
    assert.equal(templates.length,1,'Create the dedicated Sipper iOS QA simulator first')
    simulator = (await command('xcrun',['simctl','create',`Sipper Portal Test ${randomBytes(6).toString('hex')}`,templates[0]!.deviceTypeIdentifier,templates[0]!.runtime])).trim()
    assert.match(simulator,/^[A-F0-9-]{36}$/)
    await command('xcrun',['simctl','boot',simulator])
    await command('xcrun',['simctl','bootstatus',simulator,'-b'],undefined,180_000)
    directory = await mkdtemp(join(tmpdir(),'sipper-ios-portal-'))
    await command('xcodegen',['generate','--spec',resolve('../ios/project.yml')])
  } else directory = await mkdtemp(join(tmpdir(),'sipper-windows-portal-'))
  const reservation = net.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
  port = (reservation.address() as net.AddressInfo).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const sip = dgram.createSocket('udp4'); sip.bind(0, '127.0.0.1'); await once(sip, 'listening')
  const sipPort = sip.address().port; sip.close()
  const origin = `http://127.0.0.1:${port}`
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: dbURL.href, SIPPER_BASE_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), SIPPER_ENCRYPTION_KEYS: JSON.stringify({v1:randomBytes(32).toString('base64')}), SIPPER_ENCRYPTION_KEY_ID:'v1',
    SMTP_HOST:'127.0.0.1', SMTP_PORT:'1029', SMTP_SECURE:'false', SMTP_USER:'', SMTP_PASSWORD:'', MAIL_FROM:'Sipper fixture <noreply@example.invalid>',
    STRIPE_SECRET_KEY:'', STRIPE_WEBHOOK_SECRET:'', STRIPE_PRICE_MONTHLY:'', STRIPE_PRICE_ANNUAL:'',
    SIPPER_ALLOW_TEST_BILLING:'true', SIPPER_REQUIRE_ADMIN_MFA:'true', SIPPER_EDGE_SHARED_SECRET:'', SIPPER_TRUSTED_PROXY_IPS:'',
    SIPPER_NATIVE_REDIRECTS:redirect, SIPPER_GATEWAY_API_KEY:'', SIPPER_APNS_PRIVATE_KEY:'', SIPPER_FCM_SERVICE_ACCOUNT:'' })
  await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true
  await log.write(await command(process.execPath, ['--import','tsx','scripts/migrate.ts']))
  const server = spawn(process.execPath, ['.output/server/index.mjs'], { env:{...process.env, HOST:'127.0.0.1', PORT:String(port)}, stdio:['ignore',log.fd,log.fd] }); children.push(server)
  let ready = false
  for (let i=0;i<60;i++) {
    if (server.exitCode !== null) break
    try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break } } catch {}
    await delay(250)
  }
  assert.ok(ready,'Built portal did not become healthy; run pnpm build first')
  const sipHost = native === 'android' ? '10.0.2.2' : '127.0.0.1'
  const registrar = spawn('python3', ['../tools/sip-test-server.py','--bind','127.0.0.1','--advertise',sipHost,'--port',String(sipPort),'--tls-port','0','--domain','sipper.test',
    '--user','managed:fixture-managed','--user','personal:fixture-personal','--auth-algorithm','SHA-256','--auth-invite','--answer-special','--special-call-seconds','300'], {stdio:['ignore',log.fd,log.fd]}); children.push(registrar)
  const user = await createVerifiedLocalUser(`${native} portal fixture`)
  const mfa = await user.client.call('/two-factor/enable',{password:user.password}); assert.equal(mfa.status,200)
  assert.equal((await user.client.call('/two-factor/verify-totp',{code:totp(new URL(mfa.data.totpURI).searchParams.get('secret')!)})).status,200)
  const actor = await sessionPrincipal(user.client.headers())
  const workspace = await platform.createWorkspace(actor,{name:`${native} portal fixture`,kind:'business'})
  const organisation = await platform.createOrganisation(actor,workspace.id,{name:'Harbour Studio · Test'})
  await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')",[workspace.id,organisation.id,user.userId])
  await configureTestBilling(actor,workspace.id,{quantity:3}); await platform.assignSeat(actor,workspace.id,user.userId)
  const messagePeers: Awaited<ReturnType<typeof createVerifiedLocalUser>>[] = []
  for(const name of ['Alex messaging fixture','Bea messaging fixture']) {
      const peer=await createVerifiedLocalUser(name)
      await getPool().query("INSERT INTO organisation_members(workspace_id,organisation_id,user_id,role) VALUES($1,$2,$3,'user')",[workspace.id,organisation.id,peer.userId])
      await platform.assignSeat(actor,workspace.id,peer.userId);messagePeers.push(peer)
  }
  const account = await platform.createConfiguration(actor,organisation.id,{label:'Harbour desk',mode:'direct',password:'fixture-managed',settings:{username:'managed',domain:'sipper.test',server:sipHost,port:sipPort,transport:'udp',srtp:'disabled',useICE:false}})
  await platform.assignConfiguration(actor,organisation.id,account.id,user.userId)
  for (const name of ['Alex Morgan','Mina Patel','Harbour reception']) await saveDirectoryContact(actor,organisation.id,null,{name,company:'Harbour Studio',numbers:[{label:'Work',number:'*97'}],
    ...(name === 'Alex Morgan' ? {memberUserId:user.userId} : {})})
  await setCallingPreference(actor,organisation.id,{shareStatus:true,shareActivity:true})
  const headers = user.client.headers(); headers.set('origin',origin); headers.set('content-type','application/json')
  async function auth(path: string, body?: unknown) {
    const response = await fetch(`${origin}/api/auth${path}`,{method:body ? 'POST':'GET',headers,redirect:'manual',...(body ? {body:JSON.stringify(body)}:{})})
    const data = await response.json().catch(()=>null)
    assert.ok(response.status === 200 || response.status === 302, `Authorisation HTTP status ${response.status}`)
    return new URL(response.headers.get('location') ?? data?.url,origin)
  }
  if (native === 'android') {
    await device(['install','-r',resolve('../android/app/build/outputs/apk/debug/app-debug.apk')])
    await device(['install','-r',resolve('../android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]); touchedDevice = true
    assert.ok(!(await device(['reverse','--list'])).includes(`tcp:${port}`),'Do not replace existing emulator routing')
    await device(['reverse',`tcp:${port}`,`tcp:${port}`]); reversed = true
    await device(['shell','run-as',pkg,'rm','-f','files/portal-test-phase.json','files/portal-test-reply.json'])
  }
  await writeDevice('portal-test.json',{origin,sipPort,vaultName,organisationId:organisation.id,userId:user.userId,messageUserIds:messagePeers.map(peer=>peer.userId)})
  if (native === 'windows') process.env.SIPPER_TEST_PORTAL_FILE = join(directory!,'portal-test.json')
  const phases: string[] = []
  let messageConversation: string | undefined, messageGroup: string | undefined
  let finished = false
  const instrument = (native === 'android'
    ? device(['shell','am','instrument','-w','-r','-e','class','com.hybes.sipper.ManagedPortalTest','-e','sipperPortal','isolated',`${pkg}.test/androidx.test.runner.AndroidJUnitRunner`])
    : native === 'windows' ? command(process.execPath,['--test','--test-reporter=tap',resolve('../windows/tests/integration/portal.test.mjs')])
    : command('xcodebuild',['-project',resolve('../ios/SipperIOS.xcodeproj'),'-scheme','SipperIOS','-configuration','Debug',
      '-destination',`platform=iOS Simulator,id=${simulator}`,'-derivedDataPath',resolve('../ios/DerivedData'),
      '-parallel-testing-enabled','NO','-collect-test-diagnostics','never','-only-testing:SipperIOSTests/PortalIntegrationTests',
      'CODE_SIGNING_ALLOWED=YES','CODE_SIGN_IDENTITY=-',`SIPPER_TEST_PORTAL_FILE=${join(directory!,'portal-test.json')}`,'test'],undefined,300_000))
    .then(output=>({output,error:null}),error=>({output:'',error})).finally(()=>{finished=true})
  let companionFailure: unknown
  try {
    while (!finished) {
      const text = native !== 'android' ? await readFile(join(directory!,'portal-test-phase.json'),'utf8').catch(()=>'')
        : await device(['shell',`run-as ${pkg} sh -c 'if [ -f files/portal-test-phase.json ]; then cat files/portal-test-phase.json; fi'`])
      const phase = (() => { try { return JSON.parse(text) } catch { return null } })()
      if (phase && !phases.includes(phase.phase)) {
        phases.push(phase.phase)
        const reply: Record<string,unknown> = {phase:phase.phase}
        if (phase.phase === 'authorise') {
          const url = new URL(phase.url)
          assert.equal(url.origin,origin); assert.equal(url.pathname,'/api/auth/oauth2/authorize')
          assert.equal(url.searchParams.get('client_id'),`sipper-${native}`); assert.equal(url.searchParams.get('code_challenge_method'),'S256')
          assert.equal(url.searchParams.get('redirect_uri'),redirect)
          let callback = await auth(`/oauth2/authorize${url.search}`)
          assert.equal(callback.pathname,'/portal/consent')
          callback = await auth('/oauth2/consent',{accept:true,oauth_query:callback.search.slice(1)})
          const target = new URL(callback); target.search = ''
          assert.equal(target.href,redirect)
          assert.equal(callback.searchParams.get('state'),url.searchParams.get('state')); assert.ok(callback.searchParams.get('code'))
          reply.callback=callback.href
        } else if (phase.phase === 'status-shared') {
          await setCallingPreference(actor,organisation.id,{shareStatus:false})
        } else if (phase.phase === 'activity-shared') {
          await setCallingPreference(actor,organisation.id,{shareActivity:false})
        } else if (phase.phase === 'messaging') {
          assert.equal(messagePeers.length,2)
          messageConversation=phase.conversationId;messageGroup=phase.groupId
          const scope={organisationId:organisation.id},peer=messagePeers[0]!
          const peerActor={userId:peer.userId,email:peer.email,verified:true,mfa:false}
          const history=await messaging.conversationMessages(peerActor,scope,messageConversation!)
          assert.equal(history.messages.length,1);assert.equal(history.messages[0]!.text,`From ${native === 'ios' ? 'iOS' : native === 'android' ? 'Android' : 'Windows'}: <b>literal text</b>\n🌱`)
          const group=await messaging.conversationMessages(peerActor,scope,messageGroup!)
          assert.equal(group.conversation.kind,'group');assert.equal(group.conversation.participants.length,3);assert.equal(group.messages.length,1)
          const current=(await getPool().query('SELECT last_request_action,last_request_ip FROM devices WHERE id=$1 AND organisation_id=$2',[phase.deviceId,organisation.id])).rows[0]
          assert.equal(current.last_request_action,'messages');assert.equal(current.last_request_ip,'127.0.0.1')
          const envelopes=(await getPool().query('SELECT envelope::text AS envelope FROM text_messages WHERE organisation_id=$1',[organisation.id])).rows
          assert.equal(envelopes.length,2);assert.ok(envelopes.every(row=>!row.envelope.includes('literal text') && !row.envelope.includes('Native group text')))
          if(native!=='windows') {
            const endpoints=(await getPool().query('SELECT provider,token_envelope::text AS envelope FROM message_push_endpoints WHERE device_id=$1',[phase.deviceId])).rows
            assert.equal(endpoints.length,1);assert.equal(endpoints[0].provider,native==='ios'?'apns':'fcm')
            assert.ok(!endpoints[0].envelope.includes(native==='ios'?'0a'.repeat(32):'fictional-message-fcm-token'))
            assert.equal((await getPool().query('SELECT count(*)::int AS count FROM push_endpoints WHERE device_id=$1',[phase.deviceId])).rows[0].count,0,'Messages must not register a call token')
          }
          await messaging.sendMessage(peerActor,scope,messageConversation!,{id:randomUUID(),text:'Reply from a fictional colleague.'})
          await messaging.sendMessage(peerActor,scope,messageGroup!,{id:randomUUID(),text:'Reply to the native group.'})
          if(native!=='windows') {
            let delivered=0
            assert.equal(await runOnePushJob(async()=>assert.fail('No call push expected'),async push=>{
              assert.equal(push.deviceId,phase.deviceId);assert.equal(push.conversationId,messageConversation)
              assert.deepEqual(Object.keys(push).sort(),['conversationId','deviceId','expiresAt','notificationId','provider','token'])
              assert.ok(Date.parse(push.expiresAt)>Date.now());delivered++;return 'accepted'
            }),true)
            assert.equal(delivered,1,'Exercise the provider boundary without sending a real notification')
          }
        } else if (phase.phase === 'messages-read') {
          const history=await messaging.conversationMessages(actor,{organisationId:organisation.id},messageConversation!)
          assert.equal(history.messages.length,2);assert.equal(history.conversation.unread,0)
          assert.equal((await messaging.conversationMessages(actor,{organisationId:organisation.id},messageGroup!)).conversation.unread,0)
          if(native!=='windows') {
            assert.equal(await runOnePushJob(async()=>assert.fail('No call push expected'),async()=>assert.fail('Read messages must not be delivered')),true)
            const outcomes=(await getPool().query("SELECT last_error,payload FROM jobs WHERE kind='message_push' ORDER BY last_error NULLS FIRST")).rows
            assert.equal(outcomes.length,2);assert.deepEqual(outcomes.map(row=>row.last_error),[null,'message_unavailable'])
            assert.ok(outcomes.every(row=>Object.keys(row.payload).length===0))
          }
        } else if (phase.phase === 'groups-left') {
          const peer=messagePeers[0]!,peerActor={userId:peer.userId,email:peer.email,verified:true,mfa:false},scope={organisationId:organisation.id}
          const group=(await messaging.conversationMessages(peerActor,scope,messageGroup!)).conversation
          assert.equal(group.title,'Updated native group');assert.equal(group.ownerId,peer.userId)
          assert.equal(group.participants.length,2);assert.ok(!group.participants.some(p=>p.id===actor.userId))
          await assert.rejects(messaging.conversationMessages(actor,scope,messageGroup!),(error:any)=>error.code==='not_found')
          await messaging.updateMessageGroup(peerActor,scope,messageGroup!,{revision:group.revision,title:group.title,userIds:[actor.userId,...group.participants.map(p=>p.id)],ownerId:actor.userId})
          assert.equal((await messaging.conversationMessages(actor,scope,messageGroup!)).messages.length,0)
          await messaging.sendMessage(peerActor,scope,messageGroup!,{id:randomUUID(),text:'After rejoining the group.'})
        } else if (phase.phase === 'calling') {
          const response = await fetch(`${origin}/api/platform/organisations/${organisation.id}`,{headers}); assert.equal(response.status,200)
          const details = await response.json() as any
          assert.equal(details.members.find((m:any)=>m.user_id===user.userId).availability,'away')
          assert.equal(details.members.find((m:any)=>m.user_id===user.userId).do_not_disturb,false)
          const current = details.devices.find((d:any)=>d.id===phase.deviceId); assert.ok(current)
          assert.equal(current.platform,native); assert.equal(current.last_request_action,'directory'); assert.equal(current.last_request_ip,'127.0.0.1')
          assert.equal(Date.parse(current.last_login_at),new Date(actor.sessionCreatedAt!).getTime(),'The device must report the real linked-session login time, even after a slow build')
          for (const key of ['last_request_at','last_report_at','last_configuration_at']) assert.ok(Date.now()-Date.parse(current[key])<120_000,key)
          assert.ok(current.applied_revision)
          assert.equal(current.status.registrations.length,1); assert.equal(current.status.registrations[0].state,'registered'); assert.equal(current.status.registrations[0].source,'device')
          assert.equal(current.status.directCalls.confirmed,true)
          assert.deepEqual(current.status.directCalls.accounts,[{accountId:account.id,ringing:0,dialling:0,connected:1,held:0}])
          assert.ok(!JSON.stringify(details).includes('fixture-managed') && !JSON.stringify(details).includes('fixture-personal'))
          await platform.setMemberStatus(actor,organisation.id,user.userId,'suspended')
        } else if (phase.phase === 'suspended') await platform.setMemberStatus(actor,organisation.id,user.userId,'active')
        else if (phase.phase === 'disconnected' || phase.phase === 'signed-out') {
          const result = await getPool().query('SELECT revoked_at FROM devices WHERE id=$1 AND organisation_id=$2',[phase.deviceId,organisation.id])
          assert.ok(result.rows[0]?.revoked_at,'Native local removal must also revoke the real server device')
          assert.equal((await getPool().query('SELECT count(*)::int AS count FROM message_push_endpoints WHERE device_id=$1',[phase.deviceId])).rows[0].count,0)
        } else assert.fail('Unexpected native phase')
        await writeDevice('portal-test-reply.json',reply)
      }
      await delay(100)
    }
  } catch (error) {
    companionFailure = error
    if (native === 'android') await device(['shell','am','force-stop',pkg])
    else if (native === 'ios') await command('xcrun',['simctl','terminate',simulator!,'com.hybes.sipper.ios.development']).catch(()=>{})
  }
  const result = await instrument
  if (native === 'android') await log.write(result.output)
  if (companionFailure) throw companionFailure
  if (result.error) throw result.error
  assert.match(result.output,native === 'android' ? /OK \(1 test\)/ : native === 'windows' ? /# pass 1\b/ : /Executed 1 test, with 0 failures/,`Native acceptance failed; inspect ${logPath}`)
  assert.deepEqual(phases,['authorise','status-shared','messaging','messages-read','groups-left','activity-shared','calling','suspended','disconnected','signed-out'])
  console.log(`PASS: ${native} OAuth PKCE against the built portal, verified MFA session, ${native === 'windows' ? 'session restoration/refresh with in-memory storage' : 'encrypted restoration'}, provisioning/SIP registration, directory calling and voluntary status/activity sharing and opt-out, real activity/IP reports, suspension/resumption and remote disconnect/sign-out. Browser gestures, native OS storage/UI and audible media require their own platform checks.`)
  console.log(`PASS: The actual ${native === 'ios' ? 'Apple' : native === 'android' ? 'Android' : 'Windows'} SDK sends direct/group text through native bearer HTTP, retries without duplicates, receives colleague replies, shares read state, renames/transfers/leaves/rejoins groups with post-join history, and records device-bound message activity without plaintext database envelopes.`)
  if(native!=='windows') console.log('PASS: Separate mobile message-token registration reaches the built portal, the worker uses opaque notice references, shared reads suppress queued delivery and device revocation removes the token. APNs/FCM delivery and OS permission/tap UI need signed-device checks.')
} finally {
  if (touchedDevice) await device(['shell','am','force-stop',pkg]).catch(()=>{})
  if (touchedDevice) await device(['shell','run-as',pkg,'rm','-f','files/portal-test.json','files/portal-test.json.tmp','files/portal-test-phase.json','files/portal-test-reply.json','files/portal-test-reply.json.tmp',`no_backup/${vaultName}.enc`,`no_backup/${vaultName}.enc.bak`,`no_backup/${vaultName}.enc.new`]).catch(()=>{})
  if (reversed) await device(['reverse','--remove',`tcp:${port}`]).catch(()=>{})
  for (const child of children.reverse()) await stop(child)
  await getPool().end()
  if (created) await admin.query(`DROP DATABASE ${database}`)
  await admin.end()
  if (simulator) {
    await command('xcrun',['simctl','shutdown',simulator]).catch(()=>{})
    await command('xcrun',['simctl','delete',simulator])
  }
  if (directory) await rm(directory,{recursive:true,force:true})
  await log.close()
}
