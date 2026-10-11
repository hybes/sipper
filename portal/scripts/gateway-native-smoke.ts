// Isolated native clients, real SIP gateway, fictional identity. No host trust-store changes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { getPool } from '../server/lib/db'
import * as platform from '../server/lib/platform'
import { clientOrganisations, reportDevice } from '../server/lib/devices'
import { deviceCall } from '../server/lib/mobile-calls'
import { safeFailure } from '../server/lib/http'
import type { gatewayFixture } from '../tests/gateway-fixture'

export async function nativeSmoke(f: Awaited<ReturnType<typeof gatewayFixture>>, port: number, certificate: string,
  incoming: (phase: string) => Promise<{ callId: string; expiresAt: string } | void>) {
  const platformName = process.env.SIPPER_WINDOWS_GATEWAY === '1' ? 'windows' : process.env.SIPPER_MACOS_GATEWAY === '1' ? 'macos' : 'ios'
  assert.equal(process.env[`SIPPER_${platformName.toUpperCase()}_GATEWAY`], '1')
  const logPath = `/tmp/sipper-${platformName}-gateway-test.log`
  async function run(program: string, args: string[], timeout = 30_000, environment: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...environment } })
      let output = ''
      const log = program === 'xcodebuild' || program === process.execPath ? createWriteStream(logPath, { mode: 0o600 }) : undefined
      const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
      child.stdout.on('data', bytes => { output += bytes.toString(); log?.write(bytes) })
      child.stderr.on('data', bytes => { output += bytes.toString(); log?.write(bytes) })
      child.on('error', error => { clearTimeout(timer); log?.end(); reject(error) })
      child.on('exit', code => { clearTimeout(timer); if (log) log.end(() => resolve({ code, output })); else resolve({ code, output }) })
    })
  }
  const device = await platform.enrolDevice(f.actor, f.organisation, { installationId: randomUUID(), name: `Isolated native ${platformName}`, platform: platformName, appVersion: 'test', osVersion: 'test' })
  await getPool().query('UPDATE gateway_nodes SET port=$2 WHERE id=$1', [f.nodeId, port])
  const token = randomBytes(32).toString('base64url'), actions: string[] = []
  const api = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) { body += chunk.toString(); assert.ok(body.length <= 65536) }
      assert.equal(request.headers.authorization, `Bearer ${token}`)
      const path = request.url?.toLowerCase(), method = request.method
      let result: unknown
      if (method === 'GET' && path === '/api/client/organisations') result = await clientOrganisations(f.actor)
      else if (method === 'POST' && path === `/api/client/organisations/${f.organisation}/devices`) result = device
      else if (method === 'GET' && path === `/api/client/devices/${device.id}/configuration`) result = await platform.provisionDevice(f.actor, device.id)
      else if (method === 'POST' && path === `/api/client/devices/${device.id}/report`) { actions.push('report'); result = await reportDevice(f.actor, device.id, JSON.parse(body)) }
      else {
        const match = /^\/api\/client\/devices\/([a-f0-9-]{36})\/calls\/([a-f0-9-]{36})(?:\/(wake|answer|decline))?$/.exec(path ?? '')
        assert.equal(match?.[1], device.id)
        const action = match![3] ?? 'status'
        assert.equal(method, action === 'status' ? 'GET' : 'POST')
        actions.push(action)
        result = await deviceCall(f.actor, device.id, match![2]!, action as 'status' | 'wake' | 'answer' | 'decline')
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    } catch (error) {
      const failure = safeFailure(error)
      console.error('Native fixture API failure:', failure.statusCode, failure.code)
      response.writeHead(failure.statusCode, { 'content-type': 'application/json' }); response.end(JSON.stringify(failure))
    }
  })
  const directory = await mkdtemp(join(tmpdir(), `sipper-${platformName}-gateway-`))
  const source = join(directory, 'fixture.json'), ready = join(directory, 'phase'), push = join(directory, 'push.json'), completed = join(directory, 'completed-phase')
  let simulator: string | undefined
  try {
    if (platformName === 'ios') {
      const inventory = await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])
      assert.equal(inventory.code, 0)
      const entries = Object.entries(JSON.parse(inventory.output).devices as Record<string, { name: string; deviceTypeIdentifier: string }[]>)
      const template = entries.flatMap(([runtime, devices]) => devices.filter(device => device.name === 'Sipper iOS QA').map(device => ({ runtime, ...device })))
      assert.equal(template.length, 1, 'Create a dedicated Sipper iOS QA simulator before running the gateway check')
      const created = await run('xcrun', ['simctl', 'create', `Sipper Gateway Test ${randomUUID()}`, template[0]!.deviceTypeIdentifier, template[0]!.runtime])
      assert.equal(created.code, 0)
      simulator = created.output.trim()
      assert.match(simulator, /^[A-F0-9-]{36}$/)
      assert.equal((await run('xcrun', ['simctl', 'boot', simulator])).code, 0)
      const booted = await run('xcrun', ['simctl', 'bootstatus', simulator, '-b'], 180_000)
      assert.equal(booted.code, 0, 'The disposable simulator must finish first-boot setup before installing the test runner')
    }
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
    await writeFile(source, JSON.stringify({ origin, token, certificate, ready, push, completed }), { mode: 0o600 })
    const generated = platformName === 'windows' ? await run('bash', [resolve('../windows/engine/build-macos.sh')])
      : await run('xcodegen', ['generate', '--spec', resolve(platformName === 'ios' ? '../ios/project.yml' : '../project.yml')])
    assert.equal(generated.code, 0)
    let finished = false
    const test = (platformName === 'windows'
      ? run(process.execPath, ['--test', '--test-reporter=spec', resolve('../windows/tests/integration/gateway.test.mjs')], 180_000, { SIPPER_TEST_GATEWAY_FILE: source })
      : run('xcodebuild', ['-project', resolve(platformName === 'ios' ? '../ios/SipperIOS.xcodeproj' : '../Sipper.xcodeproj'), '-scheme', platformName === 'ios' ? 'SipperIOS' : 'Sipper',
      '-configuration', 'Debug', '-destination', platformName === 'ios' ? `platform=iOS Simulator,id=${simulator}` : 'platform=macOS',
      '-derivedDataPath', resolve(platformName === 'ios' ? '../ios/DerivedData' : '../build/DerivedData'),
      '-parallel-testing-enabled', 'NO', '-collect-test-diagnostics', 'never',
      `-only-testing:${platformName === 'ios' ? 'SipperIOSTests/GatewayIntegrationTests' : 'SipperTests/ManagedGatewayIntegrationTests'}`,
      ...(platformName === 'ios' ? ['CODE_SIGNING_ALLOWED=NO'] : ['CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_REQUIRED=NO']),
      `SIPPER_TEST_GATEWAY_FILE=${source}`, 'test'], 300_000))
      .then(result => ({ ...result, error: null }), error => ({ code: null, output: '', error }))
      .finally(() => { finished = true })
    const phases = new Set<string>()
    let phaseError: unknown
    while (!finished) {
      const phase = (await readFile(ready, 'utf8').catch(() => '')).trim()
      if (phase && !phases.has(phase) && !phaseError) {
        phases.add(phase)
        try {
          const call = await incoming(phase)
          if (call) await writeFile(push, JSON.stringify({ aps: {}, sipper: { schemaVersion: 1, deviceId: device.id, ...call } }), { mode: 0o600 })
          await writeFile(completed, phase, { mode: 0o600 })
        } catch (error) { phaseError = error }
      }
      await delay(100)
    }
    const result = await test
    await writeFile(logPath, `Phases: ${[...phases].join(', ')}\n${result.output}`, { mode: 0o600 })
    if (result.error) throw result.error
    if (phaseError) throw phaseError
    assert.equal(result.code, 0, `Native gateway test failed; inspect ${logPath}`)
    assert.match(result.output, platformName === 'windows' ? /tests 1\s+[ℹ ]*suites 0\s+[ℹ ]*pass 1/ : /Executed 1 test, with 0 failures/)
    assert.deepEqual([...phases], ['conference-media', 'transfer-blind-media', 'transfer-attended-media',
      ...(platformName === 'ios' ? ['push-wake', 'push-answer'] : []), 'answer', 'cancel', 'cancel-ringing', 'decline', 'decline-finished', 'other-device', 'other-device-ringing', 'answer-failed', 'answer-failed-finished'])
    assert.ok(['status', platformName === 'ios' ? 'wake' : 'report', 'answer', 'decline'].every(action => actions.includes(action)))
    if (platformName !== 'windows') {
      const expectedAnswers = platformName === 'ios' ? 3 : 1
      assert.equal(actions.filter(action => action === 'answer').length, expectedAnswers,
        'Only live incoming offers may reserve an answer; cancelled, declined and failed SIP offers must not call the answer API')
      console.log(`PASS: Native ${platformName} made exactly ${expectedAnswers} live-offer answer request${expectedAnswers === 1 ? '' : 's'}; ended offers made none.`)
    }
    if (platformName === 'macos') console.log('PASS: Mac cancels stale recovery, preserves encrypted media through three recoveries and a fourth after withdrawal, permits only zero-expiry unregister retries, and preserves verified caller details across queued native updates.')
    if (platformName === 'windows') console.log('PASS: Windows AppState/C engine cancels recovery on sleep, keeps wake offline without a path, and preserves encrypted media through three recoveries plus one after withdrawal without reviving registration. Blind/attended transfers close only their captured device legs while remote encrypted media continues. Events are injected on macOS; Windows notification APIs remain unverified.')
    console.log(`PASS: Native ${platformName} verified TLS/SHA-256, outgoing/incoming SRTP/ICE packets, withdrawal continuity, authenticated caller/answer, cancellation, decline, another-device answer and failed-answer cleanup.${platformName === 'ios' ? ' Three network recoveries and a fourth after lease expiry preserve encrypted media without reviving withdrawn registration. Opaque push wake and CallKit placeholder/offer merge also passed.' : ' AppState call controls and configuration acknowledgement exercised.'} Identity uses a fixture; system UI, real push and physical audio are not tested.${platformName === 'windows' ? ' Windows engine runs on macOS here; Schannel, DPAPI and packaged Windows execution still need Windows verification.' : ''}`)
  } finally {
    let removed = true
    if (simulator) {
      await run('xcrun', ['simctl', 'shutdown', simulator])
      removed = (await run('xcrun', ['simctl', 'delete', simulator])).code === 0
    }
    await new Promise<void>(resolve => api.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    assert.ok(removed, 'The disposable gateway simulator could not be removed')
  }
}
