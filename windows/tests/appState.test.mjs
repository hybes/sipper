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

let nextStart = 1_700_000_000_000;
function engineCall(fields = {}) {
  return {
    id: 1, accountId: 'A', direction: 'incoming', state: 'incoming', remote: 'sip:2001@pbx.example.com',
    muted: false, onHold: false, remoteHold: false, activeMedia: false, recording: false,
    startedAt: nextStart++, connectedAt: null, endedAt: null, lastCode: 0, lastText: '', ...fields,
  };
}
const ended = (call, fields = {}) => ({ ...call, state: 'disconnected', endedAt: call.startedAt + 5000, ...fields });

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
  assert.deepEqual(engine.sent('hangup').at(-1).params, { callId: 11, code: 486 });
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
  assert.deepEqual(engine.sent('hangup').at(-1).params, { callId: 13, code: 486 });
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
