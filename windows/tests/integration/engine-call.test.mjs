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
  let calleeCallID;

  await t.test('places a call that the other engine answers', async () => {
    const call = await caller.request('makeCall', { accountId: 'acc-1001', uri: 'sip:1002@sipper.test;transport=udp' });
    callerCallID = call.id;
    assert.equal(call.direction, 'outgoing');
    assert.equal(call.accountId, 'acc-1001');

    const incoming = await callee.waitFor('incomingCall');
    calleeCallID = incoming.call.id;
    assert.equal(incoming.call.direction, 'incoming');
    assert.equal(incoming.call.accountId, 'acc-1002');
    assert.match(incoming.call.remote, /1001@sipper\.test/);

    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && e.call.state === 'early');
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
    await caller.request('setHold', { callId: callerCallID, hold: true });
    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && e.call.onHold && !e.call.activeMedia);
    await callee.waitFor('callChanged', (e) => e.call.id === calleeCallID && e.call.remoteHold);

    caller.clearEvents();
    await caller.request('setHold', { callId: callerCallID, hold: false });
    await caller.waitFor('callChanged', (e) => e.call.id === callerCallID && !e.call.onHold && e.call.activeMedia);

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

  await t.test('stops cleanly and can start again', async () => {
    await callee.request('stop');
    await assert.rejects(callee.request('makeCall', { accountId: 'acc-1002', uri: 'sip:1001@sipper.test' }), /not running/);
    await callee.request('start', engineStartParams);
    callee.clearEvents();
    await callee.request('syncAccounts', { accounts: [testAccount('1002', port)], stunServers: [] });
    await callee.waitFor('registration', (e) => e.accountId === 'acc-1002' && e.state === 'registered');
  });
});
