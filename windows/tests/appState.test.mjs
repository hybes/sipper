// Ported from SipperTests/AppStateTests.swift, plus the Windows engine hand-off. AppState runs
// against a temporary JSON store, an in-memory password store and a fake engine.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeImportURL, parseImportJSON } from '../src/core/importParser.js';
import { makeAccount, makeContact } from '../src/core/models.js';
import { AppState, recordingFileName } from '../src/main/appState.js';
import { ManagedController } from '../src/main/managedController.js';
import { MemoryPasswordStore } from '../src/main/passwords.js';
import { JSONStore } from '../src/main/store.js';

class FakeEngine extends EventEmitter {
  constructor() {
    super();
    this.isAlive = false;
    this.requests = [];
    this.responses = {
      start: { pjsip: '2.15.1' },
      codecs: [{ id: 'PCMU/8000/1', priority: 128 }, { id: 'opus/48000/2', priority: 128 }],
      audioDevices: [],
      setMeetingAudio: params => ({ claimed: params.enabled }),
    };
  }

  launch() {
    this.isAlive = true;
    return Promise.resolve('2.15.1');
  }

  request(method, params = {}) {
    this.requests.push({ method, params });
    const response = this.responses[method];
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(typeof response === 'function' ? response(params) : response ?? {});
  }

  shutdown() {
    this.isAlive = false;
    return Promise.resolve();
  }

  sent(method) {
    return this.requests.filter((r) => r.method === method);
  }
}

function harness(t, { directory, passwords } = {}) {
  const dir = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sipper-state-'));
  if (!directory) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const store = new JSONStore(dir, { delay: 5 });
  const state = new AppState({
    store,
    passwords: passwords ?? new MemoryPasswordStore(),
    engine,
    platform: { recordingsDirectory: () => path.join(dir, 'recordings') },
    version: '0.1.0',
  });
  const alerts = [];
  const events = [];
  state.on('alert', (alert) => alerts.push(alert));
  for (const name of ['navigate', 'incomingCall', 'ringingEnded', 'missedCall', 'prefillDialer', 'showWindow']) {
    state.on(name, (payload) => events.push({ name, payload }));
  }
  state.load();
  return { state, engine, store, dir, alerts, events, passwords: state.passwords };
}

const draft = (username, profileID, fields = {}) => makeAccount({ username, domain: 'pbx.example.com', profileID, ...fields });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('transfers capture both call identities and ignore stale completion events', async t => {
  const { state, engine } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional');
  const otherAccount = state.addAccount(draft('1002', state.profiles[0].id), 'fictional');
  await state.startEngine();
  const first = { id: 1, accountID: account.id, startedAt: 1000, state: 'confirmed' };
  const second = { ...first, id: 2, startedAt: 2000 };
  const unrelated = { ...first, id: 3, startedAt: 3000, accountID: otherAccount.id };
  state.calls = [first, second, unrelated];
  assert.equal(await state.transfer(first, '2001'), true);
  assert.deepEqual(engine.sent('transfer').at(-1).params, { callId: 1, accountId: account.id, expectedStartedAt: 1000, uri: 'sip:2001@pbx.example.com;transport=udp' });
  assert.equal(await state.attendedTransfer(first, second), true);
  assert.deepEqual(engine.sent('attendedTransfer').at(-1).params, { callId: 1, accountId: account.id, expectedStartedAt: 1000,
    otherCallId: 2, otherAccountId: account.id, otherStartedAt: 2000 });
  for (const target of [first, unrelated, { ...second, startedAt: 1999 }]) assert.equal(await state.attendedTransfer(first, target), false);
  assert.equal(engine.sent('attendedTransfer').length, 1);
  first.isTransferring = true;
  assert.equal(await state.transfer(first, '2001'), false);
  first.isTransferring = false;
  state.calls[0] = { ...first, startedAt: 4000 };
  assert.equal(await state.transfer(first, '2001'), false);
  const event = { callId: 1, accountId: account.id, startedAt: first.startedAt, code: 200, final: true, text: 'Transfer completed' };
  engine.emit('transferStatus', event);
  assert.equal(state.transferStatus, null);
  engine.emit('transferStatus', { ...event, startedAt: 4000, accountId: otherAccount.id });
  assert.equal(state.transferStatus, null);
  engine.emit('transferStatus', { ...event, startedAt: 4000 });
  assert.equal(state.transferStatus, 'Transfer completed');
  assert.equal(engine.sent('hangup').length, 0, 'Native engine alone owns transfer leg cleanup');
  account.isEnabled = false;
  assert.equal(await state.transfer(state.calls[0], '2001'), false);
  assert.equal(engine.sent('transfer').length, 1);
});

test('sleep and network loss invalidate registration until a fresh native observation', async t => {
  const { state, engine } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional');
  await state.startEngine();
  const online = { accountId: account.id, state: 'registered', code: 200, expires: 300 };
  engine.emit('registration', online);
  assert.equal(state.registration(account.id).state, 'registered');
  await state.setSuspended(true);
  engine.emit('registration', online); engine.emit('network', { available: true });
  assert.equal(state.registration(account.id).state, 'failed');
  const manual = engine.sent('setRegistration').length, all = engine.sent('reRegisterAll').length;
  state.reRegister(account.id); state.reRegisterAll();
  assert.equal(engine.sent('setRegistration').length, manual); assert.equal(engine.sent('reRegisterAll').length, all);
  await state.restartEngine();
  assert.equal(engine.sent('start').at(-1).params.suspended, true);
  await state.setSuspended(false);
  assert.equal(state.registration(account.id).state, 'failed');
  engine.emit('network', { available: true }); engine.emit('registration', online);
  assert.equal(state.registration(account.id).state, 'registered');
  engine.emit('network', { available: true });
  assert.equal(state.registration(account.id).state, 'registering', 'A changed route invalidates the previous binding');
  engine.emit('network', { available: false }); engine.emit('registration', online);
  assert.equal(state.registration(account.id).state, 'failed');
  assert.deepEqual(engine.sent('setSuspended').map(r => r.params), [{ suspended: true }, { suspended: false }]);
});

let nextStart = 1_700_000_000_000;
function engineCall(fields = {}) {
  return {
    id: 1, accountId: 'A', direction: 'incoming', state: 'incoming', remote: 'sip:2001@pbx.example.com',
    muted: false, onHold: false, remoteHold: false, activeMedia: false, recording: false,
    startedAt: nextStart++, connectedAt: null, endedAt: null, lastCode: 0, lastText: '', ...fields,
  };
}
const ended = (call, fields = {}) => ({ ...call, state: 'disconnected', endedAt: call.startedAt + 5000, ...fields });

async function gatewayHarness(t) {
  const h = harness(t); t.after(() => h.state.shutdown());
  await h.state.startEngine();
  const config = managedFixture(); config.accounts[0].mode = 'gateway';
  await h.state.applyManagedConfigurations('https://management.example.invalid', [config]);
  const account = h.state.accounts.find(a => a.managed);
  const call = engineCall({ accountId: account.id, startedAt: Date.now(), gatewayCallId: 'abcdef12-3456-4789-8abc-abcdef123456', remote: '"Untrusted caller" <sip:999@evil.example.invalid>' });
  const actions = [];
  const client = { call: async (id, binding, action = 'status') => {
    actions.push(action);
    return { id, configurationId: binding.remoteAccountId, version: action === 'answer' ? 2 : 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: action === 'answer' ? 'answering' : 'ringing',
      claimedByThisDevice: action === 'answer', caller: { name: 'Verified caller', number: '100' } };
  } };
  h.state.configureManagedCalls(client);
  h.engine.responses.setManagedCaller = params => ({ ...call, callerName: params.name, callerNumber: params.number });
  return { ...h, call, account, client, actions };
}

test('gateway caller verification gates incoming UI, updates and history', async t => {
  const h = await gatewayHarness(t);
  let release;
  const original = h.client.call;
  h.client.call = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  h.engine.emit('incomingCall', { call: h.call });
  h.engine.emit('callChanged', { call: h.call });
  assert.equal(h.state.calls.length, 0); assert.equal(h.state.history.length, 0);
  h.engine.emit('callEnded', { call: ended(h.call) }); release(); await tick();
  assert.equal(h.events.filter(e => e.name === 'incomingCall').length, 0);
  assert.equal(h.state.history[0].remoteNumber, 'Incoming managed call');
  assert.ok(!JSON.stringify(h.state.history).includes('Untrusted caller'));
  assert.equal(h.engine.sent('setManagedCaller').length, 0);
});

test('gateway answers require a single server claim and cancellation cannot answer a reused call ID', async t => {
  const h = await gatewayHarness(t);
  h.engine.emit('incomingCall', { call: h.call }); await tick();
  assert.equal(h.state.calls[0].remoteName, 'Verified caller');
  assert.equal(h.state.calls[0].remoteURI, '');
  let release;
  const original = h.client.call;
  h.client.call = async (...args) => {
    if (args[2] === 'answer') await new Promise(resolve => { release = resolve; });
    return original(...args);
  };
  const answer = h.state.answer(h.call.id); await h.state.answer(h.call.id);
  h.state.decline(h.call.id);
  h.engine.emit('callEnded', { call: ended(h.call) });
  const personal = h.state.addAccount(draft('1001', h.state.profiles.find(p => !p.managed).id), 'fictional');
  const replacement = engineCall({ id: h.call.id, accountId: personal.id, startedAt: h.call.startedAt + 10 });
  h.engine.emit('incomingCall', { call: replacement });
  release(); await answer;
  assert.equal(h.actions.filter(action => action === 'answer').length, 1);
  assert.equal(h.engine.sent('answer').length, 0);
  assert.equal(h.state.calls[0].accountID, personal.id);
  assert.ok(h.engine.sent('hangup').every(request => request.params.expectedStartedAt === h.call.startedAt));
  assert.ok(h.actions.includes('decline'));
});

