import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedClient, managedOrigin } from '../src/main/managedClient.js';
import { directCallReport } from '../src/main/managedAccounts.js';
import { ManagedStorage } from '../src/main/managedStorage.js';
import { setupReference } from '../src/main/managedSetupLink.js';
import { callUnavailable, validateConfiguration } from '../src/main/managedContracts.js';

const org = '11111111-1111-4111-8111-111111111111', device = '22222222-2222-4222-8222-222222222222', account = '33333333-3333-4333-8333-333333333333';
const origin = 'https://management.example.invalid';
function configuration(now) {
  return { schemaVersion: 1, organisation: { id: org, name: 'Example company' }, deviceId: device,
    revision: 'a'.repeat(64), expiresAt: new Date(now + 3600_000).toISOString(), accounts: [{
      id: account, label: 'Support', mode: 'direct', revision: 1, password: 'fictional-secret',
      settings: { username: '100', authUsername: '', domain: 'pbx.example.invalid', server: 'sip.example.invalid', port: null,
        transport: 'tls', srtp: 'required', displayName: '', voicemailNumber: '*97', useICE: true, stunServer: '' },
    }] };
}
function harness(t) {
  let now = Date.now(), stored = null, opened;
  const requests = [], response = { user: { id: 'fixture-user', email: 'person@example.invalid' }, organisations: [{ id: org, name: 'Example company', licensed: true, status: 'active' }] };
  const control = { configStatus: 200, apiStatus: 200, offline: false, refreshDenied: false, failSave: false, pauseToken: null };
  const store = { read: () => structuredClone(stored), save: value => { if (control.failSave) throw new Error('Test disk failure'); stored = structuredClone(value); }, clear: () => { stored = null; } };
  const fetch = async (input, options = {}) => {
    const url = new URL(input), body = String(options.body ?? '');
    requests.push({ url, options, body });
    assert.equal(url.origin, origin); assert.equal(options.redirect, 'error');
    if (control.offline) throw new Error('offline fixture');
    if (url.pathname.endsWith('/token')) {
      if (control.pauseToken) await control.pauseToken;
      if (control.refreshDenied && body.includes('refresh_token')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'fixture-access-token', refresh_token: body.includes('grant_type=refresh_token') ? 'rotated-fixture-refresh' : 'fixture-refresh-token', token_type: 'Bearer', expires_in: 300 });
    }
    if (url.pathname.endsWith('/revoke')) return Response.json({});
    if (control.apiStatus !== 200) return Response.json({ code: 'denied' }, { status: control.apiStatus });
    if (url.pathname.endsWith('/organisations')) return Response.json(response);
    if (url.pathname.endsWith('/calling-preference')) {
      if (control.pausePreference) await control.pausePreference;
      const value = JSON.parse(body);
      if ((control.preferenceStatus ?? 200) === 200) Object.assign(response.organisations.find(org => url.pathname.includes(org.id)), value);
      return Response.json(control.preferenceResponse ?? value, { status: control.preferenceStatus ?? 200 });
    }
    if (url.pathname.endsWith('/setup-links/redeem')) {
      if (control.pauseSetup) await control.pauseSetup;
      return Response.json(control.setup ?? { userId: response.user.id, organisation: response.organisations[0] }, { status: control.setupStatus ?? 200 });
    }
    if (url.pathname.endsWith('/configuration')) {
      if (control.pauseConfiguration) await control.pauseConfiguration;
      const config = configuration(now); if (control.gateway) config.accounts[0].mode = 'gateway';
      return Response.json(config, { status: control.configStatus });
    }
    if (url.pathname.includes('/messages/')) {
      if (control.pauseMessages) await control.pauseMessages;
      return control.messageHandler ? control.messageHandler(url, options) : Response.json(control.messages, { status: control.messageStatus ?? 200 });
    }
    if (url.pathname.includes('/conferencing/')) {
      if (control.pauseMeetings) await control.pauseMeetings;
      return control.meetingHandler ? control.meetingHandler(url, options) : Response.json(control.meetings, { status: control.meetingStatus ?? 200 });
    }
    if (url.pathname.endsWith('/directory')) {
      if (control.pauseDirectory) await control.pauseDirectory;
      return control.directoryHandler ? control.directoryHandler(url) : Response.json(control.directory, { status: control.directoryStatus ?? 200 });
    }
    if (url.pathname.endsWith('/directory/status')) {
      if (control.pauseStatus) await control.pauseStatus;
      return Response.json(control.sharedStatus, { status: control.sharedStatusCode ?? 200 });
    }
    if (url.pathname.includes('/calls/')) {
      if (control.pauseCall) await control.pauseCall;
      return Response.json(control.call, { status: control.callStatus ?? 200 });
    }
    if (url.pathname.endsWith('/devices') && options.method === 'POST') return Response.json({ id: device, platform: 'windows', name: 'Example PC' });
    return Response.json({ accepted: control.reportAccepted ?? true });
  };
  const make = () => new ManagedClient({ origin, store, fetch, openBrowser: async value => { opened = new URL(value); }, now: () => now });
  const client = make(); t.after(() => client.cancelSignIn());
  const callback = (state = opened.searchParams.get('state')) => `sipper://oauth/callback?code=fixture-code&state=${state}`;
  const login = async () => { await client.signIn(); await client.handleCallback(callback()); assert.equal(client.snapshot().signedIn, true, client.snapshot().error); };
  return { client, store, make, requests, control, response, callback, login, opened: () => opened, stored: () => stored, now: () => now, advance: ms => { now += ms; } };
}
const enrollment = { name: 'Example PC', appVersion: 'test', osVersion: 'test' };

test('calling preference changes are confirmed, customer-bound and unknown after failure or encrypted reload', async t => {
  const h = harness(t), other = randomUUID();
  h.response.organisations[0].doNotDisturb = false;
  h.response.organisations[0].licensed = false;
  h.response.organisations.push({ id: other, name: 'Other company', status: 'active', licensed: false, doNotDisturb: false });
  await h.login();
  await h.client.setDoNotDisturb(org, true);
  const request = h.requests.find(r => r.url.pathname.endsWith('/calling-preference'));
  assert.equal(request.options.method, 'PATCH'); assert.deepEqual(JSON.parse(request.body), { doNotDisturb: true });
  assert.equal(h.client.snapshot().organisations[0].doNotDisturb, true);
  assert.equal(h.client.snapshot().organisations[1].doNotDisturb, false);
  assert.deepEqual(h.client.configurations(), []);
  assert.throws(() => h.client.setDoNotDisturb(org, 'false'));
  await assert.rejects(h.client.setDoNotDisturb(randomUUID(), true));
  h.control.preferenceStatus = 403;
  await assert.rejects(h.client.setDoNotDisturb(org, false));
  assert.equal(h.client.snapshot().organisations[0].doNotDisturb, undefined);
  h.control.preferenceStatus = 200;
  await h.client.refresh();
  assert.equal(h.client.snapshot().organisations[0].doNotDisturb, true);
  h.control.preferenceResponse = { doNotDisturb: 'false' };
  await assert.rejects(h.client.setDoNotDisturb(org, false));
  assert.equal(h.client.snapshot().organisations[0].doNotDisturb, undefined);
  delete h.control.preferenceResponse; await h.client.refresh();
  await h.client.setDoNotDisturb(org, true); await h.client.refresh();
  const restored = h.make(); restored.load();
  assert.equal(restored.snapshot().organisations[0].doNotDisturb, undefined);
  await restored.refresh(); assert.equal(restored.snapshot().organisations[0].doNotDisturb, true);
  h.control.offline = true;
  await assert.rejects(h.client.refresh());
  assert.ok(h.client.snapshot().organisations.every(o => o.doNotDisturb === undefined));
  h.control.offline = false; h.response.organisations[0].status = 'suspended'; await h.client.refresh();
  await assert.rejects(h.client.setDoNotDisturb(org, false));
  delete h.response.organisations[0].doNotDisturb; await h.client.refresh();
  assert.equal(h.client.snapshot().organisations[0].doNotDisturb, undefined, 'old servers do not become a false Off');
});

