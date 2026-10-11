// Real Asterisk-to-Asterisk TLS/SRTP negotiation; no external PBX or media source.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Ari } from '../../gateway/src/ari.mjs'
import { Upstreams, upstreamObjects } from '../../gateway/src/upstreams.mjs'
import { upstreamStatus } from '../../gateway/src/upstream-status.mjs'
import { Calls } from '../../gateway/src/calls.mjs'
import { State } from '../../gateway/src/state.mjs'
import { gatewayUpstreams, admitGatewayOutgoing, gatewayHeartbeat, releaseGatewayController } from '../server/lib/gateway'
import { admitGatewayTransfer, gatewayTransfer, pendingGatewayTransfers } from '../server/lib/gateway-transfers'
import { incomingGatewayCall, gatewayCall, deviceCall } from '../server/lib/mobile-calls'
import { updateConfiguration } from '../server/lib/management'
import { setCallingPreference } from '../server/lib/devices'
import { rows } from '../server/lib/db'
import * as platform from '../server/lib/platform'
import type { gatewayFixture } from '../tests/gateway-fixture'
import { androidSmoke } from './gateway-android-smoke'
import { nativeSmoke } from './gateway-native-smoke'
import { Phone, header } from './gateway-sip-fixture'
import { processSmoke } from './gateway-process-smoke'
import { providerSmoke } from './gateway-provider-smoke'