test('gateway native-answer failure releases the reservation and does not claim success', async t => {
  const h = await gatewayHarness(t);
  h.engine.emit('incomingCall', { call: h.call }); await tick();
  h.engine.responses.answer = new Error('Simulated native answer failure');
  await h.state.answer(h.call.id);
  assert.equal(h.engine.sent('answer')[0].params.claimedGatewayCallId, h.call.gatewayCallId);
  assert.ok(h.actions.includes('decline'));
  assert.equal(h.alerts.at(-1).title, 'Could not answer');
  assert.equal(h.events.some(e => e.name === 'showWindow'), false);
});

test('gateway DND and microphone denial decline through the service without answering', async t => {
  for (const mode of ['dnd', 'microphone']) {
    const h = await gatewayHarness(t);
    if (mode === 'dnd') h.state.settings.doNotDisturb = true;
    else h.state.platform.microphoneStatus = () => 'denied';
    h.engine.emit('incomingCall', { call: h.call }); await tick();
    if (mode === 'microphone') await h.state.answer(h.call.id);
    assert.ok(h.actions.includes('decline'));
    assert.equal(h.engine.sent('answer').length, 0);
    if (mode === 'dnd') assert.equal(h.events.some(e => e.name === 'incomingCall'), false);
  }
});

test('explicit null audio permits signalling while normal calls respect microphone denial', async t => {
  for (const nullAudio of [false, true]) {
    const { state, engine, alerts } = harness(t); t.after(() => state.shutdown());
    state.platform.nullAudio = nullAudio;
    state.platform.microphoneStatus = () => 'denied';
    const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional');
    await state.startEngine();
    assert.equal(engine.sent('start').at(-1).params.nullAudio, nullAudio);
    const outgoing = engineCall({ accountId: account.id, direction: 'outgoing', state: 'calling' });
    engine.responses.makeCall = outgoing;
    assert.equal(await state.call('2001', account.id), nullAudio);
    assert.equal(engine.sent('makeCall').length, nullAudio ? 1 : 0);
    if (nullAudio) engine.emit('callEnded', { call: ended(outgoing) });
    const incoming = engineCall({ id: 2, accountId: account.id });
    engine.emit('incomingCall', { call: incoming });
    await state.answer(incoming.id);
    assert.equal(engine.sent('answer').length, nullAudio ? 1 : 0);
    assert.equal(alerts.some(alert => alert.title === 'Microphone access needed'), !nullAudio);
  }
});

test('gateway monitoring dismisses a call answered elsewhere using the captured call identity', async t => {
  const h = await gatewayHarness(t), original = h.client.call;
  let requests = 0;
  h.client.call = async (...args) => {
    const response = await original(...args);
    return ++requests === 1 ? response : { ...response, version: 2, state: 'answering', claimedByThisDevice: false };
  };
  h.engine.emit('incomingCall', { call: h.call }); await tick();
  const hangup = h.engine.sent('hangup').at(-1).params;
  assert.equal(hangup.expectedStartedAt, h.call.startedAt);
  assert.equal(hangup.onlyIfRinging, true);
  assert.equal(h.engine.sent('answer').length, 0);
});

test('a late end event leaves a newer call using the same numeric ID intact', t => {
  const { state, engine, events } = harness(t);
  const old = engineCall({ id: 12 }), current = engineCall({ id: 12 });
  engine.emit('incomingCall', { call: old });
  state.decline(old.id);
  engine.emit('incomingCall', { call: current });
  events.splice(0);
  engine.emit('callEnded', { call: ended(old) });
  assert.equal(state.calls[0].startedAt, current.startedAt);
  assert.equal(state.selectedCallID, current.id);
  assert.equal(events.filter(e => e.name === 'ringingEnded').length, 0);
  assert.equal(state.history.find(record => Date.parse(record.startedAt) === old.startedAt).outcome, 'declined');
  engine.emit('callEnded', { call: ended(current) });
  assert.equal(state.history.find(record => Date.parse(record.startedAt) === current.startedAt).outcome, 'missed');
});

// MARK: Loading

test('first launch creates the default profile', (t) => {
  const { state } = harness(t);
  assert.deepEqual(state.profiles.map((p) => p.name), ['Personal']);
  assert.equal(state.accounts.length, 0);
  assert.equal(state.dialerAccountID, null);
  assert.equal(state.engineStatus.running, false);
  assert.equal(state.pendingImport, null);
});

test('orphaned accounts are adopted by the default profile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipper-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orphan = makeAccount({ profileID: 'MISSING', username: '1001', domain: 'pbx.example.com' });
  new JSONStore(dir).saveNow('accounts.json', [orphan]);
  const { state } = harness(t, { directory: dir });
  assert.deepEqual(state.accounts.map((a) => a.id), [orphan.id]);
  assert.equal(state.accounts[0].profileID, state.profiles[0].id);
  assert.equal(state.dialerAccountID, orphan.id);
});

test('state survives a restart through the store', (t) => {
  const first = harness(t);
  const work = first.state.addProfile({ name: 'Work', colorName: 'green' });
  const account = first.state.addAccount(draft('1001', work.id, { label: 'Desk' }), 'pw');
  const disabled = first.state.addAccount(draft('1002', work.id), 'pw2');
  first.state.setAccountEnabled(disabled.id, false);
  const contact = first.state.addContact({ name: 'Alice', numbers: [{ number: '2001' }] });
  first.state.updateSettings({ ringVolume: 0.25, lastUsedAccountID: account.id });
  first.state.flush();

  const second = harness(t, { directory: first.dir, passwords: first.passwords });
  assert.deepEqual(second.state.profiles.map((p) => p.name), ['Personal', 'Work']);
  assert.deepEqual(second.state.accounts.map((a) => a.id), [account.id, disabled.id]);
  assert.equal(second.state.account(account.id).label, 'Desk');
  assert.equal(second.state.account(disabled.id).isEnabled, false);
  assert.deepEqual(second.state.contacts.map((c) => c.id), [contact.id]);
  assert.equal(second.state.settings.ringVolume, 0.25);
  assert.equal(second.state.dialerAccountID, account.id);
  assert.equal(second.state.passwordFor(account.id), 'pw');
});

test('a corrupt file is set aside instead of overwritten', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipper-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'contacts.json'), '{not json');
  const { state } = harness(t, { directory: dir });
  assert.equal(state.contacts.length, 0);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('contacts.json.corrupt-')));
});

// MARK: Profiles

test('profiles: sort order, trimming, deletion and reordering', (t) => {
  const { state, passwords } = harness(t);
  const personal = state.profiles[0];
  const work = state.addProfile({ name: '  Work  ', colorName: 'orange', iconName: 'briefcase' });
  assert.equal(work.name, 'Work');
  assert.equal(work.sortOrder, 1);
  assert.equal(state.addProfile({ name: '   ' }).name, 'Profile');
  assert.deepEqual(state.profiles.map((p) => p.sortOrder), [0, 1, 2]);

  const moved = state.addAccount(draft('2001', work.id, { domain: 'work.example.com' }), 'pw');
  state.deleteProfile(work.id, personal.id);
  assert.equal(state.account(moved.id).profileID, personal.id);
  assert.equal(passwords.lookup(moved.id).password, 'pw');

  const old = state.addProfile({ name: 'Old' });
  const gone = state.addAccount(draft('3001', old.id), 'pw3');
  state.deleteProfile(old.id, 'UNKNOWN');
  assert.equal(state.account(gone.id), null);
  assert.equal(passwords.lookup(gone.id).status, 'missing');

  while (state.profiles.length > 1) state.deleteProfile(state.profiles[1].id, null);
  state.deleteProfile(state.profiles[0].id, null);
  assert.equal(state.profiles.length, 1, 'the last profile cannot be deleted');

  const b = state.addProfile({ name: 'B' });
  const c = state.addProfile({ name: 'C' });
  state.reorderProfiles([c.id, state.profiles[0].id, b.id]);
  assert.deepEqual(state.profiles.map((p) => p.id), [c.id, personal.id, b.id]);
  assert.deepEqual(state.profiles.map((p) => p.sortOrder), [0, 1, 2]);
});

// MARK: Accounts