test('availability is confirmed independently of DND and is unknown after failed writes or reload', async t => {
  const h = harness(t);
  Object.assign(h.response.organisations[0], { availability: 'unset', doNotDisturb: true });
  await h.login(); await h.client.setAvailability(org, 'away');
  assert.equal(h.client.snapshot().organisations[0].availability, 'away');
  assert.equal(h.client.snapshot().organisations[0].doNotDisturb, true);
  assert.deepEqual(JSON.parse(h.requests.find(r => r.url.pathname.endsWith('/calling-preference')).body), { availability: 'away' });
  assert.throws(() => h.client.setAvailability(org, 'online'));
  await assert.rejects(h.client.setAvailability(randomUUID(), 'busy'));
  h.control.preferenceResponse = { availability: 'available' };
  await assert.rejects(h.client.setAvailability(org, 'busy'));
  assert.equal(h.client.snapshot().organisations[0].availability, undefined);
  assert.equal(h.client.snapshot().organisations[0].doNotDisturb, true);
  delete h.control.preferenceResponse; await h.client.refresh();
  await h.client.setAvailability(org, 'unset'); await h.client.refresh();
  const restored = h.make(); restored.load();
  assert.equal(restored.snapshot().organisations[0].availability, undefined);
  h.control.offline = true; await assert.rejects(h.client.refresh());
  assert.equal(h.client.snapshot().organisations[0].availability, undefined);
  h.control.offline = false; delete h.response.organisations[0].availability; await h.client.refresh();
  await assert.rejects(h.client.setAvailability(org, 'busy'));
});

test('a late preference response cannot restore signed-out state', async t => {
  const h = harness(t); h.response.organisations[0].doNotDisturb = false; await h.login();
  let release; h.control.pausePreference = new Promise(resolve => { release = resolve; });
  const change = h.client.setDoNotDisturb(org, true);
  while (!h.requests.some(r => r.url.pathname.endsWith('/calling-preference'))) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.client.snapshot().organisations[0].doNotDisturb, false, 'never optimistically show an unconfirmed write');
  await h.client.signOut(); release(); await assert.rejects(change);
  assert.deepEqual(h.client.snapshot().organisations, []); assert.equal(h.client.snapshot().signedIn, false);
});

const directoryContact = () => ({ id: randomUUID(), name: 'Example Reception', company: 'Fictional Company', revision: 1,
  updatedAt: new Date().toISOString(), numbers: [{ label: 'Work', number: '+12025550101' }] });
const directoryPage = (contacts = [directoryContact()], revision = randomUUID(), more = false) => ({
  organisation: { id: org, name: 'Example company' }, deviceId: device, revision,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(), contacts, nextCursor: more ? contacts.at(-1).id : null,
});
const directoryReady = async t => { const h = harness(t); await h.login(); await h.client.connect(org, enrollment); return h; };

test('shared status binds to current contacts, expires quickly and never persists or survives withdrawal', async t => {
  const h = await directoryReady(t); h.control.directory = directoryPage();
  const directory = await h.client.refreshDirectory(device), contactId = directory.contacts[0].id;
  const good = { deviceId: device, organisationId: org, revision: directory.revision,
    expiresAt: new Date(Date.now() + 30_000).toISOString(), contacts: [{ contactId, availability: 'away', doNotDisturb: true }] };
  h.control.sharedStatus = good;
  const saved = JSON.stringify(h.stored());
  assert.deepEqual((await h.client.directoryStatus(device, [contactId])).contacts, good.contacts);
  assert.equal(JSON.stringify(h.stored()), saved);
  assert.deepEqual(JSON.parse(h.requests.at(-1).body), { contactIds: [contactId], revision: directory.revision });
  for (const ids of [[], [randomUUID()], [contactId, contactId]]) await assert.rejects(h.client.directoryStatus(device, ids));
  const activity = { state: 'in_call', source: 'device', observedAt: new Date().toISOString() };
  h.control.sharedStatus = { ...good, contacts: [{ contactId, availability: null, doNotDisturb: null, activity }] };
  assert.deepEqual((await h.client.directoryStatus(device, [contactId])).contacts[0].activity, activity);
  for (const patch of [{ state: 'online' }, { source: 'pbx' }, { observedAt: '2020-01-01T00:00:00Z' },
    { observedAt: new Date(Date.now() + 120_000).toISOString() }, { observedAt: new Date(Date.now() - 160_000).toISOString() }]) {
    h.control.sharedStatus = { ...good, contacts: [{ contactId, availability: null, doNotDisturb: null, activity: { ...activity, ...patch } }] };
    await assert.rejects(h.client.directoryStatus(device, [contactId]), { code: 'invalid_response' });
  }
  assert.equal(JSON.stringify(h.stored()), saved);
  for (const patch of [{ deviceId: randomUUID() }, { organisationId: randomUUID() }, { revision: randomUUID() },
    { contacts: [] }, { contacts: [good.contacts[0], good.contacts[0]] },
    { contacts: [{ ...good.contacts[0], contactId: randomUUID() }] },
    { contacts: [{ ...good.contacts[0], availability: 'online' }] },
    { contacts: [{ ...good.contacts[0], availability: null }] },
    { expiresAt: new Date(Date.now() - 1000).toISOString() }, { expiresAt: new Date(Date.now() + 120_000).toISOString() }]) {
    h.control.sharedStatus = { ...good, ...patch };
    await assert.rejects(h.client.directoryStatus(device, [contactId]), { code: 'invalid_response' });
  }
  h.control.sharedStatus = { ...good, contacts: [{ contactId, availability: null, doNotDisturb: null }] };
  assert.equal((await h.client.directoryStatus(device, [contactId])).contacts[0].availability, null);
  h.control.sharedStatus = good; h.control.offline = true;
  await assert.rejects(h.client.directoryStatus(device, [contactId]), { code: 'unavailable' });
  h.control.offline = false; h.control.sharedStatusCode = 403;
  await assert.rejects(h.client.directoryStatus(device, [contactId]), { code: 'access_denied' });
  assert.equal(h.client.directorySnapshot(device), null);
  h.control.sharedStatusCode = 200; await h.client.refreshDirectory(device);
  let release; h.control.pauseStatus = new Promise(resolve => { release = resolve; });
  const before = h.requests.length, pending = h.client.directoryStatus(device, [contactId]);
  const denied = assert.rejects(pending);
  while (!h.requests.slice(before).some(r => r.url.pathname.endsWith('/directory/status'))) await new Promise(resolve => setImmediate(resolve));
  await h.client.disconnect(device); release(); await denied;
  assert.equal(h.client.directorySnapshot(device), null);
});

test('directory publishes complete bound pages, earliest expiry and safe renderer metadata', async t => {
  const h = await directoryReady(t), contacts = Array.from({ length: 101 }, directoryContact), revision = randomUUID();
  const first = directoryPage(contacts.slice(0, 100), revision, true), second = directoryPage(contacts.slice(100), revision);
  first.expiresAt = new Date(Date.now() + 120_000).toISOString();
  let pages = 0;
  h.control.directoryHandler = url => {
    assert.equal(h.client.directorySnapshot(device), null, 'Partial pages are not visible');
    if (pages++ === 0) { assert.equal(url.search, ''); return Response.json(first); }
    assert.equal(url.searchParams.get('after'), contacts[99].id); assert.equal(url.searchParams.get('revision'), revision);
    return Response.json(second);
  };
  const result = await h.client.refreshDirectory(device);
  assert.equal(pages, 2); assert.equal(result.contacts.length, 101); assert.equal(result.expiresAt, first.expiresAt);
  assert.ok(!JSON.stringify(h.client.snapshot()).includes('+12025550101'));
  assert.ok(!JSON.stringify(result).includes('fictional-secret'));
  const restored = h.make(); restored.load(); assert.deepEqual(restored.directorySnapshot(device), result);
  assert.deepEqual(h.client.directoryNumber(device, contacts[0].id, '+12025550101'), { number: '+12025550101', deviceId: device, organisationId: org });
  assert.throws(() => h.client.directoryNumber(device, contacts[0].id, '999'));
  assert.throws(() => h.client.directoryNumber(device, randomUUID(), '+12025550101'));
  h.advance(121_000); h.client.expireDirectories();
  assert.equal(h.client.directorySnapshot(device), null); assert.equal(h.stored().enrollments[0].directory, null);
});

