// End-to-end check of sipper-engine against tools/sip-test-server.py: two engines register,
// one calls the other, and the call is muted, held, recorded, sent DTMF and hung up.
//
// Needs Python 3 and a built engine: windows/engine/build/sipper-engine[.exe], or set
// SIPPER_ENGINE. Audio uses PJSIP's null device, so no sound hardware is involved.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppState } from '../../src/main/appState.js';
import { ManagedMeetingWindows } from '../../src/main/managedMeetingWindow.js';
import { JSONStore } from '../../src/main/store.js';
import { MemoryPasswordStore } from '../../src/main/passwords.js';
import { makeAccount } from '../../src/core/models.js';

import { engineExecutable, engineStartParams, freePort, startEngine, startSIPServer, testAccount } from '../support.mjs';

test('sipper-engine registers, calls, controls and ends calls', { skip: !fs.existsSync(engineExecutable) && `no engine at ${engineExecutable}` }, async (t) => {
  const port = await freePort();
  const server = await startSIPServer(port);
  t.after(() => server.stop());

  const caller = await startEngine('caller');
  const callee = await startEngine('callee');
  t.after(async () => {
    await caller.shutdown();
    await callee.shutdown();
  });

  await t.test('starts and reports codecs', async () => {
    const started = await caller.request('start', engineStartParams);
    assert.match(started.pjsip, /^2\.\d+/);
    await callee.request('start', engineStartParams);
    const codecs = await caller.request('codecs');
    assert.ok(codecs.some((codec) => codec.id === 'PCMU/8000/1'));
    assert.ok(Array.isArray(await caller.request('audioDevices')));
  });

  await t.test('registers, reports failures and voicemail', async () => {
    await caller.request('syncAccounts', {
      accounts: [testAccount('1001', port), testAccount('1002', port, { id: 'acc-wrong-password', password: 'nope' })],
      stunServers: [],
    });
    await callee.request('syncAccounts', { accounts: [testAccount('1002', port)], stunServers: [] });

    const registered = await caller.waitFor('registration', (e) => e.accountId === 'acc-1001' && e.state === 'registered');
    assert.equal(registered.code, 200);
    assert.ok(registered.expires > 0);
    await callee.waitFor('registration', (e) => e.accountId === 'acc-1002' && e.state === 'registered');

    const rejected = await caller.waitFor('registration', (e) => e.accountId === 'acc-wrong-password' && e.state === 'failed');
    assert.ok([401, 403, 407].includes(rejected.code), `unexpected code ${rejected.code}`);

    const voicemail = await caller.waitFor('voicemail', (e) => e.accountId === 'acc-1001');
    assert.match(voicemail.body, /2\/5/);

    await caller.request('syncAccounts', { accounts: [testAccount('1001', port)], stunServers: [] });
    await caller.waitFor('registration', (e) => e.accountId === 'acc-wrong-password' && e.state === 'unregistered');
  });

  await t.test('rejects bad requests with readable errors', async () => {
    await assert.rejects(caller.request('makeCall', { accountId: 'nope', uri: 'sip:1@sipper.test' }), /not active/);
    await assert.rejects(caller.request('hangup', { callId: 31 }), /no longer exists/);
    await assert.rejects(caller.request('makeCall', { accountId: 'acc-1001', uri: 'not a uri' }), /not a valid SIP address/);
    await assert.rejects(caller.request('frobnicate'), /Unknown method/);
  });

  let callerCallID;
  let callerIdentity;
  let calleeCallID;

  await t.test('places a call that the other engine answers', async () => {
    const call = await caller.request('makeCall', { accountId: 'acc-1001', uri: 'sip:1002@sipper.test;transport=udp' });
    callerCallID = call.id;
    callerIdentity = { callId: call.id, accountId: call.accountId, expectedStartedAt: call.startedAt };
    assert.equal(call.direction, 'outgoing');
    assert.equal(call.accountId, 'acc-1001');

    const incoming = await callee.waitFor('incomingCall');
    calleeCallID = incoming.call.id;
    assert.equal(incoming.call.direction, 'incoming');
    assert.equal(incoming.call.accountId, 'acc-1002');
    assert.match(incoming.call.remote, /1001@sipper\.test/);

    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && e.call.state === 'early');
    await assert.rejects(caller.request('setHold', { callId: callerCallID, hold: true }), /identity/);
    await assert.rejects(caller.request('setHold', { ...callerIdentity, hold: true }), /not available to hold/);
    assert.equal((await caller.request('activeCalls')).find(c => c.id === callerCallID).onHold, false, 'A rejected native hold command must preserve the current state');
    await callee.request('answer', { callId: calleeCallID, code: 200 });

    const confirmed = await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && e.call.state === 'confirmed' && e.call.activeMedia);
    assert.ok(confirmed.call.connectedAt >= confirmed.call.startedAt);
    await callee.waitFor('callChanged', (e) => e.call.id === calleeCallID && e.call.state === 'confirmed');
  });

  await t.test('mutes, holds, resumes and sends DTMF', async () => {
    caller.clearEvents();
    await caller.request('setMuted', { callId: callerCallID, muted: true });
    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && e.call.muted);

    callee.clearEvents();
    await assert.rejects(caller.request('setHold', { ...callerIdentity, expectedStartedAt: callerIdentity.expectedStartedAt - 1, hold: true }), /no longer exists/);
    await assert.rejects(caller.request('setHold', { ...callerIdentity, accountId: 'other-account', hold: true }), /no longer exists/);
    await caller.request('setHold', { ...callerIdentity, hold: true });
    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && e.call.onHold && !e.call.activeMedia);
    await callee.waitFor('callChanged', (e) => e.call.id === calleeCallID && e.call.remoteHold);

    caller.clearEvents();
    await caller.request('setHold', { ...callerIdentity, hold: false });
    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && !e.call.onHold && e.call.activeMedia);
    const incoming = (await callee.request('activeCalls')).find(c => c.id === calleeCallID);
    const calleeIdentity = { callId: incoming.id, accountId: incoming.accountId, expectedStartedAt: incoming.startedAt };
    await caller.request('setHold', { ...callerIdentity, hold: true });
    await callee.request('setHold', { ...calleeIdentity, hold: true });
    await caller.request('setHold', { ...callerIdentity, hold: false });
    const remoteHeld = (await caller.request('activeCalls')).find(c => c.id === callerCallID);
    assert.equal(remoteHeld.onHold, false, 'Local resume can succeed while the other participant still has the call held');
    assert.equal(remoteHeld.remoteHold, true);
    await callee.request('setHold', { ...calleeIdentity, hold: false });
    assert.equal((await caller.request('activeCalls')).find(c => c.id === callerCallID).activeMedia, true);

    await caller.request('sendDtmf', { callId: callerCallID, digits: '12#' });
  });

  await t.test('records the call to a WAV file, including a non-ASCII path', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sipper-engine-Zoë-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const file = path.join(folder, 'call with Zoë.wav');
    caller.clearEvents();
    await caller.request('startRecording', { callId: callerCallID, path: file });
    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && e.call.recording);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await caller.request('stopRecording', { callId: callerCallID });
    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && !e.call.recording);
    const header = fs.readFileSync(file).subarray(0, 12).toString('latin1');
    assert.equal(header.slice(0, 4), 'RIFF');
    assert.equal(header.slice(8, 12), 'WAVE');
    assert.ok(fs.statSync(file).size > 1000, 'the recording has audio frames');
  });

  await t.test('hangs up on both sides', async () => {
    await caller.request('hangup', { callId: callerCallID });
    const ended = await caller.waitFor('callEnded', (e) => e.call.id === callerCallID);
    assert.equal(ended.call.state, 'disconnected');
    assert.ok(ended.call.endedAt >= ended.call.connectedAt);
    await callee.waitFor('callEnded', (e) => e.call.id === calleeCallID);
    assert.deepEqual(await caller.request('activeCalls'), []);
  });

  await t.test('ends the call when the far end hangs up', async () => {
    caller.clearEvents();
    const call = await caller.request('makeCall', { accountId: 'acc-1001', uri: 'sip:*97@sipper.test;transport=udp' });
    await caller.waitFor('callChanged', (e) => e.call.id === call.id && e.call.state === 'confirmed');
    const ended = await caller.waitFor('callEnded', (e) => e.call.id === call.id, 15000);
    assert.equal(ended.call.state, 'disconnected');
  });

  await t.test('a rejected hold negotiation never reports the retained call as held', async () => {
    const call = await caller.request('makeCall', { accountId: 'acc-1001', uri: 'sip:*nohold@sipper.test;transport=udp' });
    const identity = { callId: call.id, accountId: call.accountId, expectedStartedAt: call.startedAt };
    await caller.waitFor('callChanged', e => e.call.id === call.id && e.call.startedAt === call.startedAt && e.call.state === 'confirmed' && e.call.activeMedia);
    caller.clearEvents();
    await assert.rejects(caller.request('setHold', { ...identity, hold: true }), /SIP 488/);
    const retained = (await caller.request('activeCalls')).find(c => c.id === call.id && c.startedAt === call.startedAt);
    assert.equal(retained.state, 'confirmed'); assert.equal(retained.onHold, false); assert.equal(retained.activeMedia, true);
    assert.equal(caller.events.some(e => e.type === 'callChanged' && e.call?.id === call.id && e.call?.onHold), false);
    await caller.request('hangup', identity);
    await caller.waitFor('callEnded', e => e.call.id === call.id && e.call.startedAt === call.startedAt);
  });

  await t.test('stops cleanly and can start again', async () => {
    await callee.request('stop');
    await assert.rejects(callee.request('makeCall', { accountId: 'acc-1002', uri: 'sip:1001@sipper.test' }), /not running/);
    await callee.request('start', engineStartParams);
    callee.clearEvents();
    await callee.request('syncAccounts', { accounts: [testAccount('1002', port)], stunServers: [] });
    await callee.waitFor('registration', (e) => e.accountId === 'acc-1002' && e.state === 'registered');
  });
});


