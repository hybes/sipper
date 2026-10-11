// An isolated real SIP/TLS test. Never points to the user's PBX or live devices.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tls from 'node:tls'
import net from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { getPool } from '../server/lib/db'
import * as platform from '../server/lib/platform'
import { Phone } from './gateway-sip-fixture'
import { callSmoke } from './gateway-call-smoke'
import { gatewayFixture } from '../tests/gateway-fixture'
import { Ari } from '../../gateway/src/ari.mjs'
import { observeRegistration } from '../../gateway/src/registrations.mjs'

process.env.DATABASE_URL = process.env.SIPPER_TEST_DATABASE_URL ?? 'postgresql://sipper:sipper_local_only@127.0.0.1:5547/sipper_test'
process.env.SIPPER_GATEWAY_ID = `smoke-${randomUUID()}`
process.env.SIPPER_GATEWAY_PUBLIC_HOST = 'localhost'
process.env.SIPPER_GATEWAY_PUBLIC_PORT = process.env.SIPPER_ANDROID_SERIAL || process.env.SIPPER_IOS_GATEWAY || process.env.SIPPER_MACOS_GATEWAY || process.env.SIPPER_WINDOWS_GATEWAY ? '25061' : '5061'
assert.ok(new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/sipper_test', 'Use the isolated compose database')
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'Use the local isolated database')
const directory = await mkdtemp(join(tmpdir(), 'sipper-gateway-test-'))
const container = `sipper-gateway-test-${randomBytes(6).toString('hex')}`
const pbx = `${container}-pbx`, ariPassword = randomBytes(32).toString('base64url'), amiPassword = randomBytes(32).toString('base64url')
const role = `sipper_gateway_test_${randomBytes(6).toString('hex')}`, dbPassword = randomBytes(32).toString('base64url')
let f: Awaited<ReturnType<typeof gatewayFixture>> | undefined, roleCreated = false, transferViewCreated = false
const transferView = `${role}_endpoints`
const sockets: tls.TLSSocket[] = []
function command(program: string, args: string[]) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr?.slice(-2000) ?? result.error?.message}`)
  return result.stdout.trim()
}

try {
  await chmod(directory, 0o755)
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.crt'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'extendedKeyUsage=serverAuth', '-addext', `subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:${pbx}`])
  // Fictional one-use fixture key, readable by the non-root container UID.
  await chmod(join(directory, 'server.key'), 0o644)
  f = await gatewayFixture()
  const configs = await Promise.all(f.devices.map(device => platform.provisionDevice(f!.actor, device.id)))
  await getPool().query(`CREATE ROLE ${role} LOGIN PASSWORD '${dbPassword}'`); roleCreated = true
  await getPool().query(`GRANT CONNECT ON DATABASE sipper_test TO ${role}`)
  await getPool().query(`GRANT USAGE ON SCHEMA public TO ${role}`)
  await getPool().query(`GRANT SELECT ON gateway_ps_endpoints,gateway_ps_auths,gateway_ps_aors TO ${role}`)
  // Enable REFER only in this disposable gateway. The normal application view
  // remains disabled until native transfer controls and media checks are ready.
  const fields = (await getPool().query('SELECT * FROM gateway_ps_endpoints LIMIT 0')).fields
    .filter(field => field.name !== 'allow_transfer').map(field => `e."${field.name.replaceAll('"', '""')}"`).join(',')
  await getPool().query(`CREATE VIEW ${transferView} AS SELECT ${fields},'yes'::text AS allow_transfer,
    'PJSIP_TRANSFER_HANDLING()=ari-only'::text AS set_var FROM gateway_ps_endpoints e
    JOIN gateway_credentials g ON g.username=e.id WHERE g.gateway_id='${f.nodeId.replaceAll("'", "''")}'`)
  transferViewCreated = true
  await getPool().query(`GRANT SELECT ON ${transferView} TO ${role}`)
  await writeFile(join(directory, 'extconfig.conf'), (await readFile(new URL('../../gateway/asterisk/config/extconfig.conf', import.meta.url), 'utf8'))
    .replace('gateway_ps_endpoints', transferView))
  const restrictedUrl = new URL(process.env.DATABASE_URL!); restrictedUrl.username = role; restrictedUrl.password = dbPassword
  const restricted = new pg.Client({ connectionString: restrictedUrl.href })
  await restricted.connect()
  try {
    assert.equal((await restricted.query('SELECT id FROM gateway_ps_auths')).rowCount, 2)
    for (const table of ['sip_configurations', 'gateway_credentials', 'auth_user', 'gateway_nodes']) await assert.rejects(restricted.query(`SELECT * FROM ${table}`), (error: any) => error.code === '42501')
  } finally { await restricted.end() }
  assert.ok([process.env.SIPPER_ANDROID_SERIAL, process.env.SIPPER_IOS_GATEWAY, process.env.SIPPER_MACOS_GATEWAY, process.env.SIPPER_WINDOWS_GATEWAY].filter(Boolean).length <= 1, 'Run one native platform at a time')
  const nativeMedia = Boolean(process.env.SIPPER_ANDROID_SERIAL || process.env.SIPPER_IOS_GATEWAY || process.env.SIPPER_MACOS_GATEWAY || process.env.SIPPER_WINDOWS_GATEWAY)
  let mediaEnvironment = ''
  if (nativeMedia) {
    const subnet = command('docker', ['network', 'inspect', 'sipper-platform-dev_default', '--format', '{{(index .IPAM.Config 0).Subnet}}'])
    const bridge = command('docker', ['network', 'inspect', 'sipper-platform-dev_default', '--format', '{{(index .IPAM.Config 0).Gateway}}'])
    // Docker forwards the emulator's TLS connection from the bridge address.
    // Treat that peer as external, while the PBX container remains local. Otherwise
    // SDP's default address stays private and no longer matches its ICE candidate.
    const local = command('python3', ['-c', 'import ipaddress,sys; network=ipaddress.ip_network(sys.argv[1]); peer=ipaddress.ip_network(sys.argv[2]); print(",".join(str(part) for part in network.address_exclude(peer)))', subnet, `${bridge}/32`])
    const publicMediaIP = process.env.SIPPER_ANDROID_SERIAL ? '10.0.2.2' : '127.0.0.1'
    mediaEnvironment = `SIPPER_MEDIA_PUBLIC_IP=${publicMediaIP}\nSIPPER_MEDIA_LOCAL_NETWORKS=${local}\nSIPPER_RTP_START=27000\nSIPPER_RTP_END=27031\nSIPPER_SIGNAL_PUBLIC_IP=127.0.0.1\nSIPPER_SIGNAL_PUBLIC_PORT=25061\n`
  }
  await writeFile(join(directory, 'container.env'), `SIPPER_DB_HOST=postgres\nSIPPER_DB_PORT=5432\nSIPPER_DB_NAME=sipper_test\nSIPPER_DB_USER=${role}\nSIPPER_DB_PASSWORD=${dbPassword}\nPGSSLMODE=disable\nSIPPER_UPSTREAM_CA_FILE=/run/tls/server.crt\nSIPPER_ARI_PASSWORD=${ariPassword}\nSIPPER_ARI_BIND=0.0.0.0\nSIPPER_AMI_PASSWORD=${amiPassword}\nSIPPER_AMI_BIND=0.0.0.0\n${mediaEnvironment}`, { mode: 0o600 })
  // Explicit ephemeral bindings survive stop/start; Docker's empty HostPort
  // mappings may allocate different ports when the same container restarts.
  const reservations=Array.from({length:3},()=>net.createServer()), ports:number[]=[]
  for(const server of reservations) {server.listen(0,'127.0.0.1');await once(server,'listening');ports.push((server.address() as net.AddressInfo).port)}
  await Promise.all(reservations.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))))
  command('docker', ['run', '-d', '--name', container, '--network', 'sipper-platform-dev_default', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '-p', `127.0.0.1:${nativeMedia ? 25061 : ports[0]}:5061`, '-p', `127.0.0.1:${ports[1]}:8088`, '-p', `127.0.0.1:${ports[2]}:5038`, ...(nativeMedia ? ['-p', '127.0.0.1:27000-27031:27000-27031/udp'] : []), '--env-file', join(directory, 'container.env'), '--mount', `type=bind,src=${resolve(directory)},dst=/run/tls,readonly`,
    '--mount', `type=bind,src=${resolve(directory, 'extconfig.conf')},dst=/etc/asterisk/extconfig.conf,readonly`, 'sipper-asterisk:22.11.0'])
  const port = Number(command('docker', ['port', container, '5061/tcp']).split(':').at(-1))
  const ca = await readFile(join(directory, 'server.crt'))
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = spawnSync('docker', ['exec', container, 'asterisk', '-rx', 'pjsip show transports'], { encoding: 'utf8', timeout: 5000 })
    if (result.status === 0 && result.stdout.includes('sipper-tls')) { ready = true; break }
    await delay(250)
  }
  assert.ok(ready, 'Asterisk did not initialise its TLS transport')
  command('docker', ['exec', container, 'asterisk', '-rx', 'core waitfullybooted'])
  assert.match(command('docker', ['exec', container, 'asterisk', '-rx', 'module show like codec_opus_open_source.so']), /\bRunning\b/, 'The Opus transcoder must be loaded, not just installed')
  const phones = []
  const ariPort = Number(command('docker', ['port', container, '8088/tcp']).split(':').at(-1))
  const registrationAri = new Ari({ url: `http://127.0.0.1:${ariPort}/ari`, password: ariPassword })
  const endpoint = configs[0]!.accounts[0]!.settings.username
  assert.equal((await observeRegistration(registrationAri, endpoint)).state, 'unregistered')
  for (const config of configs) {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca, minVersion: 'TLSv1.2' })
    sockets.push(socket); await once(socket, 'secureConnect')
    assert.equal(socket.authorized, true)
    phones.push(new Phone(socket, config.accounts[0]!))
  }
  assert.equal(await phones[0]!.register(), 200)
  assert.equal(await phones[1]!.register(), 200)
  const observed = await observeRegistration(registrationAri, endpoint)
  assert.equal(observed.state, 'registered')
  assert.equal(observed.ip, command('docker', ['network', 'inspect', 'sipper-platform-dev_default', '--format', '{{(index .IPAM.Config 0).Gateway}}']), 'Report the received peer, not the phone Contact/Via address')
  assert.equal(await phones[0]!.register(undefined, 0), 200)
  assert.deepEqual({ ...(await observeRegistration(registrationAri, endpoint)), observedAt: '' }, { endpoint, state: 'unregistered', ip: null, observedAt: '' })
  assert.equal(await phones[0]!.register(), 200)
  console.log('PASS: ARI contact snapshots follow real SIP registration/unregistration and expose the received peer IP.')
  assert.notEqual(await phones[0]!.register('incorrect-fixture-password'), 200)
  await platform.setMemberStatus(f.actor, f.organisation, f.actor.userId, 'suspended')
  assert.notEqual(await phones[0]!.register(), 200)
  assert.notEqual(await phones[1]!.register(), 200)
  await platform.setMemberStatus(f.actor, f.organisation, f.actor.userId, 'active')
  assert.equal(await phones[0]!.register(), 200)
  assert.equal(await phones[1]!.register(), 200)
  const reconnectPhones = async () => {
    const replacements = [];
    for (const config of configs) {
      const socket = tls.connect({host:'127.0.0.1',port,servername:'localhost',ca,minVersion:'TLSv1.2'})
      sockets.push(socket); await once(socket,'secureConnect'); assert.equal(socket.authorized,true)
      replacements.push(new Phone(socket,config.accounts[0]!))
    }
    phones.splice(0,phones.length,...replacements)
  }
  await callSmoke({ directory, pbx, container, ariPassword, amiPassword, phones, fixture: f, command, reconnectPhones })
  await platform.revokeDevice(f.actor, f.organisation, f.devices[0]!.id)
  assert.notEqual(await phones[0]!.register(), 200)
  assert.equal(await phones[1]!.register(), 200)
  await getPool().query("UPDATE gateway_nodes SET ready_until=now()-interval '1 second' WHERE id=$1", [f.nodeId])
  assert.notEqual(await phones[1]!.register(), 200)
  console.log('PASS: TLS + SHA-256 SIP registration, wrong-password rejection, live suspension/resume, per-device revocation, expired readiness, restricted database role.')
} catch (error) {
  const log = spawnSync('docker', ['logs', '--tail', '25', container], { encoding: 'utf8', timeout: 5000 })
  console.error((log.stdout + log.stderr).split('\n').filter(line => !/Authorization:|crypto:|nonce=/i.test(line)).join('\n'))
  throw error
} finally {
  for (const socket of sockets) socket.destroy()
  spawnSync('docker', ['rm', '-f', container, pbx], { stdio: 'ignore', timeout: 30_000 })
  if (f) await f.cleanup()
  if (transferViewCreated) await getPool().query(`DROP VIEW ${transferView}`)
  if (roleCreated) { await getPool().query(`DROP OWNED BY ${role}`); await getPool().query(`DROP ROLE ${role}`) }
  await getPool().end()
  await rm(directory, { recursive: true, force: true })
}
