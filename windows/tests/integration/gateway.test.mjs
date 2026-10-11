// Run from portal/scripts/gateway-smoke.ts with SIPPER_WINDOWS_GATEWAY=1 on macOS.
// Real Windows app state/C engine and real gateway services; fictional OAuth identity,
// a private temporary CA, silent generated audio. This does not prove Windows Schannel/DPAPI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AppState } from '../../src/main/appState.js';
import { EngineClient } from '../../src/main/engineClient.js';
import { ManagedClient } from '../../src/main/managedClient.js';
import { ManagedController } from '../../src/main/managedController.js';
import { callIdentity } from '../../src/main/managedCalls.js';
import { MemoryPasswordStore } from '../../src/main/passwords.js';
import { JSONStore } from '../../src/main/store.js';
import { engineExecutable } from '../support.mjs';

const source = process.env.SIPPER_TEST_GATEWAY_FILE;
test('Windows AppState and native engine use authenticated gateway call control', {
  skip: !source?.includes('sipper-windows-gateway-'), timeout: 150_000,
}, async () => {
  assert.equal(process.platform, 'darwin', 'This local harness uses the Mac build of the Windows engine');
  const fixture = JSON.parse(await fs.readFile(source, 'utf8'));
  assert.equal(new URL(fixture.origin).hostname, '127.0.0.1');
  async function until(step, check) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (await check()) return; await delay(100); }
    throw new Error(`Timed out: ${step}`);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sipper-windows-call-test-'));
  const states = [];
  const engineLogs = [];
  let controller, releaseAnswer;
  try {
    const identity = await fetch(`${fixture.origin}/api/client/organisations`, { headers: { authorization: `Bearer ${fixture.token}` } }).then(r => r.json());
    let saved = { version: 1, origin: fixture.origin, installationId: randomUUID(),
      identity: identity.user, organisations: identity.organisations, enrollments: [],
      tokens: { accessToken: fixture.token, refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600_000 } };
    let deferAnswer = false, waitingForAnswer = false;
    const client = new ManagedClient({ origin: fixture.origin, allowLocalDevelopment: true,
      openBrowser: () => { throw new Error('The isolated test must not open browser sign-in'); },
      store: { read: () => saved, save: value => { saved = structuredClone(value); }, clear: () => { saved = null; } },
      fetch: async (url, options) => {
        if (deferAnswer && String(url).endsWith('/answer')) {
          waitingForAnswer = true; await new Promise(resolve => { releaseAnswer = resolve; });
        }
        return fetch(url, options);
      } });
    client.load();
    await client.connect(identity.organisations[0].id, { name: 'Isolated Windows app state', appVersion: 'test', osVersion: 'test' });
    const config = client.configurations()[0];
    assert.equal(config.accounts[0].mode, 'gateway');
    assert.equal(config.accounts[0].settings.server, 'localhost');
    async function app(name, ca) {
      const engine = new EngineClient({ executable: engineExecutable });
      engine.on('log', line => engineLogs.push(line));
      const request = engine.request.bind(engine);
      engine.request = (method, params) => request(method, method === 'start' && ca ? { ...params, testCaFile: ca } : params);
      const state = new AppState({ engine, store: new JSONStore(path.join(directory, name)), passwords: new MemoryPasswordStore(), platform: { nullAudio: true } });
      states.push(state); state.load();
      Object.assign(state.settings, { sipLogLevel: 4, localUDPPort: 0, localTCPPort: 0, localTLSPort: 0, verifyTLSCertificates: true,
        showNotifications: false, showIncomingCallAlert: false,
        codecs: [{ codecID: 'opus/48000/2', isEnabled: true }, { codecID: 'PCMU/8000/1', isEnabled: true }] });
      await state.startEngine(); assert.equal(state.engineStatus.running, true);
      return { engine, state };
    }
    const untrusted = await app('untrusted');
    await untrusted.state.applyManagedConfigurations(client.origin, [config]);
    await until('unknown CA rejected', () => Object.values(untrusted.state.registrations).some(r => r.state === 'failed'));
    await untrusted.state.shutdown();

    const ca = path.join(directory, 'ca.der');
    await fs.writeFile(ca, Buffer.from(fixture.certificate.split('\n').filter(line => !line.startsWith('---')).join(''), 'base64'), { mode: 0o600 });
    const { state, engine } = await app('trusted', ca);
    const alerts = []; state.on('alert', value => alerts.push(value));
    controller = new ManagedController({ client, state, metadata: {} });
    controller.reconcile(); await controller.applying;
    const account = state.accounts.find(a => a.managed);
    const registered = () => state.registration(account.id).state === 'registered';
    await until('verified TLS/SHA-256 registration', registered);
    await controller.report();
    await assert.rejects(engine.request('makeCall', { accountId: account.id, uri: 'sip:2000@other.example.invalid;transport=tls' }), /phone number/);
    async function media(call) {
      let value;
      await until('Opus SRTP/ICE packets in both directions', async () => {
        value = await engine.request('testMedia', callIdentity(call));
        return value.codec.toLowerCase() === 'opus' && value.sent >= 5 && value.received >= 5 && value.srtp && value.ice;
      });
      return value;
    }
    assert.equal(await state.call('2000', account.id), true, alerts.at(-1)?.message);
    await until('outgoing connected', () => state.calls.some(call => call.connectedAt));
    const outgoing = state.calls[0]; await media(outgoing);
    engineLogs.splice(0);
    await engine.request('testNetworkChanged', { available: true });
    await state.setSuspended(true); // A later sleep must cancel pending recovery.
    state.reRegisterAll();
    await delay(650);
    assert.equal(registered(), false);
    assert.equal(engineLogs.some(line => line.includes('send re-INVITE') && line.includes('triggered by IP change')), false);
    async function recoverCall(withdrawn = false) {
      await state.setSuspended(true);
      await engine.request('testNetworkChanged', { available: false });
      await state.setSuspended(false);
      assert.equal(registered(), false, 'Wake without a usable path remains offline');
      engineLogs.splice(0);
      await engine.request('testNetworkChanged', { available: true });
      if (!withdrawn) await until('registration recovers', registered);
      await until('fresh network-change SDP negotiation', () => {
        const lines = engineLogs.flatMap(line => line.split('\n'));
        const offer = lines.findIndex(line => line.includes('send re-INVITE') && line.includes('triggered by IP change'));
        return offer >= 0 && lines.slice(offer + 1).some(line => line.includes('SDP negotiation done: Success'));
      });
      const before = await media(outgoing);
      await until('encrypted packets advance after recovery', async () => {
        const value = await engine.request('testMedia', callIdentity(outgoing));
        return value.sent > before.sent + 5 && value.received > before.received + 5;
      });
      assert.equal(registered(), !withdrawn);
      assert.equal((await engine.request('activeCalls')).some(call => call.id === outgoing.id && call.connectedAt), true);
      const requests = engineLogs.filter(line => line.includes('TX ') && line.includes('Request msg REGISTER'));
      if (withdrawn) {
        for (const request of requests) assert.equal(request.split('\n').find(line => line.startsWith('Expires:'))?.trim(), 'Expires: 0');
      } else assert.ok(requests.some(request => /^Expires: [1-9]\d*\r?$/m.test(request)), 'Recovery must create a fresh binding');
    }
    for (let i = 0; i < 3; i++) await recoverCall();
    await state.applyManagedConfigurations(client.origin, []);
    await assert.rejects(engine.request('makeCall', { accountId: account.id, uri: `sip:2000@${account.domain};transport=tls` }), /not active/);
    assert.equal(await state.transfer(outgoing, '2001'), false);
    await assert.rejects(engine.request('transfer', { ...callIdentity(outgoing), uri: `sip:2001@${account.domain};transport=tls` }), /unavailable/);
    await recoverCall(true);
    state.hangup(outgoing.id);
    const ended = () => until('call ended', async () => !state.calls.length && !(await engine.request('activeCalls')).length);
    await ended();
    await state.applyManagedConfigurations(client.origin, [config]); await until('managed registration restored', registered);

    const phase = value => fs.writeFile(fixture.ready, value, { mode: 0o600 });
    async function connected(number) {
      const before = new Set(state.calls.map(call => call.startedAt));
      assert.equal(await state.call(number, account.id), true, alerts.at(-1)?.message);
      await until('transfer call connected', () => state.calls.some(call => !before.has(call.startedAt) && call.connectedAt));
      const call = state.calls.find(call => !before.has(call.startedAt) && call.connectedAt);
      await media(call);
      return call;
    }
    async function hold(call) {
      engineLogs.splice(0);
      await engine.request('setHold', { ...callIdentity(call), hold: true });
      await until('hold negotiated before transfer', () => state.calls.some(c => c.id === call.id && c.startedAt === call.startedAt && c.isOnHold)
        && engineLogs.some(line => line.includes('SDP negotiation done: Success')));
    }
    async function transferred(name) {
      await ended(); await phase(name);
      await until('remote media handoff and cleanup', async () => (await fs.readFile(fixture.completed, 'utf8').catch(() => '')) === name);
    }
    const echo = await connected('2000'), tone = await connected('2001');
    // Consultation held the echo. Resume it before measuring the remote streams separately.
    await engine.request('setHold', { ...callIdentity(echo), hold: false });
    await until('tone source and silent remote echo', async () => {
      const values = await Promise.all([echo, tone].map(c => engine.request('testMedia', callIdentity(c))));
      return values[0].receivedLevel <= 1 && values[1].receivedLevel >= 4;
    });
    assert.equal(await state.mergeConference(state.calls.find(c => c.id === echo.id), state.calls.find(c => c.id === tone.id)), true, alerts.at(-1)?.message);
    await until('mixer forwards tone through remote encrypted echo', async () => (await engine.request('testMedia', callIdentity(echo))).receivedLevel >= 4);
    const group = state.calls.find(c => c.id === echo.id);
    state.toggleMute(group);
    await until('shared conference mute', () => state.calls.filter(c => c.conferenceID === group.conferenceID).every(c => c.isMuted));
    await state.toggleHold(group);
    assert.equal(state.calls.filter(c => c.conferenceID === group.conferenceID).every(c => c.isOnHold && !c.hasActiveMedia), true);
    await state.swapToCall(state.calls.find(c => c.id === echo.id));
    await until('conference resumes remote audio', async () => (await engine.request('testMedia', callIdentity(echo))).receivedLevel >= 4);
    assert.equal(await state.separateConference(state.calls.find(c => c.id === echo.id)), true, alerts.at(-1)?.message);
    assert.equal(state.calls.find(c => c.id === tone.id).isOnHold, true);
    await until('separation removes remote forwarding', async () => (await engine.request('testMedia', callIdentity(echo))).receivedLevel <= 1);
    state.hangup(echo.id); state.hangup(tone.id);
    await transferred('conference-media');
    const blind = await connected('2000');
    for (const invalid of ['sip:2001@external.invalid', '2001@localhost', 'ABCD', '1'.repeat(129)]) {
      assert.equal(await state.transfer(blind, invalid), false);
    }
    await assert.rejects(engine.request('transfer', { ...callIdentity(blind), uri: 'sip:2001@external.invalid;transport=tls' }), /phone number/);
    assert.equal(await state.transfer(blind, '2004'), true);
    await until('rejected transfer preserves original call', () => state.calls.some(c => c.id === blind.id && c.connectedAt &&
      !c.isTransferring && c.transferStatus?.startsWith('Transfer failed')));
    const before = await media(blind);
    await until('media advances after rejected transfer', async () => {
      const value = await engine.request('testMedia', callIdentity(blind));
      return value.sent > before.sent + 5 && value.received > before.received + 5;
    });
    await hold(blind);
    assert.equal(await state.transfer(blind, '2001'), true);
    await transferred('transfer-blind-media');
    const held = await connected('2000'); await hold(held);
    const consultation = await connected('2001');
    assert.equal(await state.attendedTransfer(held, consultation), true);
    assert.equal(await state.transfer(consultation, '2000'), false);
    await transferred('transfer-attended-media');
    assert.equal(await state.attendedTransfer(held, consultation), false);

    async function incoming(name) {
      alerts.splice(0); await phase(name);
      await until(`verified caller for ${name}`, () => state.calls.some(c => c.state === 'incoming' && c.remoteName === 'Fixture caller'));
      const call = state.calls[0]; assert.equal(call.remoteNumber, '2000'); assert.equal(call.remoteURI, '');
      assert.ok(call.gatewayCallId); assert.equal(state.history[0].remoteName, 'Fixture caller');
      return call;
    }
    const answered = await incoming('answer');
    await assert.rejects(engine.request('answer', { callId: answered.id }), /authenticated answer claim/);
    await assert.rejects(engine.request('setManagedCaller', { ...callIdentity(answered), expectedStartedAt: answered.startedAt - 1,
      gatewayCallId: answered.gatewayCallId, name: 'Wrong', number: '999' }), /no longer exists/);
    await Promise.all([state.answer(answered.id), state.answer(answered.id)]);
    await until('incoming answered', () => state.calls.some(c => c.connectedAt));
    await media(answered);
    const accepted = await client.call(answered.gatewayCallId, account.managed);
    assert.equal(accepted.state, 'answered'); assert.equal(accepted.claimedByThisDevice, true);
    await engine.request('hangup', { ...callIdentity(answered), onlyIfRinging: true, code: 480 });
    assert.equal((await engine.request('activeCalls')).length, 1, 'late ringing cancellation must preserve the connected call');
    state.hangup(answered.id); await ended();

    const cancelled = await incoming('cancel');
    deferAnswer = true;
    const answering = state.answer(cancelled.id);
    await until('answer request waiting', () => waitingForAnswer);
    await phase('cancel-ringing'); await ended(); releaseAnswer(); await answering; deferAnswer = false;
    assert.equal(alerts.length, 0, 'cancelled answers must not produce a stale error or answer a new call');

    const declined = await incoming('decline'); state.decline(declined.id); await ended();
    assert.equal(state.history[0].outcome, 'declined');
    await phase('decline-finished');
    await until('declined parent ended', async () => (await client.call(declined.gatewayCallId, account.managed)).state === 'ended');

    const lost = await incoming('other-device'); await phase('other-device-ringing'); await ended();
    assert.equal((await client.call(lost.gatewayCallId, account.managed)).claimedByThisDevice, false);

    const failed = await incoming('answer-failed'); state.platform.microphoneStatus = () => 'denied';
    await state.answer(failed.id); await ended();
    assert.equal(alerts.at(-1)?.title, 'Microphone access needed');
    await phase('answer-failed-finished');
    await until('failed parent ended', async () => (await client.call(failed.gatewayCallId, account.managed)).state === 'ended');
  } catch (error) {
    await fs.writeFile('/tmp/sipper-windows-gateway-engine.log', engineLogs.join('\n'), { mode: 0o600 });
    throw error;
  } finally {
    releaseAnswer?.(); controller?.stop();
    for (const state of states) await state.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