test('accounts: passwords, sort order, dialer account, duplicates, updates, deletion and moves', (t) => {
  const { state, passwords } = harness(t);
  const profile = state.profiles[0];
  const first = state.addAccount(draft('1001', profile.id), 's3cret');
  assert.equal(passwords.lookup(first.id).password, 's3cret');
  assert.equal(first.sortOrder, 0);
  assert.equal(state.dialerAccountID, first.id);

  const second = state.addAccount(draft('1002', 'UNKNOWN'), 'other');
  assert.equal(second.profileID, profile.id);
  assert.equal(second.sortOrder, 1);
  assert.equal(state.dialerAccountID, first.id);

  const work = state.addProfile({ name: 'Work' });
  const third = state.addAccount(draft('2001', work.id), 'x');
  assert.equal(third.sortOrder, 0, 'sort order is per profile');

  assert.equal(state.duplicateAccount('1001', 'PBX.Example.COM').id, first.id);
  assert.equal(state.duplicateAccount('1001', 'other.example.com'), null);
  assert.equal(state.duplicateAccount('1001', 'pbx.example.com', first.id), null);

  state.updateAccount({ ...first, label: 'Renamed', transport: 'tls' }, null);
  assert.equal(state.account(first.id).label, 'Renamed');
  assert.equal(state.account(first.id).transport, 'tls');
  assert.equal(passwords.lookup(first.id).password, 's3cret');
  state.updateAccount(state.account(first.id), 'new');
  assert.equal(passwords.lookup(first.id).password, 'new');

  state.moveAccount(second.id, work.id);
  assert.equal(state.account(second.id).profileID, work.id);
  assert.equal(state.account(second.id).sortOrder, 1);
  state.moveAccount(second.id, 'UNKNOWN');
  assert.equal(state.account(second.id).profileID, work.id);

  state.deleteAccount(first.id);
  assert.equal(passwords.lookup(first.id).status, 'missing');
  assert.equal(state.dialerAccountID, second.id);
});

// MARK: Import

const importRequest = (accountsJSON) => parseImportJSON(`{"version":1,"source":{"provider":"fusionpbx"},"accounts":[${accountsJSON}]}`);

test('commit import into a new profile creates the profile and accounts', (t) => {
  const { state, passwords, events, alerts } = harness(t);
  state.pendingImport = importRequest('{"username":"1001","domain":"pbx.example.com","password":"a","label":"Alex"},{"username":"1002","domain":"pbx.example.com","password":"b","transport":"tls"}');
  const imported = state.commitImport(state.pendingImport.candidates.map((c) => c.id), { kind: 'new', name: 'PBX' });
  assert.equal(imported, 2);
  const profile = state.profiles.find((p) => p.name === 'PBX');
  assert.notEqual(profile.colorName, state.profiles[0].colorName);
  const accounts = state.accountsIn(profile.id);
  assert.deepEqual(accounts.map((a) => a.username), ['1001', '1002']);
  assert.deepEqual(accounts.map((a) => a.sortOrder), [0, 1]);
  assert.deepEqual(accounts.map((a) => a.source), ['fusionpbx', 'fusionpbx']);
  assert.deepEqual(accounts.map((a) => passwords.lookup(a.id).password), ['a', 'b']);
  assert.deepEqual(events.at(-1), { name: 'navigate', payload: { kind: 'profile', id: profile.id } });
  assert.equal(state.pendingImport, null);
  assert.equal(alerts.length, 0);
});

test('commit import skips unselected and invalid candidates and falls back to the first profile', (t) => {
  const { state } = harness(t);
  state.pendingImport = importRequest('{"username":"1001","domain":"pbx.example.com","password":"a"},{"username":"1002","domain":"pbx.example.com","password":"b"},{"username":"1003","domain":"pbx.example.com","password":""}');
  const [a, , c] = state.pendingImport.candidates;
  assert.equal(state.commitImport([a.id, c.id], { kind: 'existing', id: 'UNKNOWN' }), 1);
  assert.deepEqual(state.accounts.map((x) => x.username), ['1001']);
  assert.equal(state.accounts[0].profileID, state.profiles[0].id);
  assert.equal(state.profiles.length, 1);
});

test('commit import updates duplicates in place', (t) => {
  const { state, passwords } = harness(t);
  const personal = state.profiles[0];
  const existing = state.addAccount(draft('1001', personal.id, { label: 'Desk', notes: 'keep me', isEnabled: false }), 'old');
  const other = state.addProfile({ name: 'Other' });
  state.pendingImport = importRequest('{"username":"1001","domain":"PBX.example.com","password":"new","transport":"tls","server":"edge.example.com","port":5080,"displayName":"Alex"}');
  state.pendingImport.candidates[0].existingAccountID = existing.id;

  assert.equal(state.commitImport([state.pendingImport.candidates[0].id], { kind: 'existing', id: other.id }), 1);
  assert.equal(state.accounts.length, 1);
  const updated = state.account(existing.id);
  assert.equal(updated.profileID, personal.id);
  assert.equal(updated.label, 'Desk');
  assert.equal(updated.notes, 'keep me');
  assert.equal(updated.domain, 'pbx.example.com');
  assert.equal(updated.displayName, 'Alex');
  assert.equal(updated.transport, 'tls');
  assert.equal(updated.server, 'edge.example.com');
  assert.equal(updated.port, 5080);
  assert.equal(updated.isEnabled, true);
  assert.equal(passwords.lookup(existing.id).password, 'new');
});

test('links: imports annotate duplicates, problems become alerts, sip: and tel: only pre-fill', async (t) => {
  const { state, alerts, events } = harness(t);
  const existing = state.addAccount(draft('1001', state.profiles[0].id), 'old');
  state.handleURL(makeImportURL('{"version":1,"accounts":[{"username":"1001","domain":"PBX.EXAMPLE.COM","password":"x"},{"username":"1002","domain":"pbx.example.com","password":"y"}]}'));
  assert.deepEqual(state.pendingImport.candidates.map((c) => c.existingAccountID), [existing.id, null]);
  const snapshot = state.snapshot(['pendingImport']);
  assert.ok(snapshot.pendingImport.candidates.every((c) => !('password' in c)), 'passwords never leave the main process');
  state.cancelImport();
  assert.equal(state.pendingImport, null);

  state.handleURL('sipper://unknown-action');
  assert.equal(alerts.at(-1).title, 'Unsupported link');
  state.handleURL(makeImportURL('{}'));
  assert.equal(alerts.at(-1).title, 'Import failed');
  assert.match(alerts.at(-1).message, /version/);

  const other = state.addAccount(draft('5000', state.profiles[0].id, { domain: 'other.example.com' }), 'pw');
  state.handleURL('sip:2001@other.example.com');
  assert.deepEqual(events.filter((e) => e.name === 'prefillDialer').at(-1).payload, { text: '2001@other.example.com' });
  assert.equal(state.dialerAccountID, other.id);
  state.handleURL('tel:+44%2020%207946%200958');
  assert.equal(events.filter((e) => e.name === 'prefillDialer').at(-1).payload.text, '+44 20 7946 0958');
  await tick();
  assert.equal(state.calls.length, 0, 'links never dial by themselves');
});

// MARK: Outcomes and history

test('outcome mapping', (t) => {
  const { state } = harness(t);
  const outgoing = (code) => state.outcome({ id: 1, direction: 'outgoing', connectedAt: null, lastStatusCode: code });
  assert.equal(outgoing(486), 'busy');
  assert.equal(outgoing(600), 'busy');
  assert.equal(outgoing(480), 'noAnswer');
  assert.equal(outgoing(408), 'noAnswer');
  assert.equal(outgoing(487), 'cancelled');
  assert.equal(outgoing(603), 'declined');
  assert.equal(outgoing(403), 'declined');
  assert.equal(outgoing(500), 'failed');
  assert.equal(outgoing(0), 'failed');
  assert.equal(state.outcome({ id: 1, direction: 'outgoing', connectedAt: 5, lastStatusCode: 486 }), 'completed');
  assert.equal(state.outcome({ id: 9, direction: 'incoming', connectedAt: null, lastStatusCode: 487 }), 'missed');
});

test('an unanswered incoming call rings, is named from contacts and is recorded as missed', async (t) => {
  const { state, engine, events } = harness(t);
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'pw');
  state.addContact({ name: 'Alice', numbers: [{ number: '020 7946 0958' }] });
  const ringing = engineCall({ id: 7, accountId: account.id, remote: '<sip:02079460958@pbx.example.com>' });

  engine.emit('incomingCall', { call: ringing });
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].remoteName, 'Alice');
  assert.equal(state.selectedCallID, 7);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].endedAt, null);
  const presented = events.find((e) => e.name === 'incomingCall').payload;
  assert.deepEqual(presented.ring, { ringtone: 'classicUK', volume: 0.8 });
  assert.equal(presented.accountLabel, '1001@pbx.example.com');

  engine.emit('callEnded', { call: ended(ringing, { lastCode: 487, lastText: 'Request Terminated' }) });
  assert.equal(state.calls.length, 0);
  assert.equal(state.history.length, 1);
  const [record] = state.history;
  assert.equal(record.outcome, 'missed');
  assert.equal(record.remoteNumber, '02079460958');
  assert.equal(record.remoteName, 'Alice');
  assert.equal(record.statusCode, 487);
  assert.ok(record.endedAt);
  assert.equal(record.connectedAt, null);
  assert.equal(state.unseenMissedCalls, 1);
  assert.equal(state.selectedCallID, null);
  assert.ok(events.some((e) => e.name === 'missedCall'));
  state.markMissedCallsSeen();
  assert.equal(state.unseenMissedCalls, 0);
});