test('directory rejects mixed revisions and repeated cursors, restarting a changed snapshot only once', async t => {
  const h = await directoryReady(t), contacts = Array.from({ length: 100 }, directoryContact), revision = randomUUID();
  let step = 0;
  h.control.directoryHandler = url => {
    step++;
    if (step === 1) return Response.json(directoryPage(contacts, revision, true));
    if (step === 2) return Response.json({}, { status: 409 });
    assert.equal(url.search, ''); return Response.json(directoryPage([]));
  };
  assert.equal((await h.client.refreshDirectory(device)).contacts.length, 0); assert.equal(step, 3);
  h.control.directoryHandler = () => Response.json(directoryPage(contacts, revision, true));
  await assert.rejects(h.client.refreshDirectory(device), { code: 'invalid_directory' });
  assert.equal(h.client.directorySnapshot(device).contacts.length, 0, 'The last complete snapshot survives a bad response');
  step = 0; h.control.directoryHandler = () => { step++; return Response.json(directoryPage(contacts, randomUUID(), true)); };
  await assert.rejects(h.client.refreshDirectory(device), { code: 'directory_changed' }); assert.equal(step, 4);
});

test('directory validates contact data, identity binding and secure-save success before exposing it', async t => {
  const h = await directoryReady(t);
  for (const alteration of [page => { page.organisation.id = randomUUID(); }, page => { page.deviceId = randomUUID(); },
    page => { page.expiresAt = '2020-01-01T00:00:00Z'; }, page => { page.contacts[0].name = 'bad\nlabel'; },
    page => { page.contacts.push(page.contacts[0]); }, page => { page.nextCursor = randomUUID(); }]) {
    h.control.directory = directoryPage(); alteration(h.control.directory);
    await assert.rejects(h.client.refreshDirectory(device), { code: 'invalid_directory' });
  }
  for (const number of ['sip:user@example.invalid', 'https://example.invalid', '＋123', '+', '1;2', '1'.repeat(65)]) {
    h.control.directory = directoryPage(); h.control.directory.contacts[0].numbers[0].number = number;
    await assert.rejects(h.client.refreshDirectory(device), { code: 'invalid_directory' });
  }
  assert.equal(h.client.directorySnapshot(device), null);
  h.control.directory = directoryPage(); h.control.failSave = true;
  await assert.rejects(h.client.refreshDirectory(device), { code: 'invalid_directory' });
  assert.equal(h.client.directorySnapshot(device), null);
  h.control.failSave = false; await h.client.refreshDirectory(device);
  const archive = structuredClone(h.stored()); archive.enrollments[0].directory.userId = 'another-user'; h.store.save(archive);
  const restored = h.make(); restored.load(); assert.equal(restored.snapshot().signedIn, false);
  assert.match(restored.snapshot().error, /could not be unlocked/);
});

test('directory preserves unexpired data offline and removes it on denial, sign-out and cold expiry', async t => {
  const h = await directoryReady(t); h.control.directory = directoryPage();
  const original = await h.client.refreshDirectory(device);
  h.control.offline = true; await assert.rejects(h.client.refreshDirectory(device), { code: 'unavailable' });
  assert.deepEqual(h.client.directorySnapshot(device), original);
  h.control.offline = false; h.control.directoryStatus = 403;
  await assert.rejects(h.client.refreshDirectory(device), { code: 'access_denied' });
  assert.equal(h.stored().enrollments[0].directory, null);
  h.control.directoryStatus = 200; await h.client.refreshDirectory(device);
  h.control.directoryStatus = 403; h.control.failSave = true;
  await assert.rejects(h.client.refreshDirectory(device), { code: 'storage_unavailable' });
  assert.equal(h.client.directorySnapshot(device), null, 'Failed persistence cannot retain runtime access');
  h.control.failSave = false; h.control.directoryStatus = 200; await h.client.refreshDirectory(device);
  h.advance(3601_000); const restored = h.make(); restored.load();
  assert.equal(restored.directorySnapshot(device), null); assert.equal(h.stored().enrollments[0].directory, null);
  await h.client.signOut(); assert.equal(h.client.directorySnapshot(device), null); assert.equal(h.stored(), null);
});

test('concurrent configuration denial and disconnect fence pending directory responses', async t => {
  const h = await directoryReady(t); h.control.directory = directoryPage();
  let resumeConfig; h.control.pauseConfiguration = new Promise(resolve => { resumeConfig = resolve; });
  const before = h.requests.length, refresh = h.client.refresh();
  const rejected = assert.rejects(refresh, { code: 'access_denied' });
  while (!h.requests.slice(before).some(r => r.url.pathname.endsWith('/configuration'))) await new Promise(resolve => setImmediate(resolve));
  await h.client.refreshDirectory(device); // Replaces the enrolment object while configuration is in flight.
  h.control.configStatus = 403; resumeConfig(); await rejected;
  assert.equal(h.client.directorySnapshot(device), null); assert.deepEqual(h.client.configurations(), []);
  assert.equal(h.stored().enrollments[0].configuration, null); assert.equal(h.stored().enrollments[0].directory, null);
  h.control.pauseConfiguration = null; h.control.configStatus = 200; await h.client.refresh();
  let resumeDirectory; h.control.pauseDirectory = new Promise(resolve => { resumeDirectory = resolve; });
  const start = h.requests.length, pending = h.client.refreshDirectory(device), cancelled = assert.rejects(pending, { code: 'access_denied' });
  while (!h.requests.slice(start).some(r => r.url.pathname.endsWith('/directory'))) await new Promise(resolve => setImmediate(resolve));
  await h.client.disconnect(device); resumeDirectory(); await cancelled;
  assert.equal(h.client.directorySnapshot(device), null); assert.equal(h.stored().enrollments.length, 0);
});

test('setup references accept only an exact link for the configured origin', () => {
  const ref = 'a'.repeat(43), web = `${origin}/portal/setup#ref=${ref}`;
  const native = `sipper://setup?server=${encodeURIComponent(origin)}&reference=${ref}`;
  assert.equal(setupReference(web, origin), ref);
  assert.equal(setupReference(native, origin), ref);
  assert.equal(setupReference(`${origin}:443/portal/setup#ref=${ref}`, origin), ref);
  for (const value of [web.replace('management.', 'other.'), web.replace('https:', 'http:'), web.replace('/setup', '/other'),
    web.replace('#ref=', '?ref='), web + '&extra=1', native + '&reference=' + ref, native + '&extra=1', native + '#x',
    native.replace('sipper://', 'https://'), native.replace('setup?', 'setup:123?'), native.replace('setup?', 'user@setup?'),
    native.replace(encodeURIComponent(origin), encodeURIComponent(origin + '/other')), native.replace(ref, 'short'), 'x'.repeat(4097)]) {
    assert.throws(() => setupReference(value, origin), /setup link is invalid/);
  }
});