test('managed meeting windows hold and return the exact call through the real app model and SIP engine', { skip: !fs.existsSync(engineExecutable) && `no engine at ${engineExecutable}` }, async t => {
  const port = await freePort(), server = await startSIPServer(port, 45), engine = await startEngine('meeting model');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sipper-meeting-model-'));
  const state = new AppState({ engine, store: new JSONStore(directory), passwords: new MemoryPasswordStore(), platform: { nullAudio: true } });
  state.load();
  const account = state.addAccount(makeAccount({ username: '1001', domain: 'sipper.test', server: '127.0.0.1', port,
    transport: 'udp', profileID: state.profiles[0].id }), 'secret');
  const deviceId = randomUUID(), meetingId = randomUUID(), organisationId = randomUUID(), client = new EventEmitter();
  client.snapshot = () => ({ signedIn: true, signingIn: false, identity: { id: 'fixture' }, enrollments: [{ deviceId, organisationId }], organisations: [{ id: organisationId, status: 'active', licensed: true }] });
  client.meetingDetails = async () => ({ canJoin: true, expiresAt: new Date(Date.now() + 30_000).toISOString(),
    meeting: { id: meetingId, expiresAt: new Date(Date.now() + 60_000).toISOString(), endedAt: null } });
  client.joinMeeting = async (_device, _meeting, sessionId) => ({ sessionId, url: 'wss://meet.example.invalid', token: 'fixture-only' });
  client.leaveMeeting = async () => {};
  const windows = new ManagedMeetingWindows({ client, state, pageURL: 'app://sipper/src/renderer/meeting.html', createWindow: () => {
    const win = new EventEmitter(); win.webContents = new EventEmitter(); let destroyed = false, url = '';
    win.isDestroyed = () => destroyed; win.webContents.isDestroyed = () => destroyed;
    win.show = win.focus = () => {}; win.loadURL = async value => { url = value; }; win.webContents.getURL = () => url;
    win.destroy = () => { if (!destroyed) { destroyed = true; win.webContents.emit('destroyed'); win.emit('closed'); } }; return win;
  } });
  state.platform.beforePhoneAudio = () => windows.closeForPhone();
  t.after(async () => { await windows.stop(); await state.shutdown(); server.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await state.startEngine(); await state.syncEngineAccounts(); await engine.waitFor('registration', e => e.accountId === account.id && e.state === 'registered');
  assert.equal(await state.call('sip:*slowhold@sipper.test;transport=udp', account.id), true);
  const call = state.activeCall;
  await engine.waitFor('callChanged', e => e.call.id === call.id && e.call.startedAt === call.startedAt && e.call.state === 'confirmed' && e.call.activeMedia);
  await windows.open(deviceId, meetingId);
  assert.equal(state.activeCall.isOnHold, true, windows.entry?.error?.message); assert.equal(state.meetingActive, true);
  await assert.rejects(engine.request('setHold', { callId: call.id, accountId: account.id, expectedStartedAt: call.startedAt, hold: false }), /Leave the meeting/);
  windows.close(); await windows.cleanup;
  assert.equal(state.meetingActive, false); assert.equal(state.activeCall.isOnHold, false);
  assert.equal(state.activeCall.startedAt, call.startedAt);
  await windows.open(deviceId, meetingId);
  await state.swapToCall({ ...state.activeCall });
  assert.equal(windows.entry, null); assert.equal(state.meetingActive, false); assert.equal(state.activeCall.isOnHold, false);
  state.hangup({ ...state.activeCall }); await engine.waitFor('callEnded', e => e.call.id === call.id && e.call.startedAt === call.startedAt);
});

test('meeting audio ownership fences phone media, pending hold, stale releases and engine restart', { skip: !fs.existsSync(engineExecutable) && `no engine at ${engineExecutable}` }, async t => {
  const port = await freePort(), server = await startSIPServer(port, 45), engine = await startEngine('meeting owner'), peer = await startEngine('meeting incoming');
  t.after(async () => { await Promise.allSettled([engine.shutdown(), peer.shutdown()]); server.stop(); });
  const reference = randomUUID(), replacement = randomUUID();
  for (const params of [{ reference: 'not-a-uuid', enabled: true }, { reference, enabled: 'true' }])
    await assert.rejects(engine.request('setMeetingAudio', params), /valid meeting audio reference/);
  await assert.rejects(engine.request('start', { ...engineStartParams, meetingAudioReference: 'not-a-uuid' }), /valid meeting audio reference/);
  assert.deepEqual(await engine.request('setMeetingAudio', { reference, enabled: true }), { claimed: true });
  await engine.request('start', { ...engineStartParams, meetingAudioReference: reference });
  await engine.request('syncAccounts', { accounts: [testAccount('1001', port)], stunServers: [] });
  await engine.waitFor('registration', e => e.state === 'registered');
  const dial = () => engine.request('makeCall', { accountId: 'acc-1001', uri: 'sip:*slowhold@sipper.test;transport=udp' });
  await assert.rejects(dial(), /Leave the meeting/);
  await assert.rejects(engine.request('setMeetingAudio', { reference: replacement, enabled: false }), /another session/);
  assert.deepEqual(await engine.request('setMeetingAudio', { reference: reference.toUpperCase(), enabled: true }), { claimed: true });
  await engine.request('setAudioDevices', { input: null, output: null });
  await engine.request('stop');
  await engine.request('start', engineStartParams);
  await engine.request('syncAccounts', { accounts: [testAccount('1001', port)], stunServers: [] });
  await assert.rejects(dial(), /Leave the meeting/, 'A restart without an explicit owner change must preserve the claim');
  await engine.request('setMeetingAudio', { reference, enabled: false });
  engine.clearEvents();
  const call = await dial(), identity = { callId: call.id, accountId: call.accountId, expectedStartedAt: call.startedAt };
  await engine.waitFor('callChanged', e => e.call.id === call.id && e.call.startedAt === call.startedAt && e.call.activeMedia);
  await assert.rejects(engine.request('setMeetingAudio', { reference, enabled: true }), /Hold your phone calls/);
  const pending = engine.request('setHold', { ...identity, hold: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(engine.request('setMeetingAudio', { reference, enabled: true }), /Hold your phone calls/);
  await pending;
  assert.equal((await engine.request('activeCalls'))[0].onHold, true);
  assert.deepEqual(await engine.request('setMeetingAudio', { reference, enabled: true }), { claimed: true });
  await assert.rejects(engine.request('setHold', { ...identity, hold: false }), /Leave the meeting/);
  await assert.rejects(engine.request('beginConference', { ...identity, otherCallId: call.id }), /Leave the meeting/);
  await engine.request('hangup', identity);
  await engine.waitFor('callEnded', e => e.call.id === call.id && e.call.startedAt === call.startedAt);
  await peer.request('start', engineStartParams);
  await peer.request('syncAccounts', { accounts: [testAccount('1002', port)], stunServers: [] });
  await peer.waitFor('registration', e => e.state === 'registered');
  engine.clearEvents();
  const outgoing = await peer.request('makeCall', { accountId: 'acc-1002', uri: 'sip:1001@sipper.test;transport=udp' });
  const incoming = await engine.waitFor('incomingCall');
  await assert.rejects(engine.request('answer', { callId: incoming.call.id, code: 200 }), /Leave the meeting/);
  assert.equal((await engine.request('activeCalls'))[0].state, 'incoming', 'Meeting ownership must preserve ringing and decline');
  await engine.request('setMeetingAudio', { reference, enabled: false });
  await engine.request('setMeetingAudio', { reference: replacement, enabled: true });
  await assert.rejects(engine.request('setMeetingAudio', { reference, enabled: false }), /another session/);
  await engine.request('hangup', { callId: incoming.call.id, code: 486 });
  await peer.waitFor('callEnded', e => e.call.id === outgoing.id && e.call.startedAt === outgoing.startedAt);
  await engine.request('setMeetingAudio', { reference: replacement, enabled: false });
  engine.clearEvents();
  const resumed = await dial();
  await engine.waitFor('callChanged', e => e.call.id === resumed.id && e.call.startedAt === resumed.startedAt && e.call.activeMedia);
  await engine.request('hangup', { callId: resumed.id });
  await engine.waitFor('callEnded', e => e.call.id === resumed.id && e.call.startedAt === resumed.startedAt);
  await engine.request('setMeetingAudio', { reference: replacement, enabled: true });
  await engine.request('stop');
  await engine.request('start', { ...engineStartParams, meetingAudioReference: null });
  assert.deepEqual(await engine.request('setMeetingAudio', { reference, enabled: false }), { claimed: false }, 'Explicit startup without an owner clears the former claim');
});

test('hold waits for media, fences late replies and leaves hang-up responsive', { skip: !fs.existsSync(engineExecutable) && `no engine at ${engineExecutable}` }, async t => {
  const port = await freePort(), server = await startSIPServer(port, 45), engine = await startEngine('negotiation');
  t.after(async () => { await engine.shutdown(); server.stop(); });
  await engine.request('start', engineStartParams);
  await engine.request('syncAccounts', { accounts: [testAccount('1001', port)], stunServers: [] });
  await engine.waitFor('registration', e => e.state === 'registered');
  async function connected(number) {
    const call = await engine.request('makeCall', { accountId: 'acc-1001', uri: `sip:${number}@sipper.test;transport=udp` });
    await engine.waitFor('callChanged', e => e.call.id === call.id && e.call.startedAt === call.startedAt && e.call.state === 'confirmed' && e.call.activeMedia);
    return { callId: call.id, accountId: call.accountId, expectedStartedAt: call.startedAt };
  }
  const slow = await connected('*slowhold');
  let complete = false;
  const held = engine.request('setHold', { ...slow, hold: true }).then(() => { complete = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(complete, false);
  assert.equal((await engine.request('activeCalls'))[0].onHold, false);
  await assert.rejects(engine.request('makeCall', { accountId: 'acc-1001', uri: 'sip:*97@sipper.test' }), /still updating/);
  await assert.rejects(engine.request('setHold', { ...slow, hold: true }), /still updating/);
  await held;
  assert.equal((await engine.request('activeCalls'))[0].onHold, true);
  await engine.request('setHold', { ...slow, hold: false });
  assert.equal((await engine.request('activeCalls'))[0].activeMedia, true);
  await engine.request('hangup', slow);
  await engine.waitFor('callEnded', e => e.call.id === slow.callId && e.call.startedAt === slow.expectedStartedAt);
  const late = await connected('*latehold');
  await assert.rejects(engine.request('setHold', { ...late, hold: true }), /did not confirm/);
  await assert.rejects(engine.request('makeCall', { accountId: 'acc-1001', uri: 'sip:*97@sipper.test' }), /still updating/);
  await engine.waitFor('callChanged', e => e.call.id === late.callId && e.call.startedAt === late.expectedStartedAt && e.call.onHold);
  const admitted = await engine.request('makeCall', { accountId: 'acc-1001', uri: 'sip:*97@sipper.test' });
  await engine.request('hangup', { callId: admitted.id });
  await engine.waitFor('callEnded', e => e.call.id === admitted.id && e.call.startedAt === admitted.startedAt);
  await engine.request('hangup', late);
  await engine.waitFor('callEnded', e => e.call.id === late.callId && e.call.startedAt === late.expectedStartedAt);
  const silent = await connected('*silenthold');
  const unresolved = assert.rejects(engine.request('setHold', { ...silent, hold: true }), /no longer exists/);
  await new Promise(resolve => setTimeout(resolve, 200));
  const ending = performance.now();
  await engine.request('hangup', silent); await unresolved;
  assert.ok(performance.now() - ending < 1000, 'Hang-up must not wait for the hold timeout');
});