test('declining and hanging up a ringing call record it as declined', (t) => {
  const { state, engine } = harness(t);
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'pw');
  const first = engineCall({ id: 11, accountId: account.id });
  engine.emit('incomingCall', { call: first });
  state.decline(11);
  assert.deepEqual(engine.sent('hangup').at(-1).params, { callId: 11, accountId: account.id, expectedStartedAt: first.startedAt, code: 486, onlyIfRinging: true });
  assert.equal(state.calls.length, 1, 'the call leaves the list when the engine reports the end');
  engine.emit('callEnded', { call: ended(first, { lastCode: 486 }) });
  assert.equal(state.history[0].outcome, 'declined');
  assert.equal(state.unseenMissedCalls, 0);

  const second = engineCall({ id: 12, accountId: account.id });
  engine.emit('incomingCall', { call: second });
  state.hangupActiveCall();
  engine.emit('callEnded', { call: ended(second) });
  assert.equal(state.history[0].outcome, 'declined');
});

test('do not disturb rejects the call as busy and records it as declined', (t) => {
  const { state, engine, events } = harness(t);
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'pw');
  state.toggleDoNotDisturb();
  const ringing = engineCall({ id: 13, accountId: account.id });
  engine.emit('incomingCall', { call: ringing });
  assert.equal(state.selectedCallID, null);
  assert.equal(state.history.length, 0);
  assert.equal(events.filter((e) => e.name === 'incomingCall').length, 0);
  assert.deepEqual(engine.sent('hangup').at(-1).params, { callId: 13, accountId: account.id, expectedStartedAt: ringing.startedAt, code: 486, onlyIfRinging: true });
  engine.emit('callEnded', { call: ended(ringing, { lastCode: 486 }) });
  assert.deepEqual(state.history.map((r) => r.outcome), ['declined']);
  assert.equal(state.unseenMissedCalls, 0);
});

test('a connected incoming call is completed and keeps the name learnt during the call', (t) => {
  const { state, engine } = harness(t);
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'pw');
  const ringing = engineCall({ id: 14, accountId: account.id });
  engine.emit('incomingCall', { call: ringing });
  engine.emit('callChanged', { call: { ...ringing, state: 'confirmed', connectedAt: ringing.startedAt + 1000, remote: '"Alice" <sip:2001@pbx.example.com>' } });
  assert.equal(state.calls[0].state, 'confirmed');
  engine.emit('callEnded', { call: ended(ringing, { connectedAt: ringing.startedAt + 1000, lastCode: 200 }) });
  const [record] = state.history;
  assert.equal(record.outcome, 'completed');
  assert.equal(record.remoteName, 'Alice');
  assert.ok(record.connectedAt);
});

test('a call end without a ring event still produces a record, and history can be deleted and cleared', (t) => {
  const { state, engine } = harness(t);
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'pw');
  engine.emit('callEnded', { call: ended(engineCall({ id: 15, accountId: account.id, direction: 'outgoing', lastCode: 486 })) });
  assert.equal(state.history[0].outcome, 'busy');
  assert.equal(state.history[0].direction, 'outgoing');
  for (const id of [1, 2]) engine.emit('callEnded', { call: ended(engineCall({ id, accountId: account.id, direction: 'outgoing' })) });
  assert.equal(state.history.length, 3);
  state.deleteHistory([state.history[0].id]);
  assert.equal(state.history.length, 2);
  state.clearHistory();
  assert.equal(state.history.length, 0);
});

// MARK: Contacts

test('contacts are sorted, matched by normalised number, updated and deleted', (t) => {
  const { state } = harness(t);
  const bob = state.addContact({ name: 'Bob', numbers: [{ label: 'Work', number: '020-7946-0958' }] });
  const alice = state.addContact({ name: 'alice', numbers: [{ number: '+44 7700 900123' }, { number: '2001' }, { number: '  ' }] });
  assert.deepEqual(state.contacts.map((c) => c.name), ['alice', 'Bob']);
  assert.equal(state.contact(alice.id).numbers.length, 2, 'blank numbers are dropped');
  assert.equal(state.contactForNumber('(020) 7946.0958').id, bob.id);
  assert.equal(state.contactForNumber('+447700900123').id, alice.id);
  assert.equal(state.contactForNumber('2001').id, alice.id);
  assert.equal(state.contactForNumber('07700900123'), null);
  assert.equal(state.contactForNumber(' - () '), null);

  state.updateContact({ ...bob, name: 'Aaron' });
  assert.deepEqual(state.contacts.map((c) => c.name), ['Aaron', 'alice']);
  state.toggleFavorite(alice.id);
  assert.equal(state.contact(alice.id).isFavorite, true);
  state.updateContact(makeContact({ name: 'Nobody' }));
  assert.equal(state.contacts.length, 2);
  state.deleteContact(bob.id);
  assert.deepEqual(state.contacts.map((c) => c.id), [alice.id]);
});

// MARK: Engine hand-off

test('calling without a running engine alerts instead of dialling; blank input is ignored', async (t) => {
  const { state, alerts } = harness(t);
  state.addAccount(draft('1001', state.profiles[0].id), 'pw');
  assert.equal(await state.call('2001'), false);
  assert.equal(alerts.at(-1).title, 'Cannot place call');
  assert.equal(state.history.length, 0);
  const count = alerts.length;
  assert.equal(await state.call('   '), false);
  assert.equal(alerts.length, count);
});

test('starting the engine seeds codecs and hands over active accounts with their passwords', async (t) => {
  const { state, engine } = harness(t);
  const personal = state.profiles[0];
  const work = state.addProfile({ name: 'Work', isEnabled: false });
  const live = state.addAccount(draft('1001', personal.id, { displayName: 'Ben', transport: 'tcp', server: 'edge.example.com', port: 5080 }), 'pw');
  state.addAccount(draft('2001', work.id), 'pw');
  const noPassword = state.addAccount(draft('1002', personal.id), 'x');
  state.passwords.remove(noPassword.id);

  await state.startEngine();
  assert.equal(state.engineStatus.running, true);
  assert.deepEqual(state.settings.codecs.map((c) => c.codecID), ['opus/48000/2', 'PCMU/8000/1']);
  const sync = engine.sent('syncAccounts').at(-1).params;
  assert.deepEqual(sync.accounts, [{
    id: live.id,
    aor: '"Ben" <sip:1001@pbx.example.com>',
    registrar: 'sip:pbx.example.com;transport=tcp',
    proxy: 'sip:edge.example.com:5080;transport=tcp;lr',
    regTimeout: 300,
    authUsername: '1001',
    password: 'pw',
    srtp: 'disabled',
    useIce: false,
    useStun: false,
  }]);
  assert.equal(state.registration(noPassword.id).state, 'failed');
  assert.match(state.registration(noPassword.id).reason, /No password/);

  engine.emit('registration', { accountId: live.id, state: 'registered', code: 200, reason: 'OK', expires: 300 });
  assert.equal(state.registration(live.id).state, 'registered');
  engine.emit('registration', { accountId: 'GONE', state: 'unregistered' });
  assert.equal(state.registrations.GONE, undefined, 'events for deleted accounts are ignored');

  state.setProfileEnabled(work.id, true);
  assert.equal(engine.sent('syncAccounts').at(-1).params.accounts.length, 2);
});

test('placing a call dials the account URI, selects the call and survives an early end event', async (t) => {
  const { state, engine, alerts } = harness(t);
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'pw');
  await state.startEngine();
  engine.emit('registration', { accountId: account.id, state: 'registered', code: 200, expires: 300 });

  const outgoing = engineCall({ id: 3, accountId: account.id, direction: 'outgoing', state: 'calling', remote: 'sip:2001@pbx.example.com;transport=udp' });
  engine.responses.makeCall = () => outgoing;
  assert.equal(await state.call(' 020 7946 '), true);
  assert.deepEqual(engine.sent('makeCall').at(-1).params, { accountId: account.id, uri: 'sip:0207946@pbx.example.com;transport=udp' });
  assert.equal(state.selectedCallID, 3);
  assert.equal(state.history.length, 1);
  assert.equal(state.settings.lastUsedAccountID, account.id);

  assert.equal(await state.call('2002'), false, 'A connecting leg cannot safely be held for consultation');
  assert.equal(engine.sent('makeCall').length, 1);
  engine.emit('callEnded', { call: ended(outgoing) });
  alerts.splice(0);
  // The end event can be handled before the makeCall reply: no phantom call, no second record.
  const quick = engineCall({ id: 4, accountId: account.id, direction: 'outgoing', state: 'calling' });
  engine.responses.makeCall = () => {
    engine.emit('callEnded', { call: ended(quick, { lastCode: 404, lastText: 'Not Found' }) });
    return quick;
  };
  await state.call('2002');
  assert.equal(state.calls.some((c) => c.id === 4), false);
  assert.equal(state.history.filter((r) => r.statusCode === 404).length, 1);
  assert.equal(alerts.length, 0);
});

