import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { State } from '../src/state.mjs';
import { Calls } from '../src/calls.mjs';

test('recovery journal survives reopen, excludes secrets and fences an old writer', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sipper-state-test-')), path = join(directory, 'state.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let state = new State(path, 'first', 'fixture');
  const call = { id: 'call', parent: 'caller', incoming: true, connected: true, winner: 'phone', bridge: 'bridge',
    legs: new Map([['phone', { deviceId: 'device', password: 'leg-secret' }]]), reported: true,
    password: 'sip-secret', destination: 'private-number', caller: 'Private Caller', endReason: 'completed', originDeviceId: 'origin', asteriskStartedAt:'2026-09-26T16:00:00.000Z' };
  state.save(call); state.route({ id: 'route', configurationId: 'config', revision: 1, password: 'upstream-secret' });
  state.close(); state = new State(path, 'second', 'fixture');
  const contents = JSON.stringify(state.load());
  for (const forbidden of ['leg-secret', 'sip-secret', 'private-number', 'Private Caller', 'upstream-secret']) assert.ok(!contents.includes(forbidden));
  assert.equal(state.load().calls[0].winner, 'phone');
  assert.equal(state.load().calls[0].originDeviceId, 'origin');
  assert.equal(state.load().calls[0].asteriskStartedAt,call.asteriskStartedAt);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const replacement = new State(path, 'third', 'fixture');
  assert.throws(() => state.save(call), /ownership changed/);
  state.close();
  replacement.finish(call); replacement.close();
  state = new State(path, 'fourth', 'fixture');
  assert.equal(state.load().calls.length, 0);
  assert.deepEqual(state.load().endings.map(row => ({ ...row })), [{ id: 'call', reason: 'completed' }]);
  state.acknowledged('call'); state.removeRoute('route');
  assert.deepEqual(state.load(), { calls: [], routes: [], transfers: [], endings: [] });
  state.close();
  assert.throws(() => new State(path, 'wrong', 'other-gateway'), /another service/);
  assert.ok(!readFileSync(path).includes(Buffer.from('sip-secret')));
});

test('a recovered conversation waits through portal failure and retries incomplete teardown durably', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sipper-recovery-test-')), path = join(directory, 'state.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = new State(path, 'test', 'fixture'); t.after(() => state.close());
  const ari = new EventEmitter(), requests = [];
  let portalOffline = true, mediaOffline = false, endRequested = false;
  ari.request = async (method, path) => {
    requests.push([method, path]);
    if (method === 'GET' && path === 'channels') return [{ id: 'caller', state: 'Up' }, { id: 'phone', state: 'Up' }];
    if (method === 'GET') return { channels: ['caller', 'phone'] };
    if (mediaOffline) throw new Error('fixture unavailable');
  };
  state.save({ id: 'call', parent: 'caller', incoming: true, connected: false, reported: true,
    winner: 'phone', bridge: 'bridge', legs: new Map([['phone', { deviceId: 'device' }]]) });
  const reports=[];
  const calls = new Calls(ari, async (method,path,body) => {
    if (portalOffline) throw new Error('fixture unavailable');
    if (path === 'transfers') return {transfers:[]};
    if(method==='POST') reports.push(body);
    return {state:'answered',endRequested};
  }, {}, state);
  calls.restore(state.load());
  const request = ari.request;
  ari.request = async (method, path) => path === 'applications/sipper' ? { channel_ids: ['unknown-call'] } : request(method, path);
  await assert.rejects(calls.verifyRecovery(), { code: 'recovery_state_missing' });
  assert.equal(requests.length, 0);
  ari.request = async (method, path) => path === 'applications/sipper' ? { channel_ids: ['caller', 'phone'] } : request(method, path);
  await calls.verifyRecovery();
  await assert.rejects(calls.reconcile(), /fixture unavailable/);
  await calls.tick();
  assert.equal(requests.filter(([method]) => method === 'DELETE').length, 0);
  portalOffline = false; await calls.reconcile();
  assert.equal(calls.calls.get('call').connected, true);
  portalOffline = true; await assert.rejects(calls.reconcile(),/fixture unavailable/); await calls.tick();
  assert.equal(requests.filter(([method]) => method === 'DELETE').length,0,'Portal loss preserves an established conversation');
  portalOffline = false; endRequested = true; mediaOffline = true;
  calls.calls.get('call').recovered=true;
  await calls.reconcile();
  assert.equal(state.load().calls[0].endReason, 'admin_ended');
  assert.equal(state.load().endings.length, 0);
  assert.ok(!reports.some(report=>report.event==='ended'),'No end report while a media leg may still exist');
  mediaOffline = false; portalOffline = true;
  await assert.rejects(calls.reconcile(), /fixture unavailable/); await calls.tick();
  assert.equal(state.load().calls.length, 0);
  assert.equal(state.load().endings.length, 1);
  portalOffline = false; await calls.tick();
  assert.equal(state.load().endings.length, 0);
  assert.deepEqual(reports.at(-1),{event:'ended',reason:'admin_ended'});
});