test('setup redemption is authenticated, binds the identity and never stores the reference', async t => {
  const h = harness(t), reference = 'b'.repeat(43), link = `${origin}/portal/setup#ref=${reference}`;
  await assert.rejects(h.client.connectSetupLink(link, enrollment), { code: 'sign_in_required' });
  assert.equal(h.requests.length, 0);
  await h.login();
  const before = h.requests.length;
  await assert.rejects(h.client.connectSetupLink(link.replace('management.', 'other.'), enrollment), { code: 'invalid_setup_link' });
  assert.equal(h.requests.length, before);
  h.control.setup = { userId: 'someone-else', organisation: h.response.organisations[0] };
  await assert.rejects(h.client.connectSetupLink(link, enrollment), { code: 'invalid_response' });
  assert.equal(h.client.snapshot().enrollments.length, 0);
  h.control.setup = { userId: 'fixture-user', organisation: { ...h.response.organisations[0], licensed: false } };
  await assert.rejects(h.client.connectSetupLink(link, enrollment), { code: 'invalid_response' });
  h.control.setupStatus = 404;
  await assert.rejects(h.client.connectSetupLink(link, enrollment), { code: 'setup_unavailable' });
  h.control.setupStatus = 200; h.control.setup = undefined;
  await h.client.connectSetupLink(link, enrollment);
  assert.equal(h.client.snapshot().enrollments[0].configured, true);
  const request = h.requests.find(r => r.url.pathname.endsWith('/setup-links/redeem'));
  assert.equal(request.options.headers.authorization, 'Bearer fixture-access-token');
  assert.deepEqual(JSON.parse(request.body), { reference });
  assert.ok(!request.url.href.includes(reference));
  assert.ok(!JSON.stringify(h.stored()).includes(reference));
  assert.ok(!JSON.stringify(h.client.snapshot()).includes(reference));
});

test('a late setup redemption cannot enrol after sign-out', async t => {
  const h = harness(t); await h.login();
  let release; h.control.pauseSetup = new Promise(resolve => { release = resolve; });
  const connecting = h.client.connectSetupLink(`${origin}/portal/setup#ref=${'c'.repeat(43)}`, enrollment);
  const rejected = assert.rejects(connecting, { code: 'cancelled' });
  while (!h.requests.some(r => r.url.pathname.endsWith('/setup-links/redeem'))) await new Promise(resolve => setImmediate(resolve));
  await h.client.signOut(); release(); await rejected;
  assert.equal(h.client.snapshot().signedIn, false);
  assert.equal(h.client.snapshot().enrollments.length, 0);
  assert.equal(h.requests.filter(r => r.url.pathname.endsWith('/devices')).length, 0);
});

test('native OAuth checks state, sends PKCE and resource, and binds the verified identity before storage', async t => {
  const h = harness(t); await h.client.signIn();
  assert.equal(h.opened().searchParams.get('client_id'), 'sipper-windows');
  assert.equal(h.opened().searchParams.get('code_challenge_method'), 'S256');
  await h.client.handleCallback(h.callback('wrong-state'));
  assert.equal(h.requests.length, 0); assert.equal(h.stored(), null);
  await h.client.handleCallback(h.callback());
  assert.equal(h.client.snapshot().identity.email, 'person@example.invalid');
  const body = new URLSearchParams(h.requests[0].body);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), h.opened().searchParams.get('code_challenge'));
  assert.equal(body.get('resource'), `${origin}/api/client`); assert.equal(body.has('client_secret'), false);
  assert.equal(h.stored().identity.id, 'fixture-user');
  assert.ok(!JSON.stringify(h.client.snapshot()).includes('fixture-access-token'));
});

test('enrolment, cache restore, refresh rotation and status reports keep secrets out of snapshots', async t => {
  const h = harness(t); await h.login(); await h.client.connect(org, enrollment);
  assert.equal(h.client.configurations()[0].accounts[0].password, 'fictional-secret');
  assert.equal(h.client.snapshot().enrollments[0].configured, true);
  assert.ok(!JSON.stringify(h.client.snapshot()).includes('fictional-secret'));
  const restored = h.make(); restored.load(); assert.equal(restored.configurations().length, 1);
  h.advance(300_000);
  await h.client.report(device, { revision: h.client.configurations()[0].revision, applied: true, registrations: [{ accountId: account, state: 'registered', sipCode: 200 }] });
  assert.equal(h.stored().tokens.refreshToken, 'rotated-fixture-refresh');
  assert.deepEqual(JSON.parse(h.requests.find(r => r.url.pathname.endsWith('/report')).body).registrations, [{ accountId: account, state: 'registered', sipCode: 200 }]);
  h.advance(3600_000); assert.equal(restored.configurations().length, 0);
});

test('revoked access clears settings; transient failures keep only the remaining lease', async t => {
  const h = harness(t); await h.login(); await h.client.connect(org, enrollment);
  h.control.offline = true; await assert.rejects(h.client.refresh()); assert.equal(h.client.configurations().length, 1);
  h.control.offline = false; h.control.configStatus = 403;
  await assert.rejects(h.client.refresh()); assert.equal(h.client.configurations().length, 0);
  assert.equal(h.stored().enrollments[0].configuration, null);
});

test('reports omit unconfirmed revisions and reject stale acknowledgements', async t => {
  const h = harness(t); await h.login(); await h.client.connect(org, enrollment);
  const revision = h.client.configurations()[0].revision;
  await h.client.report(device, { revision, registrations: [], directCalls: [{ accountId: account, ringing: 1, dialling: 0, held: 0, connected: 0 }] });
  assert.equal(JSON.parse(h.requests.find(r => r.url.pathname.endsWith('/report')).body).directCalls, undefined);
  assert.equal(JSON.parse(h.requests.find(r => r.url.pathname.endsWith('/report')).body).appliedRevision, undefined);
  const count = h.requests.length;
  await assert.rejects(h.client.report(device, { revision: 'b'.repeat(64), applied: true, registrations: [] }), /Settings changed/);
  assert.equal(h.requests.length, count);
});

test('local sign-out can erase the saved session when encryption becomes unavailable', async t => {
  const h = harness(t); await h.login(); await h.client.connect(org, enrollment);
  h.control.failSave = true;
  await h.client.signOut();
  assert.equal(h.stored(), null);
  assert.equal(h.client.snapshot().signedIn, false);
  assert.deepEqual(h.client.configurations(), []);
});

test('session invalidation and invalid refresh grants clear the managed identity', async t => {
  const h = harness(t); await h.login(); h.control.apiStatus = 401;
  await assert.rejects(h.client.refresh()); assert.equal(h.client.snapshot().signedIn, false);
  h.control.apiStatus = 200; await h.login(); h.advance(300_000); h.control.refreshDenied = true;
  await assert.rejects(h.client.refresh()); assert.equal(h.client.snapshot().signedIn, false);
});

test('cancelled exchanges and a different identity cannot replace the stored user', async t => {
  const h = harness(t); await h.login(); h.response.user = { id: 'other-user', email: 'other@example.invalid' };
  await h.client.signIn(); await h.client.handleCallback(h.callback());
  assert.equal(h.client.snapshot().identity.id, 'fixture-user'); assert.match(h.client.snapshot().error, /different Sipper identity/);
  let release; h.control.pauseToken = new Promise(resolve => { release = resolve; });
  await h.client.signIn(); const pending = h.client.handleCallback(h.callback());
  h.client.cancelSignIn(); release(); await pending; assert.equal(h.stored().identity.id, 'fixture-user');
});