test('new call preparation preserves the current call and returns to controls after call actions', async t => {
  const { state, engine, events } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional');
  const other = state.addAccount(draft('1002', state.profiles[0].id, { domain: 'other.example.com' }), 'fictional');
  await state.startEngine();
  state.prepareNewCall();
  assert.equal(state.showingNewCall, false, 'An idle draft cannot hide a later incoming call');
  const first = engineCall({ id: 3, accountId: account.id, state: 'confirmed', connectedAt: Date.now() });
  engine.emit('callChanged', { call: first });
  state.setDialerAccount(other.id);
  state.prepareNewCall();
  assert.equal(state.snapshot().showingNewCall, true);
  assert.equal(state.dialerAccountID, account.id, 'Consultation defaults to the current call account');
  assert.deepEqual(events.filter(e => e.name === 'prefillDialer').at(-1).payload, { text: '' });
  state.selectCall(first.id);
  assert.equal(state.showingNewCall, false);
  assert.equal(engine.sent('setHold').length, 0, 'Opening and cancelling never holds a call');
  assert.equal(engine.sent('hangup').length, 0);
  state.prepareNewCall('2001', other.id);
  assert.equal(state.dialerAccountID, other.id, 'Explicit account choices survive');
  state.handleURL('sip:2002@other.example.com');
  assert.equal(state.showingNewCall, true);
  assert.equal(state.dialerAccountID, other.id);
  assert.equal(events.filter(e => e.name === 'prefillDialer').at(-1).payload.text, '2002@other.example.com');
  assert.equal(engine.sent('makeCall').length, 0, 'Links prefill without dialling');

  state.prepareNewCall('', account.id);
  engine.responses.makeCall = new Error('Fixture call failed');
  assert.equal(await state.call('2003'), false);
  assert.equal(state.showingNewCall, true, 'Failed attempts keep the draft available');
  const second = engineCall({ id: 4, accountId: account.id, direction: 'outgoing', state: 'confirmed', connectedAt: Date.now() });
  engine.responses.makeCall = second;
  assert.equal(await state.call('2003'), true);
  assert.equal(state.showingNewCall, false);
  assert.equal(state.activeCall.id, second.id);
  assert.equal(engine.sent('makeCall').at(-1).params.accountId, account.id);
  assert.ok(engine.sent('setHold').some(r => r.params.callId === first.id && r.params.hold));
  state.prepareNewCall();
  await state.swapToCall(first.id);
  assert.equal(state.showingNewCall, false);
  assert.equal(state.activeCall.id, first.id);

  const incoming = engineCall({ id: 5, accountId: account.id });
  engine.emit('incomingCall', { call: incoming });
  state.prepareNewCall();
  await state.answer(incoming.id);
  assert.equal(state.showingNewCall, false, 'Answering returns to the selected call controls');
  assert.equal(state.activeCall.id, incoming.id);
  state.prepareNewCall();
  for (const call of [first, second, incoming]) engine.emit('callEnded', { call: ended(call) });
  assert.equal(state.calls.length, 0);
  assert.equal(state.showingNewCall, false, 'The last call ending clears the consultation form');
});

test('hold failures stop consultation, answer and swap without changing the selected call', async t => {
  const { state, engine, alerts } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional');
  await state.startEngine();
  const first = engineCall({ id: 3, accountId: account.id, state: 'confirmed', connectedAt: Date.now() });
  const second = engineCall({ id: 4, accountId: account.id, state: 'confirmed', onHold: true, connectedAt: Date.now() });
  engine.emit('callChanged', { call: first }); engine.emit('callChanged', { call: second });
  state.selectCall(first.id); state.prepareNewCall();
  let rejectHold;
  engine.responses.setHold = () => new Promise((resolve, reject) => { rejectHold = reject; });
  const consultation = state.call('2003');
  await tick();
  assert.equal(engine.sent('makeCall').length, 0, 'The second call waits for the hold command');
  assert.equal(await state.call('2004'), false, 'A concurrent dial cannot bypass the pending hold');
  rejectHold(new Error('Fixture hold rejected'));
  assert.equal(await consultation, false);
  assert.equal(state.showingNewCall, true); assert.equal(state.activeCall.id, first.id);
  assert.deepEqual(engine.sent('setHold').at(-1).params, { callId: first.id, accountId: account.id, expectedStartedAt: first.startedAt, hold: true });
  engine.responses.setHold = new Error('Fixture hold rejected');
  await state.swapToCall(second.id);
  assert.equal(state.activeCall.id, first.id);
  assert.equal(engine.sent('setHold').at(-1).params.callId, first.id, 'A failed hold must not proceed to resume the other leg');
  await state.toggleHold(first.id);
  assert.equal(alerts.at(-1).title, 'Could not change hold');
  const incoming = engineCall({ id: 5, accountId: account.id });
  engine.emit('incomingCall', { call: incoming });
  await state.answer(incoming.id);
  assert.equal(engine.sent('answer').length, 0);
  assert.equal(state.calls.find(c => c.id === first.id).isOnHold, false);
  assert.equal(state.calls.find(c => c.id === incoming.id).state, 'incoming');
  assert.equal(alerts.at(-1).title, 'Could not answer');
});

test('the engine stopping unexpectedly ends calls and restarts it', async (t) => {
  const { state, engine } = harness(t);
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'pw');
  await state.startEngine();
  engine.emit('incomingCall', { call: engineCall({ id: 2, accountId: account.id }) });
  engine.isAlive = false;
  engine.emit('exit', { code: 1 });
  assert.equal(state.calls.length, 0);
  assert.equal(state.engineStatus.running, false);
  assert.match(state.engineStatus.error, /unexpectedly/);
  assert.equal(state.history[0].statusText, 'Engine stopped');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await tick();
  assert.equal(state.engineStatus.running, true);
  await state.shutdown();
});

test('recording file names are safe and describe the call', () => {
  const name = recordingFileName({ direction: 'incoming', remoteName: 'A/B: "C"', remoteNumber: '2001' }, 'Desk <1>', new Date(2026, 8, 14, 9, 5, 7));
  assert.equal(name, '2026-09-14 09.05.07 from A-B- -C- 2001 via Desk -1-.wav');
});

const managedFixture = () => ({
  schemaVersion: 1, organisation: { id: '11111111-1111-4111-8111-111111111111', name: 'Example managed company' },
  deviceId: '22222222-2222-4222-8222-222222222222', revision: 'b'.repeat(64), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  accounts: [{ id: '33333333-3333-4333-8333-333333333333', label: 'Managed desk', mode: 'direct', revision: 1,
    password: 'managed-fixture-secret', settings: { username: '100', authUsername: '', domain: 'pbx.example.invalid', server: 'sip.example.invalid',
      port: null, transport: 'tls', srtp: 'required', displayName: '', voicemailNumber: '*97', useICE: true, stunServer: '' } }],
});

test('managed accounts stay out of personal JSON and renderer credentials while reaching the engine', async t => {
  const { state, store, engine } = harness(t);
  const manual = state.addAccount({ username: '100', domain: 'pbx.example.invalid', profileID: state.profiles[0].id }, 'personal-fixture');
  await state.startEngine();
  state.applyManagedConfigurations('https://management.example.invalid', [managedFixture()]);
  const account = state.accounts.find(a => a.managed);
  assert.equal(state.accounts.length, 2); assert.equal(state.duplicateAccount('100', 'pbx.example.invalid').id, manual.id);
  assert.equal(state.passwordFor(account.id), ''); assert.equal(state.passwords.lookup(account.id).status, 'missing');
  const rendered = state.snapshot().accounts.find(a => a.id === account.id);
  assert.equal(rendered.domain, ''); assert.equal(rendered.authUsername, ''); assert.equal(rendered.server, '');
  assert.ok(!JSON.stringify(state.snapshot()).includes('managed-fixture-secret'));
  const sent = engine.sent('syncAccounts').at(-1).params.accounts.find(a => a.id === account.id);
  assert.equal(sent.password, 'managed-fixture-secret'); assert.equal(sent.srtp, 'mandatory'); assert.ok(sent.managedUntil > Date.now());
  state.flush();
  assert.equal(store.load('accounts.json').length, 1); assert.equal(store.load('profiles.json').length, 1);
  assert.equal(store.load('accounts.json')[0].id, manual.id);
});

test('manual CRUD and imports cannot alter managed profiles, accounts or reserved credentials', t => {
  const { state } = harness(t); state.applyManagedConfigurations('https://management.example.invalid', [managedFixture()]);
  const account = state.accounts.find(a => a.managed), profile = state.profile(account.profileID), personal = state.profiles.find(p => !p.managed);
  assert.throws(() => state.updateAccount({ ...account, managed: undefined }, 'changed'));
  assert.throws(() => state.addAccount({ ...account, managed: undefined }, 'changed'));
  assert.throws(() => state.deleteAccount(account.id)); assert.throws(() => state.setAccountEnabled(account.id, false));
  assert.throws(() => state.moveAccount(account.id, personal.id)); assert.throws(() => state.updateProfile({ ...profile, managed: undefined }));
  assert.throws(() => state.deleteProfile(profile.id));
  assert.throws(() => state.addAccount({ profileID: profile.id, username: '200', domain: 'example.invalid' }, 'new'));
  state.deleteProfile(personal.id); assert.ok(state.profile(personal.id));
  state.applyManagedConfigurations('https://management.example.invalid', []);
  assert.equal(state.accounts.length, 0); assert.equal(state.managedPasswords.size, 0);
  assert.throws(() => state.addAccount({ id: account.id, profileID: personal.id, username: '100', domain: 'example.invalid' }, 'reused'));
});

test('managed identities remain stable on refresh and expired or disconnected accounts cannot fall back to personal calls', async t => {
  const { state, engine } = harness(t); await state.startEngine();
  state.addAccount({ username: '200', domain: 'example.invalid', profileID: state.profiles[0].id }, 'personal');
  const config = managedFixture(); state.applyManagedConfigurations('https://management.example.invalid', [config]);
  const id = state.accounts.find(a => a.managed).id;
  state.applyManagedConfigurations('https://management.example.invalid', [{ ...config, expiresAt: new Date(Date.now() + 7200_000).toISOString() }]);
  assert.equal(state.accounts.find(a => a.managed).id, id);
  state.account(id).managed.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(await state.call('123', id), false); assert.equal(engine.sent('makeCall').length, 0);
  state.applyManagedConfigurations('https://management.example.invalid', []);
  assert.equal(await state.call('123', id), false); assert.equal(engine.sent('makeCall').length, 0);
});

