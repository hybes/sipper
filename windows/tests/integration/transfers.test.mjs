import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeAccount } from '../../src/core/models.js';
import { AppState } from '../../src/main/appState.js';
import { MemoryPasswordStore } from '../../src/main/passwords.js';
import { JSONStore } from '../../src/main/store.js';
import { engineExecutable, engineStartParams, freePort, startEngine, startSIPServer, testAccount } from '../support.mjs';

test('AppState consultation holds the first real SIP call and completes attended transfer', { skip: !fs.existsSync(engineExecutable) }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sipper-consultation-'));
  let server, state;
  t.after(async () => { await state?.shutdown(); server?.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const port = await freePort(); server = await startSIPServer(port, 45);
  const engine = await startEngine('consultation flow');
  state = new AppState({ store: new JSONStore(directory), passwords: new MemoryPasswordStore(), engine, platform: { nullAudio: true } });
  state.load();
  state.updateSettings({ ringtone: 'silent', showNotifications: false, recordCalls: false });
  const account = state.addAccount(makeAccount({ profileID: state.profiles[0].id, username: '1001',
    domain: 'sipper.test', server: '127.0.0.1', port, transport: 'udp', srtp: 'disabled', useICE: false }), 'secret');
  await state.startEngine();
  await engine.waitFor('registration', e => e.accountId === account.id && e.state === 'registered');
  assert.equal(await state.call('*97', account.id), true);
  const first = state.activeCall;
  await engine.waitFor('callChanged', e => e.call.id === first.id && e.call.state === 'confirmed');
  state.prepareNewCall();
  assert.equal(state.showingNewCall, true);
  assert.equal((await engine.request('activeCalls')).find(c => c.id === first.id).onHold, false);
  assert.equal(await state.call('*97'), true);
  const second = state.activeCall;
  assert.notEqual(second.id, first.id);
  assert.equal(second.accountID, first.accountID);
  assert.equal(state.showingNewCall, false);
  await engine.waitFor('callChanged', e => e.call.id === first.id && e.call.onHold);
  await engine.waitFor('callChanged', e => e.call.id === second.id && e.call.state === 'confirmed');
  assert.equal(await state.attendedTransfer(state.calls.find(c => c.id === first.id), state.activeCall), true);
  for (const call of [first, second]) await engine.waitFor('callEnded', e => e.call.id === call.id && e.call.startedAt === call.startedAt);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(await engine.request('activeCalls'), []);
});

test('native transfers preserve rejected calls and clean up only the captured same-account legs', { skip: !fs.existsSync(engineExecutable) }, async t => {
  const port = await freePort(), server = await startSIPServer(port, 45);
  t.after(() => server.stop());
  const engine = await startEngine('native transfers'); t.after(() => engine.shutdown());
  await engine.request('start', engineStartParams);
  const account = testAccount('1001', port, { managedUntil: Date.now() + 60_000 });
  const otherAccount = testAccount('1002', port);
  await engine.request('syncAccounts', { accounts: [account, otherAccount] });
  for (const value of [account, otherAccount]) await engine.waitFor('registration', e => e.accountId === value.id && e.state === 'registered');
  const identity = call => ({ callId: call.id, accountId: call.accountId, expectedStartedAt: call.startedAt });
  const pair = (call, other) => ({ ...identity(call), otherCallId: other.id, otherAccountId: other.accountId, otherStartedAt: other.startedAt });
  const matches = call => e => e.call.id === call.id && e.call.startedAt === call.startedAt;
  async function connected(owner = account) {
    const call = await engine.request('makeCall', { accountId: owner.id, uri: 'sip:*echo@sipper.test' });
    await engine.waitFor('callChanged', e => matches(call)(e) && e.call.state === 'confirmed');
    return call;
  }
  const first = await connected(), unrelated = await connected(otherAccount);
  await assert.rejects(engine.request('transfer', { callId: first.id, uri: 'sip:*97@sipper.test' }), /identity/);
  await assert.rejects(engine.request('transfer', { ...identity(first), expectedStartedAt: first.startedAt - 1, uri: 'sip:*97@sipper.test' }), /no longer exists/);
  await assert.rejects(engine.request('attendedTransfer', pair(first, first)), /same account/);
  await assert.rejects(engine.request('attendedTransfer', pair(first, unrelated)), /same account/);
  await engine.request('transfer', { ...identity(first), uri: 'sip:*404@sipper.test' });
  await assert.rejects(engine.request('transfer', { ...identity(first), uri: 'sip:*97@sipper.test' }), /available to transfer/);
  await engine.waitFor('transferStatus', e => e.callId === first.id && e.startedAt === first.startedAt && e.code === 404 && e.final);
  assert.equal((await engine.request('activeCalls')).find(c => c.id === first.id).transferring, false);
  await engine.request('transfer', { ...identity(first), uri: 'sip:*97@sipper.test' });
  await engine.waitFor('callEnded', matches(first)); // Fixture sends 200 before subscription termination.
  assert.equal((await engine.request('activeCalls')).find(c => c.id === unrelated.id).state, 'confirmed');

  const held = await connected(), consultation = await connected();
  await assert.rejects(engine.request('attendedTransfer', { ...pair(held, consultation), otherStartedAt: consultation.startedAt - 1 }), /no longer exists/);
  await engine.request('attendedTransfer', pair(held, consultation));
  await assert.rejects(engine.request('transfer', { ...identity(consultation), uri: 'sip:*97@sipper.test' }), /available to transfer/);
  await engine.waitFor('callEnded', matches(held));
  await engine.waitFor('callEnded', matches(consultation));
  await assert.rejects(engine.request('transfer', { ...identity(first), uri: 'sip:*97@sipper.test' }), /no longer exists/);

  const cancelled = await connected(), retained = await connected();
  await engine.request('attendedTransfer', pair(cancelled, retained));
  await engine.request('hangup', identity(cancelled));
  await engine.waitFor('callEnded', matches(cancelled));
  assert.equal((await engine.request('activeCalls')).find(c => c.id === retained.id).transferring, false);
  await engine.request('syncAccounts', { accounts: [otherAccount] });
  await assert.rejects(engine.request('transfer', { ...identity(retained), uri: 'sip:*97@sipper.test' }), /unavailable/);
  assert.equal((await engine.request('activeCalls')).find(c => c.id === retained.id).state, 'confirmed');
  await engine.request('hangup', identity(retained)); await engine.request('hangup', identity(unrelated));
  await engine.waitFor('callEnded', matches(retained)); await engine.waitFor('callEnded', matches(unrelated));
  assert.deepEqual(await engine.request('activeCalls'), []);
});

test('native conference binds exact peers, shares mute and removes only its two legs', { skip: !fs.existsSync(engineExecutable), timeout: 60_000 }, async t => {
  const port = await freePort(), server = await startSIPServer(port, 45); t.after(() => server.stop());
  const engine = await startEngine('native conference'); t.after(() => engine.shutdown());
  await engine.request('start', engineStartParams);
  const account = testAccount('1001', port, { managedUntil: Date.now() + 60_000 }), otherAccount = testAccount('1002', port);
  await engine.request('syncAccounts', { accounts: [account, otherAccount] });
  for (const a of [account, otherAccount]) await engine.waitFor('registration', e => e.accountId === a.id && e.state === 'registered');
  const identity = c => ({ callId: c.id, accountId: c.accountId, expectedStartedAt: c.startedAt });
  const pair = (a, b) => ({ ...identity(a), otherCallId: b.id, otherAccountId: b.accountId, otherStartedAt: b.startedAt });
  async function connected(owner = account) {
    const call = await engine.request('makeCall', { accountId: owner.id, uri: 'sip:*echo@sipper.test' });
    await engine.waitFor('callChanged', e => e.call.id === call.id && e.call.startedAt === call.startedAt && e.call.state === 'confirmed' && e.call.activeMedia);
    return call;
  }
  const first = await connected(), second = await connected(), unrelated = await connected(otherAccount);
  await assert.rejects(engine.request('beginConference', { callId: first.id, otherCallId: second.id }), /identity/);
  await assert.rejects(engine.request('beginConference', pair(first, unrelated)), /same active account/);
  await assert.rejects(engine.request('beginConference', { ...pair(first, second), otherStartedAt: second.startedAt - 1 }), /no longer exists/);
  await assert.rejects(engine.request('beginConference', pair(first, second)), /Hold your other calls/);
  await engine.request('setHold', { ...identity(unrelated), hold: true });
  const merged = await engine.request('beginConference', pair(first, second));
  assert.ok(merged.conferenceId);
  const group = c => ({ ...identity(c), conferenceId: merged.conferenceId });
  await assert.rejects(engine.request('beginConference', pair(first, second)), /finish resuming/);
  await assert.rejects(engine.request('setHold', { ...identity(first), hold: true }), /conference/);
  await assert.rejects(engine.request('splitConference', { ...group(first), conferenceId: 'wrong' }), /conference/);
  await assert.rejects(engine.request('splitConference', group(first)), /Hold both/);
  await assert.rejects(engine.request('transfer', { ...identity(first), uri: 'sip:*97@sipper.test' }), /available to transfer/);
  await engine.request('setMuted', { ...identity(first), muted: true });
  let active = await engine.request('activeCalls');
  assert.equal(active.filter(c => c.conferenceId === merged.conferenceId && c.muted).length, 2);
  assert.equal(active.find(c => c.id === unrelated.id).muted, false);
  for (const call of [first, second]) await engine.request('setHold', { ...group(call), hold: true });
  active = await engine.request('activeCalls'); assert.equal(active.filter(c => c.conferenceId && c.onHold && !c.activeMedia).length, 2);
  await engine.request('splitConference', group(first));
  active = await engine.request('activeCalls'); assert.equal(active.some(c => c.conferenceId), false); assert.equal(active.every(c => c.onHold), true);
  await assert.rejects(engine.request('hangupConference', group(first)), /conference/);
  for (const call of [first, second]) await engine.request('setHold', { ...identity(call), hold: false });
  const regrouped = await engine.request('beginConference', pair(first, second));
  // A regrouping of the same native legs must receive a fresh identity.
  assert.notEqual(regrouped.conferenceId, merged.conferenceId);
  await assert.rejects(engine.request('hangupConference', group(first)), /conference/);
  await engine.request('hangup', identity(second));
  await engine.waitFor('callEnded', e => e.call.id === second.id && e.call.startedAt === second.startedAt);
  active = await engine.request('activeCalls'); assert.equal(active.find(c => c.id === first.id).conferenceId, undefined);
  const replacement = await connected();
  const final = await engine.request('beginConference', pair(first, replacement));
  await engine.request('syncAccounts', { accounts: [otherAccount] });
  await assert.rejects(engine.request('beginConference', pair(first, replacement)), /active account/);
  await engine.request('hangupConference', { ...identity(first), conferenceId: final.conferenceId });
  for (const call of [first, replacement]) await engine.waitFor('callEnded', e => e.call.id === call.id && e.call.startedAt === call.startedAt);
  active = await engine.request('activeCalls'); assert.equal(active.length, 1); assert.equal(active[0].id, unrelated.id);
  await engine.request('hangup', identity(unrelated));
});