test('configuration validation rejects foreign, expired, duplicate and unsafe SIP data', () => {
  const now = Date.now(), valid = configuration(now);
  assert.equal(validateConfiguration(valid, org, device, now).accounts[0].settings.srtp, 'required');
  assert.throws(() => validateConfiguration(valid, device, device, now));
  assert.throws(() => validateConfiguration(valid, org, device, now + 3600_000));
  assert.throws(() => validateConfiguration({ ...valid, accounts: [...valid.accounts, ...valid.accounts] }, org, device, now));
  const gateway = { ...valid, accounts: [{ ...valid.accounts[0], mode: 'gateway' }] };
  assert.equal(validateConfiguration(gateway, org.toUpperCase(), device.toUpperCase(), now).accounts[0].mode, 'gateway');
  for (const settings of [{ transport: 'udp' }, { srtp: 'optional' }]) {
    assert.throws(() => validateConfiguration({ ...gateway, accounts: [{ ...gateway.accounts[0], settings: { ...gateway.accounts[0].settings, ...settings } }] }, org, device, now));
  }
  assert.throws(() => validateConfiguration({ ...valid, accounts: [{ ...valid.accounts[0], settings: { ...valid.accounts[0].settings, server: 'https://example.invalid/path' } }] }, org, device, now));
});

const reference = 'abcdef12-3456-4789-8abc-abcdef123456';
const binding = { organisationId: org, deviceId: device, remoteAccountId: account, mode: 'gateway' };
const managedCall = () => ({ id: reference, configurationId: account, version: 1, state: 'ringing',
  expiresAt: new Date(Date.now() + 60_000).toISOString(), claimedByThisDevice: false, caller: { name: 'Example caller', number: '100' } });

test('gateway call APIs bind the enrolment and account without changing provisioning status', async t => {
  const h = harness(t); h.control.gateway = true; h.control.call = managedCall();
  await h.login(); await h.client.connect(org, enrollment);
  assert.equal((await h.client.call(reference.toUpperCase(), binding)).id, reference);
  const request = h.requests.at(-1); assert.equal(request.options.method, 'GET');
  assert.equal(request.url.pathname, `/api/client/devices/${device}/calls/${reference}`);
  assert.equal(request.options.headers.authorization, 'Bearer fixture-access-token');
  assert.equal(h.client.snapshot().busy, false); assert.equal(h.client.snapshot().error, null);
  await assert.rejects(h.client.call(reference, { ...binding, organisationId: device }), { code: 'call_unavailable' });
  h.control.callStatus = 409;
  await assert.rejects(h.client.call(reference, binding, 'answer'), { code: 'call_unavailable' });
  assert.equal(h.client.snapshot().error, null);
  assert.equal(h.client.configurations().length, 1);
});

test('gateway caller data rejects foreign references, malformed state and untrusted labels', async t => {
  const h = harness(t); h.control.gateway = true;
  await h.login(); await h.client.connect(org, enrollment);
  for (const changes of [{ id: device }, { configurationId: device }, { state: 'unknown' }, { version: 0 },
    { caller: { name: 'Wrong\nlabel', number: '100' } }, { caller: undefined }]) {
    h.control.call = { ...managedCall(), ...changes };
    await assert.rejects(h.client.call(reference, binding), { code: 'invalid_response' });
  }
  const call = managedCall();
  assert.equal(callUnavailable(call), false);
  assert.equal(callUnavailable({ ...call, state: 'answering' }), true);
  assert.equal(callUnavailable({ ...call, state: 'answered', claimedByThisDevice: true, expiresAt: new Date(0).toISOString() }), false);
  assert.equal(callUnavailable({ ...call, expiresAt: new Date(0).toISOString() }), true);
});

test('late gateway responses cannot survive cancellation or local device removal', async t => {
  const h = harness(t); h.control.gateway = true; h.control.call = managedCall();
  await h.login(); await h.client.connect(org, enrollment);
  let release;
  h.control.pauseCall = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = h.client.call(reference, binding, 'status', controller.signal);
  const rejected = assert.rejects(pending); controller.abort(); release(); await rejected;
  h.control.pauseCall = new Promise(resolve => { release = resolve; });
  const removed = h.client.call(reference, binding);
  const denied = assert.rejects(removed, { code: 'call_unavailable' });
  await h.client.disconnect(device); release(); await denied;
});

test('managed storage encrypts at rest, separates servers and refuses plaintext backends', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipper-managed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = new Map();
  const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-encryption',
    encryptString: text => { const bytes = randomBytes(64); secrets.set(bytes.toString('hex'), text); return bytes; },
    decryptString: bytes => secrets.get(bytes.toString('hex')) };
  const storage = new ManagedStorage(dir, safe, origin); storage.save({ fixture: 'never-in-plain-json' });
  assert.deepEqual(new ManagedStorage(dir, safe, origin).read(), { fixture: 'never-in-plain-json' });
  assert.ok(!fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8').includes('never-in-plain-json'));
  assert.equal(new ManagedStorage(dir, safe, 'https://other.example.invalid').read(), null);
  safe.getSelectedStorageBackend = () => 'basic_text'; assert.throws(() => storage.save({}), /unavailable/); assert.throws(() => storage.read(), /unavailable/);
});

test('HTTP management endpoints require explicit local development', () => {
  assert.equal(managedOrigin('https://sipper.dev'), 'https://sipper.dev');
  assert.throws(() => managedOrigin('http://localhost:3100'));
  assert.equal(managedOrigin('http://localhost:3100', true), 'http://localhost:3100');
  assert.throws(() => managedOrigin('http://example.invalid', true));
  assert.throws(() => managedOrigin('https://user:secret@example.invalid'));
  assert.throws(() => managedOrigin('https://example.invalid/arbitrary/path'));
});

test('a failed secure save never binds the first identity or exposes its tokens', async t => {
  const h = harness(t); h.control.failSave = true;
  await h.client.signIn(); await h.client.handleCallback(h.callback());
  assert.equal(h.client.snapshot().signedIn, false); assert.equal(h.stored(), null);
  assert.equal(h.client.configurations().length, 0);
});

test('sign-out removes settings before network work and invalidates an in-flight exchange', async t => {
  const h = harness(t); await h.login(); await h.client.connect(org, enrollment);
  let release; h.control.pauseToken = new Promise(resolve => { release = resolve; });
  await h.client.signIn(); const callback = h.client.handleCallback(h.callback());
  const signedOut = h.client.signOut();
  assert.equal(h.client.snapshot().signedIn, false); assert.equal(h.client.configurations().length, 0);
  release(); await callback; await signedOut;
  assert.equal(h.stored(), null); assert.equal(h.client.snapshot().signedIn, false);
  assert.ok(h.requests.some(r => r.options.method === 'DELETE' && r.url.pathname.endsWith(`/devices/${device}`)));
});


test('direct call reporting excludes personal and gateway calls and sends counts without caller data', async t => {
  const accounts = [{ id: 'direct', managed: { mode: 'direct', remoteAccountId: account } }, { id: 'personal' }, { id: 'gateway', managed: { mode: 'gateway' } }];
  const call = { accountID: 'direct', direction: 'incoming', state: 'early', remoteNumber: 'private-number', remoteName: 'Private name' };
  const calls = [call, { ...call, direction: 'outgoing' }, { ...call, state: 'confirmed' }, { ...call, state: 'confirmed', isOnHold: true },
    { ...call, state: 'confirmed', isRemoteHold: true }, { ...call, state: 'disconnected' }, { ...call, accountID: 'personal' }, { ...call, accountID: 'gateway' }];
  const reports = directCallReport(accounts, calls);
  assert.deepEqual(reports, [{ accountId: account, ringing: 1, dialling: 1, connected: 1, held: 2 }]);
  const h = harness(t); await h.login(); await h.client.connect(org, enrollment);
  await h.client.report(device, { revision: h.client.configurations()[0].revision, applied: true, directCalls: reports });
  const body = JSON.parse(h.requests.find(r => r.url.pathname.endsWith('/report')).body);
  assert.deepEqual(body.directCalls, reports);
  assert.ok(!JSON.stringify(body).includes('Private')); assert.ok(!JSON.stringify(body).includes('private-number'));
  assert.deepEqual(directCallReport(accounts, []), [{ accountId: account, ringing: 0, dialling: 0, connected: 0, held: 0 }]);
});