test('direct calling preference survives validation and reaches only the managed engine account', async t => {
  const { state, engine } = harness(t); await state.startEngine();
  state.addAccount({ username: '200', domain: 'example.invalid', profileID: state.profiles[0].id }, 'personal');
  const config = managedFixture(); config.accounts[0].doNotDisturb = true;
  await state.applyManagedConfigurations('https://management.example.invalid', [config]);
  const mapped = state.accounts.find(a => a.managed);
  assert.equal(mapped.managed.doNotDisturb, true);
  const applied = engine.sent('syncAccounts').at(-1).params.accounts;
  assert.equal(applied.find(a => a.id === mapped.id).managedDoNotDisturb, true);
  assert.equal(applied.find(a => a.id !== mapped.id).managedDoNotDisturb, undefined);
  for (const value of [null, 'true', 1]) {
    config.accounts[0].doNotDisturb = value;
    assert.throws(() => state.applyManagedConfigurations('https://management.example.invalid', [config]));
  }
});

class FixtureManagedClient extends EventEmitter {
  origin = 'https://management.example.invalid';
  configs = [managedFixture()];
  reports = [];
  snapshot() { return { signedIn: true, busy: false, signingIn: false, identity: { id: 'fixture', email: 'person@example.invalid' }, organisations: [], enrollments: [], error: null }; }
  configurations() { return structuredClone(this.configs.filter(c => Date.parse(c.expiresAt) > Date.now())); }
  async report(deviceId, payload) { this.reports.push({ deviceId, payload }); }
  cancelSignIn() {}
}

test('desktop message alerts are opt-in, deduplicated, paged and fenced across opt-out, withdrawal and shutdown', async t => {
  const { state } = harness(t), client = new FixtureManagedClient(), delivered = [];
  client.configs = [];
  const org = '11111111-1111-4111-8111-111111111111', device = '22222222-2222-4222-8222-222222222222';
  const status = { signedIn: true, identity: {id:'fixture'}, organisations:[{id:org,status:'active',licensed:true}], enrollments:[{deviceId:device,organisationId:org}] };
  client.snapshot = () => structuredClone(status);
  let requests = 0, cleared = 0, refreshes = 0, held;
  let page = { alerts:[{conversationId:'33333333-3333-4333-8333-333333333333',sequence:'10000000000000000',expiresAt:new Date(Date.now()+240_000).toISOString()}], nextCursor:'10000000000000000' };
  const cursors = [];
  client.messageAlerts = async (id, {after}) => { assert.equal(id,device); requests++; cursors.push(after); if(held) await held; return page; };
  client.refresh = async () => {refreshes++;};
  const controller = new ManagedController({client,state,metadata:{},onMessage: hint => delivered.push(hint),clearMessages: () => {cleared++;}});
  t.after(() => controller.stop());
  const poll = () => {controller.messageAttempt=-Infinity;return controller.pollMessages();};
  await poll(); assert.equal(requests,0); assert.equal(state.settings.messageNotifications,false);
  state.updateSettings({messageNotifications:true}); await poll();
  assert.equal(delivered.length,1); assert.deepEqual(Object.keys(delivered[0]).sort(),['conversationId','deviceId','expiresAt']);
  assert.equal(await controller.openMessage(delivered[0]),true); assert.equal(refreshes,1);
  await controller.pollMessages(); assert.equal(requests,1,'Five-second request limit');
  page={...page,nextCursor:null}; await poll(); assert.equal(delivered.length,1); assert.equal(cursors.at(-1),'10000000000000000');
  page={alerts:[{...page.alerts[0],conversationId:'44444444-4444-4444-8444-444444444444',sequence:'9007199254740993'}],nextCursor:null};
  await poll(); assert.equal(delivered.length,2); assert.equal(cursors.at(-1),'0','Each complete scan restarts, catching lower-sequence late commits');
  const oldHint=delivered[0]; assert.equal(await controller.openMessage(oldHint),false);
  let resume; held=new Promise(resolve=>{resume=resolve;}); const pending=poll();
  const before=cleared;
  state.updateSettings({messageNotifications:false}); state.updateSettings({messageNotifications:true});
  assert.ok(cleared>before); resume(); await pending; held=null;
  assert.equal(delivered.length,2,'Re-enabling cannot revive the earlier in-flight response');
  await poll(); assert.equal(delivered.length,3);
  status.organisations[0].licensed=false; client.emit('change');
  assert.equal(await controller.openMessage(delivered[2]),false);
  await poll(); assert.equal(delivered.length,3);
  status.organisations[0].licensed=true; client.emit('change');
  held=new Promise(resolve=>{resume=resolve;}); const stopping=poll(); controller.stop(); resume(); await stopping;
  assert.equal(delivered.length,3,'A late response cannot post after shutdown');
  assert.equal(state.engineStatus.running,false,'Message alerts do not start the SIP engine');
});

test('network recovery refreshes managed settings and detaches at shutdown', async t => {
  const { state, engine } = harness(t); t.after(() => state.shutdown());
  const client = new FixtureManagedClient();
  let refreshes = 0;
  client.load = () => {};
  client.refresh = async () => { refreshes++; };
  const controller = new ManagedController({ client, state, metadata: {} }); t.after(() => controller.stop());
  controller.start(); await tick();
  assert.equal(refreshes, 1);
  engine.emit('networkRecovered'); engine.emit('networkRecovered'); await tick();
  assert.equal(refreshes, 2, 'Concurrent recovery signals share the active refresh');
  controller.stop(); engine.emit('networkRecovered'); await tick();
  assert.equal(refreshes, 2);
});

test('directory calling uses the exact managed customer account and never falls back', async t => {
  const { state } = harness(t), client = new FixtureManagedClient();
  const controller = new ManagedController({ client, state, metadata: {} }); t.after(() => controller.stop());
  controller.reconcile();
  const managed = state.accounts.find(a => a.managed), personal = state.addAccount(draft('personal', state.profiles.find(p => !p.managed).id), 'fixture');
  const calls = [];
  state.call = (number, accountId) => { calls.push({ number, accountId }); return true; };
  client.directoryNumber = (_device, _contact, number) => {
    assert.equal(number, '101'); return { number, deviceId: managed.managed.deviceId, organisationId: managed.managed.organisationId };
  };
  const call = id => controller.callDirectory(managed.managed.deviceId, 'contact-fixture', '101', id);
  assert.throws(() => call(personal.id)); assert.throws(() => call('missing'));
  assert.equal(call(managed.id), true); assert.deepEqual(calls, [{ number: '101', accountId: managed.id }]);
  state.profile(managed.profileID).isEnabled = false; assert.throws(() => call(managed.id));
  state.profile(managed.profileID).isEnabled = true;
  managed.managed.organisationId = 'other-customer';
  client.directoryNumber = () => ({ number: '101', deviceId: '22222222-2222-4222-8222-222222222222', organisationId: '11111111-1111-4111-8111-111111111111' });
  assert.throws(() => call(managed.id));
  managed.managed.organisationId = '11111111-1111-4111-8111-111111111111'; managed.managed.deviceId = 'other-device'; assert.throws(() => call(managed.id));
  managed.managed.deviceId = '22222222-2222-4222-8222-222222222222'; managed.managed.expiresAt = new Date(0).toISOString(); assert.throws(() => call(managed.id));
  state.applyManagedConfigurations(client.origin, []); assert.throws(() => call(managed.id));
  assert.equal(calls.length, 1);
});

test('controller reports only observed SIP status and acknowledges settings only after engine application', async t => {
  const { state, engine } = harness(t); await state.startEngine();
  const client = new FixtureManagedClient();
  const controller = new ManagedController({ client, state, metadata: {} }); t.after(() => controller.stop());
  controller.reconcile();
  const account = state.accounts.find(a => a.managed);
  engine.responses.syncAccounts = { appliedAccountIds: [] };
  await controller.report();
  assert.equal(client.reports.at(-1).payload.applied, false);
  assert.deepEqual(client.reports.at(-1).payload.registrations, [{ accountId: account.managed.remoteAccountId, state: 'unknown' }]);

  engine.responses.syncAccounts = { appliedAccountIds: [account.id] };
  engine.emit('registration', { accountId: account.id, state: 'registered', code: 200, expires: 300 });
  await controller.report();
  assert.equal(client.reports.at(-1).payload.applied, true);
  assert.equal(client.reports.at(-1).payload.revision, client.configs[0].revision);
  assert.deepEqual(client.reports.at(-1).payload.registrations, [{ accountId: account.managed.remoteAccountId, state: 'registered', sipCode: 200 }]);
  assert.ok(!JSON.stringify(client.reports).includes('pbx.example.invalid'));
  assert.ok(!JSON.stringify(client.reports).includes('managed-fixture-secret'));
  engine.emit('network', { available: false });
  await controller.report();
  assert.deepEqual(client.reports.at(-1).payload.registrations, [{ accountId: account.managed.remoteAccountId, state: 'failed' }], 'Offline state cannot inherit the old successful SIP code');
  engine.emit('network', { available: true });
  engine.emit('registration', { accountId: account.id, state: 'registered', code: 200, expires: 300 });
  state.registrations[account.id].since = Date.now() - 400_000;
  await controller.report();
  assert.deepEqual(client.reports.at(-1).payload.registrations, [{ accountId: account.managed.remoteAccountId, state: 'unregistered' }]);
  engine.responses.syncAccounts = new Error('fixture engine failure');
  await controller.report();
  assert.equal(client.reports.at(-1).payload.applied, false);
});