export async function callSmoke({ directory, pbx, container, ariPassword, amiPassword, phones, fixture: f, command, reconnectPhones }: {
  directory: string; pbx: string; container: string; ariPassword: string; amiPassword: string; phones: Phone[];
  fixture: Awaited<ReturnType<typeof gatewayFixture>>; command: (program: string, args: string[]) => string;
  reconnectPhones: () => Promise<void>;
}) {
  const pbxConfig = join(directory, 'pbx'), upstreamPassword = randomBytes(32).toString('base64url')
  await mkdir(pbxConfig, { mode: 0o755 })
  for (const name of ['asterisk.conf', 'logger.conf', 'rtp.conf', 'cdr.conf', 'cel.conf']) {
    await writeFile(join(pbxConfig, name), await readFile(new URL(`../../gateway/asterisk/config/${name}`, import.meta.url)))
  }
  await writeFile(join(pbxConfig, 'modules.conf'), '[modules]\nautoload=yes\nnoload=res_config_pgsql.so\n')
  await writeFile(join(pbxConfig, 'http.conf'), '[general]\nenabled=yes\nbindaddr=0.0.0.0\nbindport=8088\n')
  await writeFile(join(pbxConfig, 'ari.conf'), `[general]\nenabled=yes\n[sipper-controller]\ntype=user\nread_only=no\npassword=${ariPassword}\n`)
  // Hold may stop Asterisk's generator. Restart the fictional tone each second, bounded to two minutes.
  await writeFile(join(pbxConfig, 'extensions.conf'), '[fixture]\nexten=>2001,1,Answer()\n same=>n,Set(TIMEOUT(absolute)=120)\n same=>n(tone),Playtones(440)\n same=>n,Wait(1)\n same=>n,Goto(tone)\nexten=>2004,1,Hangup(21)\nexten=>_.,1,Answer()\n same=>n,Echo()\n same=>n,Hangup()\n[fixture-inbound]\nexten=>1001,1,Dial(${PJSIP_DIAL_CONTACTS(1001)},60)\n same=>n,Hangup()\nexten=>1002,1,Dial(${PJSIP_DIAL_CONTACTS(1002)},60)\n same=>n,Hangup()\n')
  await writeFile(join(pbxConfig, 'pjsip.conf'), `[global]
type=global
endpoint_identifier_order=username
default_auth_algorithms_uac=sha-256
default_auth_algorithms_uas=sha-256
[tls]
type=transport
protocol=tls
method=tlsv1_2
bind=0.0.0.0:5061
cert_file=/run/tls/server.crt
priv_key_file=/run/tls/server.key
ca_list_file=/run/tls/server.crt
verify_server=yes
` + ['1001','1002'].map(username => `[${username}]
type=endpoint
transport=tls
context=fixture
auth=${username}
aors=${username}
disallow=all
allow=ulaw
media_encryption=sdes
direct_media=no
force_rport=yes
rewrite_contact=yes
rtp_symmetric=yes
[${username}]
type=auth
auth_type=digest
username=${username}
password=${upstreamPassword}
realm=fixture
supported_algorithms_uac=sha-256
supported_algorithms_uas=sha-256
[${username}]
type=aor
max_contacts=${username === '1001' ? 1 : 2}
remove_existing=no
minimum_expiration=10
maximum_expiration=30
`).join(''))
  command('docker', ['run', '-d', '--name', pbx, '--network', 'sipper-platform-dev_default', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '-p', '127.0.0.1::8088', '-p', '127.0.0.1::5061', '--mount', `type=bind,src=${resolve(directory)},dst=/run/tls,readonly`,
    '--mount', `type=bind,src=${resolve(pbxConfig)},dst=/etc/asterisk,readonly`, '--entrypoint', 'asterisk', 'sipper-asterisk:22.11.0', '-f'])
  const ari = new Ari({ url: `http://127.0.0.1:${command('docker', ['port', container, '8088/tcp']).split(':').at(-1)}/ari`, password: ariPassword })
  const upstreamAri = new Ari({ url: `http://127.0.0.1:${command('docker', ['port', pbx, '8088/tcp']).split(':').at(-1)}/ari`, password: ariPassword })
  const ami = { url: `tcp://127.0.0.1:${command('docker', ['port', container, '5038/tcp']).split(':').at(-1)}`, password: amiPassword }
  async function until(check: () => Promise<boolean> | boolean, description: string, timeout = 8000) {
    for (let i = 0; i < timeout / 100; i++) { if (await check()) return; await delay(100) }
    throw new Error(`Timed out: ${description}`)
  }
  const upstreams = new Upstreams(ari, new Set([pbx]))
  const instanceId = randomUUID()
  await mkdir(join(directory, 'state'), { mode: 0o700 })
  const state = new State(join(directory, 'state', 'controller.sqlite'), instanceId, f.nodeId)
  const calls = new Calls(ari, async (method: string, path: string, body?: unknown) => {
    if (path === 'outgoing') return admitGatewayOutgoing(f.nodeId, body)
    if (path === 'calls') return incomingGatewayCall(f.nodeId, body)
    if (path.startsWith('calls/')) return gatewayCall(f.nodeId, path.slice(6), method === 'GET' ? undefined : body)
    if (path === 'transfers') return method === 'GET' ? pendingGatewayTransfers(f.nodeId, instanceId) : admitGatewayTransfer(f.nodeId, instanceId, body)
    if (path.startsWith('transfers/')) return gatewayTransfer(f.nodeId, instanceId, path.slice(10), method === 'GET' ? undefined : body)
    throw new Error('Unknown fixture API')
  }, upstreams, state)
  let timer: ReturnType<typeof setInterval> | undefined, ticking = false
  try {
    await until(async () => { try { await upstreamAri.request('GET', 'asterisk/info'); return true } catch { return false } }, 'PBX ARI startup')
    await ari.connect(); await upstreamAri.connect()
    await updateConfiguration(f.actor, f.organisation, f.configuration.id, { revision: f.configuration.revision, label: f.configuration.label, mode: 'gateway', settings: { ...f.configuration.settings, username: '1001', authUsername: '1001', domain: pbx, server: pbx, transport: 'tls', srtp: 'required', port: 5061 }, password: upstreamPassword })
    await upstreams.reconcile((await gatewayUpstreams(f.nodeId)).accounts)
    assert.equal(upstreams.errors.size, 0, 'ARI must accept all upstream objects')
    await until(() => command('docker', ['exec', container, 'asterisk', '-rx', 'pjsip show registrations']).includes('Registered'), 'upstream TLS registration', 20000)
    const routeId = [...upstreams.accounts.keys()][0]!
    assert.equal((await upstreamStatus(ami)).get(routeId), 'registered')
    await assert.rejects(upstreamStatus({ ...ami, password: randomBytes(32).toString('base64url') }))
    command('docker', ['exec', container, 'asterisk', '-rx', `pjsip send unregister ${routeId}`])
    await until(async () => (await upstreamStatus(ami)).get(routeId) === 'unregistered', 'observed upstream unregister')
    command('docker', ['exec', container, 'asterisk', '-rx', `pjsip send register ${routeId}`])
    await until(async () => (await upstreamStatus(ami)).get(routeId) === 'registered', 'observed upstream re-register', 20000)
    const rejectedUpstream = upstreamObjects({ ...(await gatewayUpstreams(f.nodeId)).accounts[0]!, id: randomUUID(), password: 'incorrect-test-password' }, new Set([pbx]))
    try {
      for (const [type, fields] of Object.entries(rejectedUpstream.objects)) await ari.put(type, rejectedUpstream.id, fields)
      // Asterisk deliberately staggers new registrations by up to ten seconds.
      await until(async () => (await upstreamStatus(ami)).get(rejectedUpstream.id) === 'failed', 'observed upstream authentication rejection', 20000)
    } finally { await upstreams.remove(rejectedUpstream.id) }
    console.log('PASS: Dynamic upstream TLS registration with separate PBX authentication.')
    console.log('PASS: Private AMI snapshots distinguish real registered, unregistered and rejected upstream states; wrong observer credentials are denied.')
    await gatewayHeartbeat(f.nodeId, { instanceId, ready: true })
    let nextHeartbeat = Date.now() + 10_000
    timer = setInterval(() => {
      if (ticking) return
      ticking = true
      void (async () => {
        if (Date.now() >= nextHeartbeat) { await gatewayHeartbeat(f.nodeId, { instanceId, ready: true }); nextHeartbeat = Date.now() + 10_000 }
        await calls.tick()
      })().finally(() => { ticking = false })
    }, 100)
    await setCallingPreference(f.actor, f.organisation, { doNotDisturb: true })
    for (const phone of phones) assert.equal(await phone.register(), 200, 'DND must preserve registration')
    const outgoing = await phones[0]!.call('2000')
    assert.match(outgoing.response, /^SIP\/2.0 200/)
    assert.match(outgoing.response, /a=crypto:/)
    if (process.env.SIPPER_ANDROID_SERIAL || process.env.SIPPER_IOS_GATEWAY || process.env.SIPPER_MACOS_GATEWAY || process.env.SIPPER_WINDOWS_GATEWAY) {
      const port = Number(command('docker', ['port', container, '5061/tcp']).split(':').at(-1))
      const contact = /<sips?:(?:[^@>;]+@)?([^>;]+)/i.exec(header(outgoing.response, 'Contact'))?.[1]
      assert.equal(contact, `127.0.0.1:${port}`, 'Gateway dialog Contact must be reachable through the native fixture forwarding')
    }
    await until(() => [...calls.calls.values()].some(c => c.connected), 'outgoing bridge')
    const outgoingCall = [...calls.calls.values()][0]!, bridge = outgoingCall.bridge
    assert.equal((await gatewayCall(f.nodeId,outgoingCall.id)).state,'answered')
    const observed = (await platform.organisationDetails(f.actor,f.organisation)).activeCalls
    assert.equal(observed.length,1); assert.equal(observed[0]!.direction,'outgoing'); assert.equal(observed[0]!.device_id,f.devices[0]!.id)
    assert.equal((await ari.request('GET', `bridges/${bridge}`)).channels.length, 2)
    const dndParent = randomUUID()
    await upstreamAri.request('POST', 'channels', undefined, { endpoint: 'PJSIP/1001', app: 'sipper', channelId: dndParent, timeout: 20, formats: 'ulaw' })
    await until(async () => (await rows("SELECT id FROM gateway_calls WHERE configuration_id=$1 AND direction='incoming' AND state='ended' AND end_reason='rejected'", [f.configuration.id])).length > 0, 'DND incoming rejection')
    await until(async () => !(await upstreamAri.request('GET','channels')).some((channel: any) => channel.id === dndParent), 'DND caller hangup')
    const rejectedCalls = await rows("SELECT state,end_reason FROM gateway_calls WHERE configuration_id=$1 AND direction='incoming'", [f.configuration.id])
    assert.ok(rejectedCalls.every(call => call.state === 'ended' && call.end_reason === 'rejected'))
    await Promise.all(phones.map(phone => assert.rejects(phone.receive(message => message.startsWith('INVITE '), 500), /SIP fixture timed out/)))
    assert.equal((await rows('SELECT 1 FROM call_recipients r JOIN gateway_calls c ON c.id=r.call_id WHERE c.configuration_id=$1', [f.configuration.id])).length, 0)
    assert.equal((await ari.request('GET', `bridges/${bridge}`)).channels.length, 2, 'DND must preserve the outgoing bridge')
    await setCallingPreference(f.actor, f.organisation, { doNotDisturb: false })
    console.log('PASS: DND preserves TLS registration and outgoing calls, rejects new upstream calls without ringing either device, and preserves the established bridge.')
    await platform.setMemberStatus(f.actor, f.organisation, f.actor.userId, 'suspended')
    await upstreams.reconcile((await gatewayUpstreams(f.nodeId)).accounts, calls.inUse)
    assert.equal((await ari.request('GET', `bridges/${bridge}`)).channels.length, 2, 'Suspension must preserve the existing conversation')
    assert.equal((await platform.organisationDetails(f.actor,f.organisation)).activeCalls[0]!.state,'answered')
    assert.notEqual(Number(/^SIP\/2.0 (\d+)/.exec((await phones[1]!.call('2000')).response)?.[1]), 200, 'Suspension must prevent a new call')
    await phones[0]!.bye(outgoing)
    await until(() => calls.calls.size === 0, 'outgoing hangup')
    await until(async () => (await gatewayCall(f.nodeId,outgoingCall.id)).state==='ended','outgoing end observation')
    await platform.setMemberStatus(f.actor, f.organisation, f.actor.userId, 'active')
    console.log('PASS: Outgoing two-leg bridge, device-owned call activity, suspension continuity and ended-call reporting.')

    const parent = randomUUID()
    await upstreamAri.request('POST', 'channels', undefined, { endpoint: 'PJSIP/1001', app: 'sipper', channelId: parent, timeout: 20, callerId: 'Fixture caller <2000>', formats: 'ulaw' })
    const incoming = await Promise.all(phones.map(phone => phone.incoming()))
    assert.ok(incoming.every(message => message.includes('a=ice-ufrag:') && message.includes('a=candidate:')), 'Gateway incoming SIP offers must include ICE candidates')
    const callIds = incoming.map(message => header(message, 'X-Sipper-Call-ID'))
    assert.ok(callIds[0], 'SIP must carry the opaque push call ID')
    assert.equal(callIds[0], callIds[1])
    await setCallingPreference(f.actor, f.organisation, { doNotDisturb: true })
    await Promise.all(phones.map((phone, index) => phone.answer(incoming[index]!)))
    await until(async () => (await gatewayCall(f.nodeId, callIds[0]!)).state === 'answered', 'single answer winner')
    const incomingCall = [...calls.calls.values()].find(c => c.id === callIds[0])!
    assert.equal((await ari.request('GET', `bridges/${incomingCall.bridge}`)).channels.length, 2, 'Only one phone can join the caller')
    await setCallingPreference(f.actor, f.organisation, { doNotDisturb: false })
    const state = await gatewayCall(f.nodeId, callIds[0]!)
    const loserIndex = f.devices.findIndex(device => device.id !== state.winnerDeviceId)
    const loserBye = await phones[loserIndex]!.receive(m => m.startsWith('BYE '))
    phones[loserIndex]!.respond(loserBye, 200)
    await upstreamAri.request('DELETE', `channels/${parent}`)
    const winnerIndex = 1 - loserIndex
    const winnerBye = await phones[winnerIndex]!.receive(m => m.startsWith('BYE '))
    phones[winnerIndex]!.respond(winnerBye, 200)
    await until(async () => (await gatewayCall(f.nodeId, callIds[0]!)).state === 'ended', 'incoming hangup recorded')
    console.log('PASS: Incoming multi-device ringing, opaque call header, one answer winner and caller hangup propagation. No audio was sent.')
    const cancelledParent = randomUUID()
    await upstreamAri.request('POST', 'channels', undefined, { endpoint: 'PJSIP/1001', app: 'sipper', channelId: cancelledParent, timeout: 20, formats: 'ulaw' })
    const ringing = await Promise.all(phones.map(phone => phone.incoming()))
    const cancelledId = header(ringing[0]!, 'X-Sipper-Call-ID')
    await upstreamAri.request('DELETE', `channels/${cancelledParent}`)
    await Promise.all(phones.map(async (phone, index) => {
      const cancel = await phone.receive(message => message.startsWith('CANCEL ') && header(message, 'Call-ID') === header(ringing[index]!, 'Call-ID'))
      phone.respond(cancel, 200); phone.respond(ringing[index]!, 487)
    }))
    await until(async () => (await gatewayCall(f.nodeId, cancelledId)).reason === 'caller_cancelled', 'caller cancellation')

    const declinedParent = randomUUID()
    await upstreamAri.request('POST', 'channels', undefined, { endpoint: 'PJSIP/1001', app: 'sipper', channelId: declinedParent, timeout: 20, formats: 'ulaw' })
    const rejected = await Promise.all(phones.map(phone => phone.incoming()))
    const rejectedId = header(rejected[0]!, 'X-Sipper-Call-ID')
    phones[0]!.respond(rejected[0]!, 486)
    await until(async () => (await gatewayCall(f.nodeId, rejectedId)).targets.length === 1, 'first phone decline recorded')
    phones[1]!.respond(rejected[1]!, 486)
    await until(async () => (await gatewayCall(f.nodeId, rejectedId)).reason === 'rejected', 'both phones declined')
    await until(() => calls.calls.size === 0, 'rejected call cleaned up')
    console.log('PASS: Caller cancellation dismisses both phones; SIP declines remove recipients without redialling them.')
    if (process.env.SIPPER_ANDROID_SERIAL || process.env.SIPPER_IOS_GATEWAY || process.env.SIPPER_MACOS_GATEWAY || process.env.SIPPER_WINDOWS_GATEWAY) {
      for (const phone of phones) assert.equal(await phone.register(undefined, 0), 200)
      let parent = ''
      let otherOffer = ''
      try {
        const smoke = process.env.SIPPER_ANDROID_SERIAL ? androidSmoke : nativeSmoke
        await smoke(f, Number(command('docker', ['port', container, '5061/tcp']).split(':').at(-1)), await readFile(join(directory, 'server.crt'), 'utf8'), async phase => {
          if (phase === 'conference-media') {
            await until(() => calls.calls.size === 0 && calls.pendingEnds.size === 0, 'native conference hangup fully reported')
            await until(async () => (await ari.request('GET', 'channels')).length === 0, 'native conference channels destroyed')
            console.log('PASS: Native mixer forwards the remote tone through the encrypted gateway to the other remote party and receives its echo; split and hangup remove the forwarding and all gateway legs.')
            return
          }
          if (['transfer-blind-media', 'transfer-attended-media'].includes(phase)) {
            await until(() => calls.calls.size === 1 && [...calls.calls.values()][0]?.transferred === true && calls.transfers.pending.size === 0, 'native transfer committed')
            const call = [...calls.calls.values()][0]!, ids = [call.parent, call.winner]
            // ARI accepts hangup before Asterisk finishes destroying the channel.
            await until(async () => {
              const live = await ari.request('GET', 'channels')
              return live.length === ids.length && live.every((channel: any) => ids.includes(channel.id))
            }, 'native transfer channel destruction')
            const channels = await ari.request('GET', 'channels')
            assert.deepEqual(channels.map((channel: any) => channel.id).sort(), [...ids].sort(), 'Only the remote legs remain after native transfer')
            assert.deepEqual((await ari.request('GET', `bridges/${call.bridge}`)).channels.sort(), [...ids].sort())
            const variable = async (id: string, name: string) => (await ari.request('GET', `channels/${id}/variable`, undefined, { variable: name })).value
            const packets = async (id: string) => ({ sent: Number(await variable(id, 'CHANNEL(rtcp,txcount)')), received: Number(await variable(id, 'CHANNEL(rtcp,rxcount)')) })
            for (const id of ids) {
              assert.equal(await variable(id, 'CHANNEL(pjsip,secure)'), '1', 'Transferred signalling remains TLS')
              assert.equal(await variable(id, 'CHANNEL(rtp,secure)'), '1', 'Transferred media remains SRTP')
              assert.equal(await variable(id, 'CHANNEL(rtp,hold)'), '0', 'The remote parties are no longer held')
            }
            const before = await Promise.all(ids.map(packets))
            await until(async () => (await Promise.all(ids.map(packets))).every((after, index) => after.sent > before[index]!.sent + 5
              && after.received > before[index]!.received + 5), 'bidirectional encrypted packets after transfer')
            const observed = (await rows('SELECT transferred_at FROM gateway_calls WHERE id=$1', [call.id]))[0]!
            assert.ok(observed.transferred_at)
            await ari.request('DELETE', `channels/${call.parent}`)
            await until(() => calls.calls.size === 0 && calls.pendingEnds.size === 0, 'remote transfer hangup fully reported')
            console.log(`PASS: ${phase}: native local legs closed; remote TLS/SRTP legs are unheld with advancing packets in both directions and complete hangup reporting.`)
            return
          }
          if (phase === 'push-answer') {
            await until(async () => (await upstreamAri.request('GET', `channels/${parent}`)).state === 'Up', 'native push answer')
            await upstreamAri.request('POST', `channels/${parent}/continue`, undefined, { context: 'fixture', extension: '2000', priority: 1 })
            return
          }
          if (['cancel-ringing', 'decline-finished', 'answer-failed-finished', 'telecom-cancel-ringing'].includes(phase)) { await upstreamAri.request('DELETE', `channels/${parent}`); return }
          if (phase === 'other-device-ringing') {
            const id = header(otherOffer, 'X-Sipper-Call-ID')
            await deviceCall(f.actor, f.devices[0]!.id, id, 'answer')
            await phones[0]!.answer(otherOffer)
            await until(async () => (await gatewayCall(f.nodeId, id)).state === 'answered', 'other device answer')
            assert.equal((await gatewayCall(f.nodeId, id)).winnerDeviceId, f.devices[0]!.id)
            await upstreamAri.request('DELETE', `channels/${parent}`)
            phones[0]!.respond(await phones[0]!.receive(message => message.startsWith('BYE ')), 200)
            assert.equal(await phones[0]!.register(undefined, 0), 200)
            return
          }
          assert.ok(['push-wake', 'answer', 'cancel', 'decline', 'other-device', 'answer-failed', 'telecom-answer', 'telecom-cancel'].includes(phase))
          await until(() => calls.calls.size === 0, `native call teardown before ${phase}`)
          if (phase === 'other-device') assert.equal(await phones[0]!.register(), 200)
          parent = randomUUID()
          await upstreamAri.request('POST', 'channels', undefined, { endpoint: 'PJSIP/1001', app: 'sipper', channelId: parent, timeout: 20, callerId: 'Fixture caller <2000>', formats: 'ulaw' })
          if (phase === 'push-wake') {
            let snapshot: Awaited<ReturnType<typeof gatewayCall>> | undefined
            await until(async () => {
              const call = [...calls.calls.values()].find(call => call.incoming)
              if (!call) return false
              try { snapshot = await gatewayCall(f.nodeId, call.id); return snapshot.state === 'ringing' } catch { return false }
            }, 'call queued for native push wake')
            return { callId: snapshot!.id, expiresAt: new Date(snapshot!.expiresAt).toISOString() }
          }
          if (phase === 'other-device') otherOffer = await phones[0]!.incoming()
          if (phase === 'answer' || phase === 'telecom-answer') {
            await until(async () => (await upstreamAri.request('GET', `channels/${parent}`)).state === 'Up', 'native answer')
            await upstreamAri.request('POST', `channels/${parent}/continue`, undefined, { context: 'fixture', extension: '2000', priority: 1 })
          }
        })
        try { await until(() => calls.calls.size === 0, 'native calls cleaned up') }
        catch (error) {
          const live = new Map((await ari.request('GET', 'channels')).map((channel: any) => [channel.id, channel.state]))
          console.error('Native cleanup diagnostics:', [...calls.calls.values()].map(call => ({
            incoming: call.incoming, connected: call.connected, parentGone: call.parentGone,
            ended: call.ended, reason: call.endReason, parent: live.get(call.parent),
            winner: live.get(call.winner), legs: [...call.legs.keys()].map(id => live.get(id) ?? 'Gone'),
          })))
          throw error
        }
      } finally {
        if (parent) await upstreamAri.request('DELETE', `channels/${parent}`).catch(() => {})
        for (const phone of phones) assert.equal(await phone.register(), 200)
      }
    }

    await providerSmoke({ari,upstreamAri,upstreams,calls,phones,fixture:f,pbx,directory,upstreamPassword,command})
  } catch (error) {
    console.error(command('docker', ['logs', '--tail', '30', pbx]))
    console.error(command('docker', ['exec', container, 'asterisk', '-rx', 'pjsip show registrations']))
    throw error
  } finally {
    clearInterval(timer)
    for (const call of calls.calls.values()) await calls.end(call, 'failed')
    await calls.tick()
    for (const id of upstreams.accounts.keys()) await upstreams.remove(id)
    await releaseGatewayController(f.nodeId, instanceId)
    state.close()
    ari.close(); upstreamAri.close()
    const logs = command('docker', ['logs', container])
    assert.ok(!logs.includes(upstreamPassword), 'Gateway logs must not contain upstream credentials')
    assert.ok(!logs.includes('Query Failed'), 'Gateway queries must succeed without attempting writes to device views')
  }
  await processSmoke({ ari, upstreamAri, phones, fixture: f, upstreamHost: pbx, ariPassword, ami, container, directory, command, reconnectPhones })
  assert.ok(!command('docker', ['logs', container]).includes(upstreamPassword), 'Standalone gateway logs must omit upstream credentials')
}