test('reports require a positive server acknowledgement', async t => {
  const h = harness(t); await h.login(); await h.client.connect(org, enrollment);
  h.control.reportAccepted = false;
  await assert.rejects(h.client.report(device, { revision: h.client.configurations()[0].revision, registrations: [] }), /not acknowledged/);
});
const messageScope = h => ({ schemaVersion: 1, organisation: { id: org, name: 'Example company' }, deviceId: device,
  userId: 'fixture-user', expiresAt: new Date(h.now() + 30_000).toISOString(), retentionDays: 90 });
const thread = (h, id = randomUUID(), peers = ['fixture-peer'], title = 'Example colleague') => ({ id, kind: peers.length === 1 ? 'direct' : 'group', title,
  createdAt: new Date(h.now()).toISOString(), updatedAt: new Date(h.now()).toISOString(), unread: 1, lastSequence: '9007199254740993',
  participants: ['fixture-user', ...peers].map(id => ({ id, name: id, lastReadSequence: '0' })) });
const textMessage = (h, sequence = '9007199254740993') => ({ id: randomUUID(), sequence, senderId: 'fixture-user', senderName: 'Example person',
  text: '<b>literal text</b>\n🌱', createdAt: new Date(h.now()).toISOString() });
const nativeMeeting = h => ({ id: randomUUID(), conversationId: randomUUID(), createdBy: 'fixture-user',
  createdAt: new Date(h.now()).toISOString(), expiresAt: new Date(h.now() + 86_400_000).toISOString(), endedAt: null, controlConfirmedAt: null });