test('controller removes expired or revoked runtime credentials and ignores a stale application reply', async t => {
  const { state, engine } = harness(t); await state.startEngine();
  const personal = state.addAccount(draft('1001', state.profiles[0].id), 'fixture personal');
  const client = new FixtureManagedClient();
  const controller = new ManagedController({ client, state, metadata: {} }); t.after(() => controller.stop());
  controller.reconcile();
  assert.equal(state.accounts.length, 2);
  client.configs[0].expiresAt = new Date(Date.now() - 1).toISOString();
  controller.reconcile();
  assert.deepEqual(state.accounts.map(a => a.id), [personal.id]); assert.equal(state.managedPasswords.size, 0);
  client.configs = [managedFixture()]; client.emit('change');
  await controller.applying;
  let release;
  engine.responses.syncAccounts = () => new Promise(resolve => { release = resolve; });
  const pending = controller.report(); await tick();
  engine.responses.syncAccounts = {};
  client.configs = []; client.emit('change');
  release({ appliedAccountIds: [] }); await pending;
  assert.equal(client.reports.length, 0);
  assert.deepEqual(state.accounts.map(a => a.id), [personal.id]); assert.equal(state.managedPasswords.size, 0);
  client.configs = [managedFixture(), managedFixture()]; client.emit('change');
  assert.match(state.managed.error, /could not be applied/);
  assert.deepEqual(state.accounts.map(a => a.id), [personal.id]);
});

test('managed call history retains its source across restarts and never redials through a personal account', async t => {
  const { state, engine, dir } = harness(t); await state.startEngine();
  state.addAccount(draft('1001', state.profiles[0].id), 'personal fixture');
  await state.applyManagedConfigurations('https://management.example.invalid', [managedFixture()]);
  const account = state.accounts.find(a => a.managed);
  const incoming = engineCall({ id: 4, accountId: account.id });
  engine.emit('incomingCall', { call: incoming });
  engine.emit('callEnded', { call: ended(incoming) });
  assert.equal(state.history[0].isManaged, true);
  const recordId = state.history[0].id;
  await state.applyManagedConfigurations('https://management.example.invalid', []);
  state.flush();
  const restored = harness(t, { directory: dir }); await restored.state.startEngine();
  assert.equal(restored.state.history[0].isManaged, true);
  assert.equal(await restored.state.callBack(recordId), false);
  assert.equal(restored.engine.sent('makeCall').length, 0);
});


test('changed activity skips duplicate engine work, throttles retries and preserves heartbeats', async t => {
  const { state, engine } = harness(t); await state.startEngine();
  const client = new FixtureManagedClient(), controller = new ManagedController({ client, state, metadata: {} });
  t.after(() => controller.stop()); controller.reconcile();
  const account = state.accounts.find(a => a.managed);
  engine.responses.syncAccounts = { appliedAccountIds: [account.id] };
  await controller.report();
  const syncs = engine.sent('syncAccounts').length;
  await controller.report(true); assert.equal(client.reports.length, 1); assert.equal(engine.sent('syncAccounts').length, syncs);
  state.calls = [{ id: 1, accountID: account.id, direction: 'incoming', state: 'incoming', remoteNumber: 'private-caller' }];
  await controller.report(true); assert.equal(client.reports.length, 1);
  controller.activityAttempt = -Infinity;
  const originalReport = client.report.bind(client);
  client.report = async () => { throw new Error('Fixture offline'); };
  await assert.rejects(controller.report(true));
  client.report = originalReport;
  await controller.report(true); assert.equal(client.reports.length, 1, 'Failure also sets the retry deadline');
  controller.activityAttempt = -Infinity;
  await controller.report(true); assert.equal(client.reports.length, 2);
  assert.equal(client.reports.at(-1).payload.directCalls[0].ringing, 1);
  assert.ok(!JSON.stringify(client.reports).includes('private-caller'));
  await controller.report(true); assert.equal(client.reports.length, 2);
  await controller.report(); assert.equal(client.reports.length, 3, 'Heartbeat sends even unchanged activity');
  state.calls = []; controller.activityAttempt = -Infinity;
  await controller.report(true); assert.equal(client.reports.at(-1).payload.directCalls[0].ringing, 0);
  controller.stop(); const count = client.reports.length;
  await controller.report(true); assert.equal(client.reports.length, count);
});


test('a changed-report revision conflict refreshes settings instead of withdrawing them', async t => {
  const { state, engine } = harness(t); await state.startEngine();
  const client = new FixtureManagedClient(), controller = new ManagedController({ client, state, metadata: {} });
  t.after(() => controller.stop()); controller.reconcile();
  const account = state.accounts.find(a => a.managed);
  engine.responses.syncAccounts = { appliedAccountIds: [account.id] };
  let refreshes = 0, conflict = true;
  client.refresh = async () => { refreshes++; };
  const originalReport = client.report.bind(client);
  client.report = async (...args) => {
    if (conflict) { conflict = false; throw Object.assign(new Error('Changed settings'), { code: 'configuration_changed' }); }
    await originalReport(...args);
  };
  await controller.reportChanges();
  assert.equal(refreshes, 1); assert.equal(client.reports.length, 1);
  assert.ok(state.accounts.some(a => a.id === account.id));
  state.calls = [{ accountID: account.id, direction: 'incoming', state: 'incoming' }]; controller.activityAttempt = -Infinity;
  client.report = async () => { throw new Error('Offline'); };
  await controller.reportChanges();
  assert.equal(refreshes, 1, 'Network failure must not create a provisioning retry loop');
  assert.equal(client.reports.length, 1); assert.ok(state.accounts.some(a => a.id === account.id));
});

test('meetings hold phone audio and return only to the captured call without archiving an owner', async t => {
  const { state, engine, dir } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional');
  await state.startEngine();
  const original = { id: 1, accountID: account.id, startedAt: 1000, state: 'confirmed', isOnHold: false, isMuted: true };
  state.calls = [{ ...original }]; state.selectedCallID = original.id;
  engine.responses.setHold = params => {
    state.calls = state.calls.map(call => call.id === params.callId && call.startedAt === params.expectedStartedAt
      ? { ...call, isOnHold: params.hold } : call);
  };
  const reference = '11111111-1111-4111-8111-111111111111';
  await state.claimMeetingAudio(reference);
  assert.equal(state.calls[0].isOnHold, true); assert.equal(state.ownsMeetingAudio(reference), true);
  assert.equal(state.snapshot().meetingActive, true); assert.equal(JSON.stringify(state.snapshot()).includes(reference), false);
  state.flush(); assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.json'))
    .some(name => fs.readFileSync(path.join(dir, name), 'utf8').includes(reference)), false);
  await assert.rejects(state.claimMeetingAudio('22222222-2222-4222-8222-222222222222'), /updating/);
  await state.releaseMeetingAudio('22222222-2222-4222-8222-222222222222'); assert.equal(state.meetingActive, true);
  await state.restartEngine(); assert.equal(engine.sent('start').at(-1).params.meetingAudioReference, reference);
  await state.releaseMeetingAudio(reference);
  assert.equal(state.meetingActive, false); assert.equal(state.calls[0].isOnHold, false); assert.equal(state.calls[0].isMuted, true);
  assert.deepEqual(engine.sent('setMeetingAudio').map(request => request.params.enabled), [true, false]);
  await state.claimMeetingAudio(reference);
  state.calls = [{ ...original, startedAt: 2000, isOnHold: true }];
  const before = engine.sent('setHold').length; await state.releaseMeetingAudio(reference);
  assert.equal(engine.sent('setHold').length, before, 'Returning cannot resume a reused native call slot');
});

test('closing during a pending meeting hold waits for it and prevents a late audio claim', async t => {
  const { state, engine } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional'); await state.startEngine();
  state.calls = [{ id: 1, accountID: account.id, startedAt: 1000, state: 'confirmed', isOnHold: false }];
  let complete;
  engine.responses.setHold = params => params.hold ? new Promise(resolve => { complete = () => {
    state.calls = state.calls.map(call => ({ ...call, isOnHold: true })); resolve();
  }; }) : (() => { state.calls = state.calls.map(call => ({ ...call, isOnHold: false })); })();
  const reference = '33333333-3333-4333-8333-333333333333';
  const joining = assert.rejects(state.claimMeetingAudio(reference), /cancelled/);
  while (!complete) await tick();
  let released = false; const leaving = state.releaseMeetingAudio(reference).then(() => { released = true; });
  await tick(); assert.equal(released, false); assert.equal(state.meetingActive, true);
  complete(); await Promise.all([joining, leaving]);
  assert.equal(state.meetingActive, false); assert.equal(state.calls[0].isOnHold, false);
  assert.equal(engine.sent('setMeetingAudio').length, 0, 'A cancelled join never claims native hardware');
});

