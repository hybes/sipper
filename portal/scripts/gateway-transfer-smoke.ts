// Scoped real REFER/NOTIFY and bridge checks. The shared device view stays disabled.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { rows } from '../server/lib/db'
import type { gatewayFixture } from '../tests/gateway-fixture'
import { Phone } from './gateway-sip-fixture'
import { Ari } from '../../gateway/src/ari.mjs'

export async function transferSmoke(ari: Ari, phones: Phone[], f: Awaited<ReturnType<typeof gatewayFixture>>, recover: () => Promise<void>) {
  async function until(check: () => Promise<boolean>, label: string) {
    for (let i = 0; i < 150; i++) { if (await check()) return; await delay(100) }
    throw new Error(`Timed out: ${label}`)
  }
  const endpoints = await rows(`SELECT e.* FROM gateway_ps_endpoints e JOIN gateway_credentials g ON g.username=e.id
    WHERE g.gateway_id=$1 AND g.device_id=ANY($2::uuid[])`, [f.nodeId, f.devices.map(device => device.id)])
  assert.equal(endpoints.length, 2)
  const active = () => rows("SELECT id,transferred_at,transferred_into FROM gateway_calls WHERE configuration_id=$1 AND state='answered' ORDER BY created_at", [f.configuration.id])
  const drained = () => until(async () => (await active()).length === 0 && (await ari.request('GET', 'channels')).length === 0
    && (await ari.request('GET', 'bridges')).length === 0, 'transfer fixture drained')
  // The disposable Asterisk reads a private fixture view with ARI-only transfers.
  // The shared application view and any non-test gateway retain their settings.
  for (const endpoint of endpoints) assert.equal(endpoint.allow_transfer, 'no')
    let source = await phones[0]!.call('2000')
    assert.match(source.response, /^SIP\/2.0 200/)
    assert.equal(await phones[0]!.transfer(source, 'invalid-destination'), 603)
    assert.equal((await ari.request('GET', 'channels')).length, 2, 'A rejected transfer must preserve the caller')
    assert.equal(await phones[0]!.transfer(source, '2001'), 200)
    await phones[0]!.ended(source)
    await until(async () => Boolean((await active())[0]?.transferred_at), 'blind transfer recorded')
    let bridges = await ari.request('GET', 'bridges')
    assert.equal(bridges.length, 1); assert.equal(bridges[0].channels.length, 2)
    assert.equal((await ari.request('GET', 'channels')).length, 2, 'Only the remote parties remain')
    await ari.request('DELETE', `channels/${bridges[0].channels[0]}`); await drained()
    console.log('PASS: Real blind REFER/NOTIFY rejection preserves the call; success leaves two remote legs, one bridge and a recorded transfer.')

    source = await phones[0]!.call('2000')
    const foreign = await phones[1]!.call('2001')
    assert.equal(await phones[0]!.transfer(source, '2001', foreign), 603)
    assert.equal((await ari.request('GET', 'channels')).length, 4)
    assert.equal((await ari.request('GET', 'bridges')).length, 2)
    await phones[1]!.bye(foreign); await phones[0]!.bye(source); await drained()
    console.log('PASS: An attended REFER targeting another device is rejected with both original conversations intact.')

    source = await phones[0]!.call('2000')
    const consultation = await phones[0]!.call('2001')
    const before = await active(); assert.equal(before.length, 2)
    assert.equal(await phones[0]!.transfer(source, '2001', consultation), 200)
    await Promise.all([phones[0]!.ended(source), phones[0]!.ended(consultation)])
    await until(async () => (await active()).length === 1 && Boolean((await active())[0]?.transferred_at), 'attended transfer recorded')
    const continued = (await active())[0]!
    const consultationRecord = (await rows('SELECT state,transferred_into FROM gateway_calls WHERE id=$1', [before.find(call => call.id !== continued.id)!.id]))[0]!
    assert.equal(consultationRecord.state, 'ended'); assert.equal(consultationRecord.transferred_into, continued.id)
    bridges = await ari.request('GET', 'bridges')
    assert.equal(bridges.length, 1); assert.equal(bridges[0].channels.length, 2)
    const remoteLegs = [...bridges[0].channels].sort()
    await recover()
    const recovered = await ari.request('GET', `bridges/${bridges[0].id}`)
    assert.deepEqual([...recovered.channels].sort(), remoteLegs)
    assert.equal((await active())[0]?.id, continued.id)
    await ari.request('DELETE', `channels/${remoteLegs[0]}`); await drained()
    console.log('PASS: Real attended Replaces joins the remote parties, releases both device legs and survives controller SIGKILL/restart before remote hangup.')
}