function meetingGrant(h, meeting, sessionId, patch = {}) {
  const video = { room: `sipper-${meeting.id}`, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false,
    canUpdateOwnMetadata: false, canPublishSources: ['microphone', 'camera', 'screen_share', 'screen_share_audio'] };
  const claims = { sub: `sipper:${sessionId}`, exp: Math.floor(h.now() / 1000) + 120, video, ...patch };
  return { schemaVersion: 1, organisationId: org, meetingId: meeting.id, sessionId, identity: `sipper:${sessionId}`, url: 'wss://meet.example.invalid',
    token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

test('native meetings use exact customer/device routes and ephemeral scoped grants', async t => {
  const h = await directoryReady(t), scope = messageScope(h), room = nativeMeeting(h), sessionId = randomUUID(), startId = randomUUID(), saved = structuredClone(h.stored());
  h.control.meetingHandler = (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-access-token');
    if (url.pathname.endsWith('/meeting')) return Response.json({ ...scope, available: true, meeting: room });
    if (url.pathname.endsWith('/join')) { assert.deepEqual(JSON.parse(options.body), { id: sessionId }); return Response.json(meetingGrant(h, room, sessionId)); }
    if (url.pathname.endsWith('/leave')) return Response.json({ ...scope, meetingId: room.id, sessionId, leaveRequested: true });
    if (url.pathname.endsWith('/end')) return Response.json({ ...scope, meeting: { ...room, endedAt: new Date(h.now()).toISOString() } });
    if (options.method === 'DELETE') return Response.json({ ...scope, meetingId: room.id, targetUserId: 'fixture/peer', removalRequested: true });
    return Response.json({ ...scope, available: true, canJoin: true, title: 'Example meeting', hostName: 'Example host', meeting: room, sessions: [] });
  };
  assert.equal((await h.client.currentMeeting(device, room.conversationId)).meeting.id, room.id);
  for (let i = 0; i < 2; i++) assert.equal((await h.client.startMeeting(device, room.conversationId, startId)).meeting.id, room.id);
  const starts = h.requests.filter(r => r.options.method === 'POST' && r.url.pathname.endsWith('/meeting'));
  assert.equal(starts[0].body, starts[1].body); assert.deepEqual(JSON.parse(starts[0].body), { id: startId });
  assert.equal((await h.client.meetingDetails(device, room.id)).title, 'Example meeting');
  for (let i = 0; i < 2; i++) assert.equal((await h.client.joinMeeting(device, room.id, sessionId)).identity, `sipper:${sessionId}`);
  assert.equal((await h.client.removeMeetingPerson(device, room.id, 'fixture/peer')).removalRequested, true);
  assert.ok(h.requests.at(-1).url.pathname.endsWith('/people/fixture%2Fpeer'));
  assert.equal((await h.client.leaveMeeting(device, room.id, sessionId)).leaveRequested, true);
  assert.ok((await h.client.endMeeting(device, room.id)).meeting.endedAt);
  assert.deepEqual(h.stored(), saved); assert.ok(!JSON.stringify(h.client.snapshot()).includes('c2ln'));
});

test('native meeting grants reject foreign references, unsafe URLs, privileges and expiry', async t => {
  const h = await directoryReady(t), room = nativeMeeting(h), sessionId = randomUUID(), base = meetingGrant(h, room, sessionId);
  const requests = h.requests.length;
  for (const args of [[randomUUID(), room.id, sessionId], [device, 'bad', sessionId], [device, room.id, 'bad']]) await assert.rejects(h.client.joinMeeting(...args));
  assert.equal(h.requests.length, requests);
  for (const patch of [{ organisationId: randomUUID() }, { meetingId: randomUUID() }, { sessionId: randomUUID() }, { identity: 'foreign' },
    { url: 'ws://meet.example.invalid' }, { url: 'wss://name:secret@meet.example.invalid' }, { url: 'wss://meet.example.invalid/rtc' },
    { url: 'wss://meet.example.invalid/?private=1' }, { expiresAt: new Date(h.now() + 121_000).toISOString() }, { token: 'not-a-token' }]) {
    h.control.meetings = { ...base, ...patch }; await assert.rejects(h.client.joinMeeting(device, room.id, sessionId), { code: 'invalid_meeting' });
  }
  const normal = JSON.parse(Buffer.from(base.token.split('.')[1], 'base64url'));
  for (const patch of [{ sub: 'foreign' }, { exp: Math.floor(h.now()/1000) - 1 }, { exp: Math.floor(h.now()/1000) + 500 }, { sip: { call: true } },
    { video: { ...normal.video, room: 'foreign' } }, { video: { ...normal.video, roomAdmin: true } },
    { video: { ...normal.video, canUpdateOwnMetadata: true } }, { video: { ...normal.video, canPublishSources: ['microphone', 'camera', 'microphone', 'screen_share'] } }]) {
    h.control.meetings = meetingGrant(h, room, sessionId, patch); await assert.rejects(h.client.joinMeeting(device, room.id, sessionId), { code: 'invalid_meeting' });
  }
  h.control.meetings = { ...messageScope(h), meetingId: randomUUID(), sessionId, leaveRequested: true };
  await assert.rejects(h.client.leaveMeeting(device, room.id, sessionId), { code: 'invalid_meeting' });
  h.control.meetingStatus = 409; await assert.rejects(h.client.joinMeeting(device, room.id, sessionId), { code: 'meeting_changed' });
  h.control.meetingStatus = 429; await assert.rejects(h.client.joinMeeting(device, room.id, sessionId), { code: 'meeting_rate_limit' });
});

test('late native meeting grants are fenced after sign-out, device removal or observed withdrawal', async t => {
  for (const action of ['signOut', 'disconnect', 'suspended', 'denied']) {
    const h = await directoryReady(t), room = nativeMeeting(h), sessionId = randomUUID();
    h.control.meetings = meetingGrant(h, room, sessionId);
    let resume; h.control.pauseMeetings = new Promise(resolve => { resume = resolve; });
    const start = h.requests.length, pending = h.client.joinMeeting(device, room.id, sessionId);
    const rejected = assert.rejects(pending, error => ['access_denied', 'cancelled'].includes(error.code));
    while (!h.requests.slice(start).some(r => r.url.pathname.includes('/conferencing/'))) await new Promise(resolve => setImmediate(resolve));
    if (action === 'signOut') await h.client.signOut();
    if (action === 'disconnect') await h.client.disconnect(device);
    if (action === 'suspended') { h.response.organisations[0].status = 'suspended'; await h.client.refresh(); }
    if (action === 'denied') { h.control.pauseMeetings = null; h.control.meetingStatus = 403; await assert.rejects(h.client.currentMeeting(device, room.conversationId)); h.control.meetingStatus = 200; }
    resume(); await rejected;
  }
});

test('group changes validate ownership, joining history, exact results and retries without a saved archive', async t => {
  const h = await directoryReady(t), scope = messageScope(h), saved = structuredClone(h.stored());
  const c = { ...thread(h, randomUUID(), ['fixture-peer', 'second-peer'], 'Project'), revision: '9007199254740993', ownerId: scope.userId };
  const input = { revision: c.revision, title: 'Renamed project', userIds: c.participants.map(p => p.id), ownerId: 'fixture-peer' };
  h.control.messages = { ...scope, conversation: { ...c, title: input.title, ownerId: input.ownerId, revision: '9007199254740994' } };
  for (let i = 0; i < 2; i++) assert.equal((await h.client.updateMessageGroup(device, c.id.toUpperCase(), input)).conversation.ownerId, input.ownerId);
  const writes = h.requests.filter(r => r.url.pathname.endsWith('/group'));
  assert.equal(writes.length, 2); assert.equal(writes[0].options.method, 'PUT'); assert.equal(writes[0].body, writes[1].body);
  for (const patch of [{ revision: '9007199254740992' }, { ownerId: scope.userId }, { title: 'Another name' }, { id: randomUUID() }]) {
    h.control.messages = { ...scope, conversation: { ...c, title: input.title, ownerId: input.ownerId, revision: '9007199254740994', ...patch } };
    await assert.rejects(h.client.updateMessageGroup(device, c.id, input), { code: 'invalid_messages' });
  }
  const before = h.requests.length;
  for (const patch of [{ revision: '01' }, { title: ' ' }, { userIds: [scope.userId, scope.userId] }, { ownerId: 'outsider' }, { userIds: ['fixture-peer'] }])
    await assert.rejects(h.client.updateMessageGroup(device, c.id, { ...input, ...patch }));
  assert.equal(h.requests.length, before);
  const joined = { ...c, participants: c.participants.map(p => ({ ...p, joinedSequence: '9007199254740993', lastReadSequence: '9007199254740993' })) };
  h.control.messages = { ...scope, conversation: joined, messages: [textMessage(h)], nextCursor: null };
  await assert.rejects(h.client.conversationMessages(device, c.id), { code: 'invalid_messages' });
  h.control.messages.messages = []; assert.equal((await h.client.conversationMessages(device, c.id)).messages.length, 0);
  for (const ownerId of [null, 'outsider']) {
    h.control.messages.conversation = { ...joined, ownerId };
    await assert.rejects(h.client.conversationMessages(device, c.id), { code: 'invalid_messages' });
  }
  h.control.messages = { ...scope, conversationId: c.id, left: true };
  await h.client.leaveMessageGroup(device, c.id.toUpperCase());
  h.control.messages.conversationId = randomUUID(); await assert.rejects(h.client.leaveMessageGroup(device, c.id), { code: 'invalid_messages' });
  assert.deepEqual(h.stored(), saved);
});

test('desktop alert feed validates ownership, decimal ordering, deadlines and pagination without persistence', async t => {
  const h = await directoryReady(t), saved = structuredClone(h.stored());
  const alerts = ['9007199254740993', '10000000000000000'].map(sequence => ({ conversationId: randomUUID(), sequence, expiresAt: new Date(h.now() + 240_000).toISOString() }));
  const base = { ...messageScope(h), alerts, nextCursor: null };
  h.control.messages = base;
  assert.deepEqual((await h.client.messageAlerts(device, { after: '9007199254740992' })).alerts, alerts);
  assert.equal(h.requests.at(-1).url.pathname, `/api/client/devices/${device}/messages/alerts`);
  assert.equal(h.requests.at(-1).url.searchParams.get('after'), '9007199254740992');
  for (const patch of [
    { userId: 'another-user' }, { deviceId: randomUUID() }, { expiresAt: alerts[0].expiresAt },
    { alerts: [...alerts].reverse() }, { alerts: [alerts[0], alerts[0]] }, { nextCursor: alerts[1].sequence },
    { alerts: [{ ...alerts[0], sequence: '01' }] }, { alerts: [{ ...alerts[0], text: 'Never accept a preview' }] },
    { alerts: [{ ...alerts[0], expiresAt: new Date(h.now()).toISOString() }] },
    { alerts: [{ ...alerts[0], expiresAt: new Date(h.now() + 300_001).toISOString() }] },
    { alerts: Array.from({ length: 101 }, (_, i) => ({ ...alerts[0], conversationId: randomUUID(), sequence: String(i + 1) })) },
  ]) {
    h.control.messages = { ...base, ...patch };
    await assert.rejects(h.client.messageAlerts(device), { code: 'invalid_messages' });
  }
  h.control.messages = base;
  await assert.rejects(h.client.messageAlerts(device, { after: alerts[0].sequence }), { code: 'invalid_messages' });
  const count = h.requests.length;
  for (const after of ['01', '-1', '9223372036854775808']) await assert.rejects(h.client.messageAlerts(device, { after }));
  assert.equal(h.requests.length, count);
  assert.deepEqual(h.stored(), saved);
  h.control.messages = { ...base, alerts: Array.from({length:100},(_,i)=>({ ...alerts[0], conversationId: randomUUID(), sequence: String(i+1) })), nextCursor: '100' };
  assert.equal((await h.client.messageAlerts(device)).nextCursor, '100');
  let resume; h.control.pauseMessages = new Promise(resolve => { resume = resolve; });
  const pending = h.client.messageAlerts(device), rejected = assert.rejects(pending, error => ['access_denied','cancelled'].includes(error.code));
  while (h.requests.length === count + 1) await new Promise(resolve => setImmediate(resolve));
  await h.client.disconnect(device); resume(); await rejected;
});

test('messaging uses exact bearer routes, large decimal sequences and nonce retries without persistence', async t => {
  const h = await directoryReady(t), scope = messageScope(h), conversation = thread(h), message = textMessage(h), saved = structuredClone(h.stored());
  h.control.messageHandler = (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-access-token');
    const body = options.body && JSON.parse(options.body);
    if (url.pathname.endsWith('/people')) return Response.json({ ...scope, people: [{ id: 'fixture-peer', name: 'Example colleague' }], nextCursor: null });
    if (url.pathname.endsWith('/read')) return Response.json({ ...scope, sequence: body.sequence });
    if (url.pathname.endsWith('/conversations')) return Response.json(options.method === 'POST' ? { ...scope, conversation: body.userIds.length === 1 ? conversation
      : thread(h, body.id, body.userIds, body.title) } : { ...scope, conversations: [conversation], nextCursor: null });
    return Response.json(options.method === 'POST' ? { ...scope, message: { ...message, ...body } }
      : { ...scope, conversation, messages: [message], nextCursor: null });
  };
  assert.equal((await h.client.messagePeople(device, { search: ' Example ', after: 'older-peer' })).people[0].id, 'fixture-peer');
  const peopleRequest = h.requests.at(-1); assert.equal(peopleRequest.url.searchParams.get('q'), 'Example'); assert.equal(peopleRequest.url.searchParams.get('after'), 'older-peer');
  assert.equal((await h.client.conversations(device)).conversations[0].id, conversation.id);
  const created = await h.client.createConversation(device, { id: randomUUID(), userIds: ['fixture-peer'] });
  assert.equal(created.conversation.id, conversation.id, 'Existing direct pairs may return an earlier ID');
  const groupID = randomUUID();
  assert.equal((await h.client.createConversation(device, { id: groupID.toUpperCase(), userIds: ['fixture-peer', 'second-peer'], title: 'Team' })).conversation.id, groupID);
  const input = { id: message.id.toUpperCase(), text: message.text };
  assert.equal((await h.client.sendMessage(device, conversation.id.toUpperCase(), input)).message.text, message.text);
  assert.equal((await h.client.sendMessage(device, conversation.id, input)).message.sequence, message.sequence);
  const sends = h.requests.filter(r => r.url.pathname.endsWith(conversation.id) && r.options.method === 'POST');
  assert.equal(sends.length, 2); assert.deepEqual(JSON.parse(sends[0].body), JSON.parse(sends[1].body));
  const history = await h.client.conversationMessages(device, conversation.id, { after: '9007199254740992' });
  assert.equal(history.messages[0].sequence, '9007199254740993');
  assert.equal((await h.client.markConversationRead(device, conversation.id, message.sequence)).sequence, message.sequence);
  assert.deepEqual(h.stored(), saved); assert.ok(!JSON.stringify(h.client.snapshot()).includes('literal text'));
  const before = h.requests.length;
  for (const text of ['', ' ', 'x'.repeat(4097), 'x\0']) await assert.rejects(h.client.sendMessage(device, conversation.id, { id: randomUUID(), text }));
  for (const sequence of ['1.1', '-1', '01', '9223372036854775808', 'x']) await assert.rejects(h.client.markConversationRead(device, conversation.id, sequence));
  await assert.rejects(h.client.conversationMessages(device, conversation.id, { before: '1', after: '2' }));
  await assert.rejects(h.client.conversationMessages(device, conversation.id, { after: '0' }));
  await assert.rejects(h.client.createConversation(device, { id: randomUUID(), userIds: ['fixture-user'] }));
  await assert.rejects(h.client.createConversation(device, { id: randomUUID(), userIds: ['fixture-peer', 'fixture-peer'] }));
  assert.throws(() => h.client.conversations(device, { after: 'invalid cursor' }));
  assert.equal(h.requests.length, before, 'Invalid input must stop before HTTP');
});

test('messaging rejects poisoned scopes, histories, cursors, send bindings and quotas', async t => {
  const h = await directoryReady(t), scope = messageScope(h), conversation = thread(h), message = textMessage(h);
  const page = { ...scope, conversation, messages: [message], nextCursor: null };
  const broken = [
    { schemaVersion: 2 }, { userId: 'another-user' }, { deviceId: randomUUID() }, { organisation: { ...scope.organisation, id: randomUUID() } },
    { expiresAt: new Date(h.now()).toISOString() }, { expiresAt: new Date(h.now() + 60_001).toISOString() }, { retentionDays: 0 }, { retentionDays: 3651 },
    { conversation: { ...conversation, id: randomUUID() } }, { conversation: { ...conversation, participants: conversation.participants.slice(1) } },
    { conversation: { ...conversation, lastSequence: '1.1' } }, { messages: [{ ...message, sequence: '0' }] },
    { messages: [{ ...message, sequence: '1.1' }] }, { messages: [{ ...message, sequence: '9223372036854775808' }] },
    { messages: [message, message] }, { messages: [message, { ...message, id: randomUUID(), sequence: '1' }] },
    { messages: [{ ...message, text: 'x\0' }] }, { messages: [{ ...message, text: 'x'.repeat(4097) }] },
    { nextCursor: message.sequence }, { messages: Array.from({ length: 101 }, (_, i) => textMessage(h, String(i + 1))) },
  ];
  for (const patch of broken) { h.control.messages = { ...page, ...patch }; await assert.rejects(h.client.conversationMessages(device, conversation.id), { code: 'invalid_messages' }); }
  h.control.messages = page;
  await assert.rejects(h.client.conversationMessages(device, conversation.id, { after: message.sequence }), { code: 'invalid_messages' });
  await assert.rejects(h.client.conversationMessages(device, conversation.id, { before: message.sequence }), { code: 'invalid_messages' });
  h.control.messages = { ...scope, people: [{ id: scope.userId, name: 'Self' }], nextCursor: null };
  await assert.rejects(h.client.messagePeople(device), { code: 'invalid_messages' });
  h.control.messages = { ...scope, conversations: [conversation, conversation], nextCursor: null };
  await assert.rejects(h.client.conversations(device), { code: 'invalid_messages' });
  for (const patch of [{ id: randomUUID() }, { text: 'Changed' }, { senderId: 'fixture-peer' }]) {
    h.control.messages = { ...scope, message: { ...message, ...patch } };
    await assert.rejects(h.client.sendMessage(device, conversation.id, { id: message.id, text: message.text }), { code: 'invalid_messages' });
  }
  h.control.messages = { ...scope, sequence: '1' };
  await assert.rejects(h.client.markConversationRead(device, conversation.id, '2'), { code: 'invalid_messages' });
  h.control.messageStatus = 429; await assert.rejects(h.client.conversations(device), { code: 'message_rate_limit' });
  h.control.messageStatus = 409; await assert.rejects(h.client.conversations(device), { code: 'messages_changed' });
  h.control.messageStatus = 400; await assert.rejects(h.client.createConversation(device, { id: randomUUID(), userIds: ['fixture-peer'] }), { code: 'invalid_message_input' });
});

test('bounded messaging accepts full Unicode pages, validates directional cursors and limits response bytes', async t => {
  const h = await directoryReady(t), scope = messageScope(h), conversation = thread(h);
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...textMessage(h, String(i + 2)), text: '界'.repeat(4096) }));
  h.control.messages = { ...scope, conversation, messages: rows, nextCursor: '2' };
  assert.equal((await h.client.conversationMessages(device, conversation.id)).messages.length, 100);
  h.control.messages.nextCursor = '101';
  assert.equal((await h.client.conversationMessages(device, conversation.id, { after: '1' })).nextCursor, '101');
  await assert.rejects(h.client.conversationMessages(device, conversation.id), { code: 'invalid_messages' });
  h.control.messageHandler = () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(h.client.conversations(device), { code: 'invalid_response' });
});