test('phone resume leaves the meeting first and does not temporarily restore a different held call', async t => {
  const { state, engine } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional'); await state.startEngine();
  state.calls = [{ id: 1, accountID: account.id, startedAt: 1000, state: 'confirmed', isOnHold: false },
    { id: 2, accountID: account.id, startedAt: 2000, state: 'confirmed', isOnHold: true }];
  state.selectedCallID = 1;
  engine.responses.setHold = params => { state.calls = state.calls.map(call => call.id === params.callId ? { ...call, isOnHold: params.hold } : call); };
  const reference = '44444444-4444-4444-8444-444444444444'; await state.claimMeetingAudio(reference);
  state.platform.beforePhoneAudio = () => state.releaseMeetingAudio(reference, { restore: false });
  const before = engine.requests.length; await state.swapToCall({ ...state.calls[1] });
  const requests = engine.requests.slice(before);
  assert.equal(requests[0].method, 'setMeetingAudio'); assert.equal(requests[0].params.enabled, false);
  assert.deepEqual(requests.filter(request => request.method === 'setHold').map(request => [request.params.callId, request.params.hold]), [[2, false]]);
  assert.equal(state.calls[0].isOnHold, true); assert.equal(state.calls[1].isOnHold, false);
});

test('conference hold rolls back a rejected participant and never restores a reused slot', async t => {
  const { state, engine, alerts } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional');
  await state.startEngine();
  const raw = [1, 2].map(id => engineCall({ id, accountId: account.id, state: 'confirmed', activeMedia: true,
    connectedAt: Date.now(), conferenceId: 'fixture-group' }));
  const emit = value => engine.emit('callChanged', { call: value }); raw.forEach(emit);
  let failSecond = true, failRestore = false;
  engine.responses.setHold = p => {
    assert.equal(p.conferenceId, 'fixture-group');
    if (p.callId === 2 && failSecond) throw new Error('Fixture second hold rejected');
    if (p.callId === 1 && !p.hold && failRestore) throw new Error('Fixture restore rejected');
    const index = raw.findIndex(c => c.id === p.callId);
    raw[index] = { ...raw[index], onHold: p.hold, activeMedia: !p.hold }; emit(raw[index]);
  };
  await state.toggleHold(state.calls[0]);
  assert.deepEqual(engine.sent('setHold').map(r => [r.params.callId, r.params.hold]), [[1, true], [2, true], [1, false]]);
  assert.equal(state.calls.every(c => !c.isOnHold), true);
  assert.match(alerts.at(-1).message, /second hold rejected/);
  assert.equal(state.snapshot().changingAudio, false);
  failSecond = false; await state.toggleHold(state.calls[0]);
  assert.equal(state.calls.every(c => c.isOnHold), true);
  await state.swapToCall(state.calls[0]);
  assert.equal(state.calls.every(c => !c.isOnHold), true);
  failSecond = true; failRestore = true;
  await state.toggleHold(state.calls[0]);
  assert.match(alerts.at(-1).message, /could not be restored/);
  assert.equal(state.calls[0].isOnHold, true); assert.equal(state.calls[1].isOnHold, false);
  failSecond = false; failRestore = false;
  await state.toggleHold(state.calls[1]);
  assert.equal(state.calls.every(c => !c.isOnHold), true, 'Shared resume repairs a partially held conference from either member');
  const oldFirst = state.calls[0];
  engine.responses.setHold = p => {
    if (p.callId === 2) {
      engine.emit('callEnded', { call: ended(raw[0]) });
      emit({ ...raw[0], startedAt: raw[0].startedAt + 1000, conferenceId: undefined, onHold: false });
      throw new Error('Fixture participant ended');
    }
    raw[0] = { ...raw[0], onHold: true, activeMedia: false }; emit(raw[0]);
  };
  engine.requests.splice(0);
  await state.toggleHold(oldFirst);
  assert.equal(engine.sent('setHold').length, 2, 'Rollback must not touch a newly reused call slot');
  state.toggleMute(oldFirst); state.sendDTMF('12', oldFirst); state.hangup(oldFirst);
  assert.equal(engine.sent('setMuted').length, 0); assert.equal(engine.sent('sendDtmf').length, 0); assert.equal(engine.sent('hangup').length, 0);
});

test('conference creation, shared controls and separation use exact identities and one audio gate', async t => {
  const { state, engine } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional');
  const unrelatedAccount = state.addAccount(draft('1002', state.profiles[0].id), 'fictional');
  await state.startEngine();
  let raw = [1, 2, 3].map(id => engineCall({ id, accountId: id === 3 ? unrelatedAccount.id : account.id,
    state: 'confirmed', activeMedia: id !== 1, onHold: id === 1, connectedAt: Date.now() }));
  const emit = value => engine.emit('callChanged', { call: value }); raw.forEach(emit);
  const first = state.calls[0], second = state.calls[1], third = state.calls[2];
  assert.equal(await state.mergeConference(first, third), false);
  assert.equal(await state.mergeConference({ ...first, startedAt: first.startedAt - 1 }, second), false);
  let finishHold;
  engine.responses.setHold = p => {
    const update = () => { const index = raw.findIndex(c => c.id === p.callId); raw[index] = { ...raw[index], onHold: p.hold, activeMedia: !p.hold }; emit(raw[index]); };
    if (p.callId === 3 && !finishHold) return new Promise(resolve => { finishHold = () => { update(); resolve({}); }; });
    update();
  };
  engine.responses.beginConference = p => {
    for (const id of [p.callId, p.otherCallId]) { const i = raw.findIndex(c => c.id === id); raw[i] = { ...raw[i], conferenceId: 'native-group' }; emit(raw[i]); }
    return raw.find(c => c.id === p.callId);
  };
  const merge = state.mergeConference(first, second); await tick();
  assert.equal(state.snapshot().changingAudio, true);
  assert.equal(await state.mergeConference(first, second), false);
  assert.equal(await state.call('2001'), false);
  finishHold(); assert.equal(await merge, true);
  assert.deepEqual(engine.sent('setHold').map(r => [r.params.callId, r.params.hold]), [[3, true], [1, false]]);
  assert.equal(state.calls.filter(c => c.conferenceID === 'native-group').length, 2);
  const group = state.calls[0];
  state.toggleMute(group); state.sendDTMF('2x#', state.calls[1]);
  assert.deepEqual(engine.sent('setMuted').at(-1).params, { callId: group.id, accountId: group.accountID, expectedStartedAt: group.startedAt, muted: true });
  assert.equal(engine.sent('sendDtmf').at(-1).params.callId, 2);
  assert.equal(engine.sent('sendDtmf').at(-1).params.digits, '2#');
  assert.equal(await state.transfer(group, '2001'), false);
  engine.requests.splice(0);
  await state.swapToCall(state.calls.find(c => c.id === 3));
  assert.deepEqual(engine.sent('setHold').map(r => [r.params.callId, r.params.hold]), [[1, true], [2, true], [3, false]], 'A group is held once when switching to an unrelated call');
  engine.requests.splice(0);
  await state.swapToCall(state.calls.find(c => c.id === 1));
  assert.deepEqual(engine.sent('setHold').map(r => [r.params.callId, r.params.hold]), [[3, true], [1, false], [2, false]], 'Resuming a group never holds one of its own participants');
  engine.responses.splitConference = () => { raw = raw.map(c => ({ ...c, conferenceId: undefined })); raw.forEach(emit); };
  engine.requests.splice(0);
  assert.equal(await state.separateConference(group), true);
  assert.deepEqual(engine.sent('setHold').map(r => [r.params.callId, r.params.hold]), [[1, true], [2, true], [1, false]]);
  assert.equal(state.calls.find(c => c.id === 2).isOnHold, true);
  assert.equal(state.calls.find(c => c.id === 1).isOnHold, false);
  assert.equal(state.calls.find(c => c.id === 3).isOnHold, true);
  assert.equal(await state.endConference(group), false, 'A separated group reference cannot end its former calls');
});

test('failed merge restores consultation hold and failed split resume leaves separate calls safely held', async t => {
  const { state, engine, alerts } = harness(t); t.after(() => state.shutdown());
  const account = state.addAccount(draft('1001', state.profiles[0].id), 'fictional'); await state.startEngine();
  let raw = [1, 2].map(id => engineCall({ id, accountId: account.id, state: 'confirmed', activeMedia: id !== 1, onHold: id === 1, connectedAt: Date.now() }));
  const emit = value => engine.emit('callChanged', { call: value }); raw.forEach(emit);
  engine.responses.setHold = p => { const i = raw.findIndex(c => c.id === p.callId); raw[i] = { ...raw[i], onHold: p.hold, activeMedia: !p.hold }; emit(raw[i]); };
  engine.responses.beginConference = new Error('Fixture mixer rejected');
  assert.equal(await state.mergeConference(state.calls[0], state.calls[1]), false);
  assert.deepEqual(engine.sent('setHold').map(r => r.params.hold), [false, true]);
  raw = raw.map(c => ({ ...c, conferenceId: 'split-group', onHold: false, activeMedia: true })); raw.forEach(emit);
  const captured = state.calls[0];
  engine.responses.splitConference = () => { raw = raw.map(c => ({ ...c, conferenceId: undefined })); raw.forEach(emit); engine.responses.setHold = new Error('Fixture resume rejected'); };
  assert.equal(await state.separateConference(captured), false);
  assert.equal(state.calls.every(c => c.isOnHold && !c.conferenceID), true);
  assert.match(alerts.at(-1).message, /calls are separate/);
  assert.equal(state.changingAudio, false);
});
