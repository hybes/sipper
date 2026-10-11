// Optional native leg of the disposable gateway test. Never selects a real phone.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { getPool } from '../server/lib/db'
import * as platform from '../server/lib/platform'
import { clientOrganisations } from '../server/lib/devices'
import { deviceCall } from '../server/lib/mobile-calls'
import { safeFailure } from '../server/lib/http'
import type { gatewayFixture } from '../tests/gateway-fixture'

export async function androidSmoke(f: Awaited<ReturnType<typeof gatewayFixture>>, port: number, certificate: string,
  incoming: (phase: string) => Promise<{ callId: string; expiresAt: string } | void>) {
  const serial = process.env.SIPPER_ANDROID_SERIAL
  if (!serial) return
  const nativeConference = process.env.SIPPER_ANDROID_NATIVE_CONFERENCE === '1'
  assert.match(serial, /^emulator-\d+$/, 'Gateway tests may use only a disposable emulator')
  const adb = process.env.SIPPER_TEST_ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
  async function run(args: string[], input?: string) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(adb, ['-s', serial!, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
      child.stdout.on('data', bytes => { output += bytes.toString() })
      child.stderr.on('data', () => {}) // Never include command diagnostics with fixture data.
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`Android fixture command failed (${code})`)) })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    })
  }
  assert.equal((await run(['emu', 'avd', 'name'])).split(/\r?\n/)[0], 'SipperUIQA', 'Use the existing isolated Sipper emulator')
  const pkg = 'com.hybes.sipper.android.development'
  await run(['install', '-r', resolve('../android/app/build/outputs/apk/debug/app-debug.apk')])
  await run(['install', '-r', resolve('../android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')])
  if (!nativeConference) {
    const permissions = await run(['shell', 'dumpsys', 'package', pkg])
    for (const permission of ['android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS']) {
      assert.ok(permissions.includes(`${permission}: granted=true`),
        `Allow ${permission} for Sipper through Android Settings on SipperUIQA before this test; the harness does not change permissions`)
    }
  }
  const device = await platform.enrolDevice(f.actor, f.organisation, { installationId: randomUUID(), name: 'Isolated native Android', platform: 'android', appVersion: 'test', osVersion: 'test' })
  await getPool().query('UPDATE gateway_nodes SET port=$2 WHERE id=$1', [f.nodeId, port])
  const configuration = await platform.provisionDevice(f.actor, device.id)
  const existing = await run(['reverse', '--list'])
  assert.ok(!existing.includes(`tcp:${port}`), 'Do not replace an existing emulator reverse mapping')
  // The OAuth provider is a local protocol fixture. Call/provisioning requests use
  // the real service functions and the fixture's actual device/tenant bindings.
  const token = randomBytes(32).toString('base64url'), code = randomBytes(32).toString('base64url')
  const actions: string[] = []
  let origin = ''
  const api = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) { body += chunk.toString(); assert.ok(body.length <= 65536) }
      const path = request.url, method = request.method
      let result: unknown
      if (method === 'POST' && path === '/api/auth/oauth2/token') {
        const form = new URLSearchParams(body)
        assert.equal(form.get('code'), code); assert.ok(form.get('code_verifier'))
        assert.equal(form.get('resource'), `${origin}/api/client`)
        result = { access_token: token, refresh_token: randomBytes(32).toString('base64url'), token_type: 'Bearer', expires_in: 3600 }
      } else {
        assert.equal(request.headers.authorization, `Bearer ${token}`)
        if (method === 'GET' && path === '/api/client/organisations') result = await clientOrganisations(f.actor)
        else if (method === 'POST' && path === `/api/client/organisations/${f.organisation}/devices`) result = device
        else if (method === 'GET' && path === `/api/client/devices/${device.id}/configuration`) result = await platform.provisionDevice(f.actor, device.id)
        else {
          const match = /^\/api\/client\/devices\/([a-f0-9-]{36})\/calls\/([a-f0-9-]{36})(?:\/(wake|answer|decline))?$/.exec(path ?? '')
          assert.equal(match?.[1], device.id)
          const action = match![3] ?? 'status'
          assert.equal(method, action === 'status' ? 'GET' : 'POST')
          actions.push(action)
          result = await deviceCall(f.actor, device.id, match![2]!, action as 'status' | 'wake' | 'answer' | 'decline')
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    } catch (error) {
      const failure = safeFailure(error)
      response.writeHead(failure.statusCode, { 'content-type': 'application/json' }); response.end(JSON.stringify(failure))
    }
  })
  const reversed: number[] = []
  try {
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
    const apiPort = (api.address() as { port: number }).port
    origin = `http://127.0.0.1:${apiPort}`
    assert.ok(!existing.includes(`tcp:${apiPort}`), 'Do not replace an existing emulator reverse mapping')
    for (const value of [port, apiPort]) { await run(['reverse', `tcp:${value}`, `tcp:${value}`]); reversed.push(value) }
    await run(['shell', 'run-as', pkg, 'rm', '-f', 'files/gateway-incoming-ready', 'files/gateway-phase-completed', 'files/gateway-push.json'])
    await run(['shell', `run-as ${pkg} sh -c 'umask 077; mkdir -p files; cat > files/gateway-test.json'`], JSON.stringify({ configuration, certificate, origin, code }))
    let finished = false
    const method = nativeConference ? 'nativeConferenceForwardsEncryptedRemoteAudioAndClearsItOnSplit' : 'managedGatewayAuthenticatesAndReconcilesIncomingCalls'
    const instrument = run(['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', `com.hybes.sipper.GatewayTest#${method}`, '-e', 'sipperGateway', nativeConference ? 'native-conference' : 'isolated', `${pkg}.test/androidx.test.runner.AndroidJUnitRunner`])
      .then(output => ({ output, error: null }), error => ({ output: '', error }))
      .finally(() => { finished = true })
    const phases = new Set<string>()
    try {
      while (!finished) {
        const phase = (await run(['shell', 'run-as', pkg, 'cat', 'files/gateway-incoming-ready']).catch(() => '')).trim()
        if (phase && !phases.has(phase)) {
          phases.add(phase)
          const push = await incoming(phase)
          if (push) await run(['shell', `run-as ${pkg} sh -c 'umask 077; cat > files/gateway-push.json.tmp; mv files/gateway-push.json.tmp files/gateway-push.json'`],
            JSON.stringify({ type: 'incoming_call', schemaVersion: '1', deviceId: device.id, ...push }))
          await run(['shell', `run-as ${pkg} sh -c 'umask 077; cat > files/gateway-phase-completed.tmp; mv files/gateway-phase-completed.tmp files/gateway-phase-completed'`], phase)
        }
        await delay(100)
      }
    } catch (error) {
      await run(['shell', 'am', 'force-stop', pkg])
      const result = await instrument
      await writeFile('/tmp/sipper-android-gateway-test.log', `Phases: ${[...phases].join(', ')}\n${result.output}`, { mode: 0o600 })
      throw error
    }
    const { output, error } = await instrument
    await writeFile('/tmp/sipper-android-gateway-test.log', `Phases: ${[...phases].join(', ')}\n${output}`, { mode: 0o600 })
    if (error) throw error
    assert.ok(/OK \(1 test\)/.test(output), 'Native gateway test failed; inspect /tmp/sipper-android-gateway-test.log')
    if (nativeConference) {
      assert.deepEqual([...phases], ['conference-media'])
      assert.deepEqual(actions, [])
      console.log('PASS: Native Android conference forwards the remote tone through the encrypted Opus/SRTP/ICE gateway to the echo party while local audio is silent and muted. Shared hold/resume restores the tone; split removes forwarding and hangup clears all gateway legs. This mode does not use Core-Telecom, microphone/notification permissions, OAuth, push or physical audio; the full Android gateway check still requires consent.')
      return
    }
    assert.deepEqual([...phases], ['push-wake', 'push-answer', 'answer', 'cancel', 'cancel-ringing', 'decline', 'decline-finished', 'other-device', 'other-device-ringing', 'answer-failed', 'answer-failed-finished', 'transfer-blind-media', 'transfer-attended-media', 'telecom-answer', 'telecom-cancel', 'telecom-cancel-ringing'])
    assert.ok(['status', 'wake', 'answer', 'decline'].every(action => actions.includes(action)), 'Native call controls must reach the device API')
    console.log('PASS: Native Android TLS/SHA-256, Opus/SRTP/ICE, three network recoveries plus one after expiry with fresh SDP and advancing bidirectional media, synthetic push wake, authenticated call claims and cancellation. Blind/attended transfers preserve remote encrypted media and clear local Core-Telecom sessions and notifications. Real Core-Telecom outgoing/incoming sessions, app answer/hold/hangup, private call notifications and remote-cancellation cleanup pass. OAuth and push arrival use fixtures; physical audio, system UI interaction and FCM delivery are not tested.')
  } finally {
    await run(['shell', 'run-as', pkg, 'rm', '-f', 'files/gateway-test.json', 'cache/gateway-test-ca.pem', 'files/gateway-incoming-ready', 'files/gateway-phase-completed', 'files/gateway-phase-completed.tmp', 'files/gateway-push.json', 'files/gateway-push.json.tmp']).catch(() => {})
    for (const value of reversed) await run(['reverse', '--remove', `tcp:${value}`]).catch(() => {})
    await new Promise<void>(resolve => api.close(() => resolve()))
  }
}