test('late message responses cannot revive suspended, denied, disconnected or signed-out access', async t => {
  for (const withdrawal of ['suspended', 'configuration', 'denied', 'disconnect', 'signOut']) {
    const h = await directoryReady(t), conversation = thread(h);
    h.control.messages = { ...messageScope(h), conversation, messages: [textMessage(h)], nextCursor: null };
    let resume; h.control.pauseMessages = new Promise(resolve => { resume = resolve; });
    const start = h.requests.length, pending = h.client.conversationMessages(device, conversation.id);
    const rejected = assert.rejects(pending, error => ['access_denied', 'cancelled'].includes(error.code));
    while (!h.requests.slice(start).some(r => r.url.pathname.includes('/messages/'))) await new Promise(resolve => setImmediate(resolve));
    if (withdrawal === 'suspended') { h.response.organisations[0].status = 'suspended'; await h.client.refresh(); }
    if (withdrawal === 'configuration') { h.control.configStatus = 403; await assert.rejects(h.client.refresh()); }
    if (withdrawal === 'denied') { h.control.pauseMessages = null; h.control.messageStatus = 403; await assert.rejects(h.client.conversations(device), { code: 'access_denied' }); h.control.messageStatus = 200; }
    if (withdrawal === 'disconnect') await h.client.disconnect(device);
    if (withdrawal === 'signOut') await h.client.signOut();
    resume(); await rejected;
    assert.ok(!JSON.stringify(h.stored()).includes('literal text'));
  }
});
