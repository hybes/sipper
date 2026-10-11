// Run pnpm test:windows-portal in portal/. Real OAuth, HTTP and SIP; storage and
// browser gestures are fixtures. The Mac engine build does not prove Windows OS behaviour.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AppState } from '../../src/main/appState.js';
import { EngineClient } from '../../src/main/engineClient.js';
import { ManagedClient } from '../../src/main/managedClient.js';
import { ManagedController } from '../../src/main/managedController.js';
import { MemoryPasswordStore } from '../../src/main/passwords.js';
import { JSONStore, STORE_FILES } from '../../src/main/store.js';
import { engineExecutable } from '../support.mjs';

const source = process.env.SIPPER_TEST_PORTAL_FILE;
test('Windows managed client and AppState use the real portal', {
  skip: !source?.includes('sipper-windows-portal-'), timeout: 90_000,
}, async () => {
  const fixture = JSON.parse(await fs.readFile(source, 'utf8'));
  assert.equal(new URL(fixture.origin).hostname, '127.0.0.1');
  assert.equal(new URL(fixture.origin).protocol, 'http:');
  const directory = path.dirname(source);
  async function until(step, check) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (await check()) return; await delay(100); }
    throw new Error(`Timed out: ${step}`);
  }
  async function checkpoint(phase, values = {}) {
    const reply = path.join(directory, 'portal-test-reply.json');
    await fs.rm(reply, { force: true });
    const file = path.join(directory, 'portal-test-phase.json');
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ phase, ...values }), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
    let result;
    await until(`companion ${phase}`, async () => {
      result = JSON.parse(await fs.readFile(reply, 'utf8').catch(() => 'null'));
      return result?.phase === phase;
    });
    return result;
  }
  // Token/settings persistence is deliberately in memory on this host; DPAPI needs Windows.
  let saved = null, refreshes = 0, browserURL;
  const secure = { read: () => structuredClone(saved), save: value => { saved = structuredClone(value); }, clear: () => { saved = null; } };
  const newClient = () => new ManagedClient({ origin: fixture.origin, allowLocalDevelopment: true, store: secure,
    openBrowser: url => { browserURL = url; },
    fetch: (url, options) => {
      if (new URL(url).pathname === '/api/auth/oauth2/token' && new URLSearchParams(options?.body).get('grant_type') === 'refresh_token') refreshes++;
      return fetch(url, options);
    } });
  let client = newClient(), controller;
  const messageNotices = [];
  const engine = new EngineClient({ executable: engineExecutable });
  const store = new JSONStore(path.join(directory, 'personal'));
  const passwords = new MemoryPasswordStore();
  const state = new AppState({ engine, store, passwords, platform: { nullAudio: true } });
  try {
    client.load(); await client.signIn();
    const reply = await checkpoint('authorise', { url: browserURL });
    assert.equal(await client.handleCallback(reply.callback), true);
    assert.equal(client.snapshot().error, null);
    assert.equal(client.snapshot().identity?.id, fixture.userId);
    assert.equal(client.snapshot().signedIn, true);
    // Reopen saved identity with an expired local token timestamp to exercise actual refresh.
    saved.tokens.expiresAt = 0;
    client = newClient(); client.load();
    await client.refresh(); assert.equal(refreshes, 1);
    assert.equal(client.snapshot().organisations[0].id, fixture.organisationId);
    state.load();
    Object.assign(state.settings, { sipLogLevel: 2, localUDPPort: 0, localTCPPort: 0, localTLSPort: 0,
      verifyTLSCertificates: true, showNotifications: false, showIncomingCallAlert: false,
      codecs: [{ codecID: 'opus/48000/2', isEnabled: true }, { codecID: 'PCMU/8000/1', isEnabled: true }] });
    const personal = state.addAccount({ profileID: state.profiles[0].id, label: 'Personal fixture', username: 'personal',
      domain: 'sipper.test', server: '127.0.0.1', port: fixture.sipPort, transport: 'udp', srtp: 'disabled', useICE: false }, 'fixture-personal');
    await state.startEngine(); assert.equal(state.engineStatus.running, true);
    controller = new ManagedController({ client, state, metadata: { name: 'Windows portal fixture', appVersion: 'test', osVersion: process.platform },
      onMessage: hint => messageNotices.push(hint) });
    await controller.connect(fixture.organisationId);
    const enrollment = client.snapshot().enrollments[0], account = state.accounts.find(a => a.managed);
    assert.ok(account);
    const registered = id => state.registration(id).state === 'registered';
    await until('both registrations', () => registered(account.id) && registered(personal.id));
    await controller.setAvailability(fixture.organisationId, 'away');
    assert.equal(client.snapshot().organisations[0].doNotDisturb, false);
    const contacts = await client.refreshDirectory(enrollment.deviceId);
    assert.equal(contacts.contacts.length, 3);
    const contact = contacts.contacts.find(c => c.name === 'Alex Morgan'); assert.ok(contact);
    const restored = newClient(); restored.load();
    assert.equal(restored.snapshot().identity.id, fixture.userId);
    assert.deepEqual(restored.directorySnapshot(enrollment.deviceId), contacts);
    assert.equal(restored.configurations()[0].accounts[0].id, account.managed.remoteAccountId);
    assert.deepEqual((await client.directoryStatus(enrollment.deviceId, [contact.id])).contacts,
      [{ contactId: contact.id, availability: 'away', doNotDisturb: false, activity: null }]);
    await checkpoint('status-shared');
    assert.deepEqual((await client.directoryStatus(enrollment.deviceId, [contact.id])).contacts,
      [{ contactId: contact.id, availability: null, doNotDisturb: null, activity: null }]);
    assert.equal(fixture.messageUserIds.length, 2);
    const people = await client.messagePeople(enrollment.deviceId);
    assert.deepEqual(new Set(people.people.map(p => p.id)), new Set(fixture.messageUserIds));
    const direct = await client.createConversation(enrollment.deviceId, { id: randomUUID(), userIds: [fixture.messageUserIds[0]] });
    const group = await client.createConversation(enrollment.deviceId, { id: randomUUID(), userIds: fixture.messageUserIds, title: 'Windows portal team' });
    const input = { id: randomUUID(), text: 'From Windows: <b>literal text</b>\n🌱' };
    const sent = await client.sendMessage(enrollment.deviceId, direct.conversation.id, input);
    assert.equal((await client.sendMessage(enrollment.deviceId, direct.conversation.id, input)).message.sequence, sent.message.sequence);
    await client.sendMessage(enrollment.deviceId, group.conversation.id, { id: randomUUID(), text: 'Native group text' });
    const privateSession = JSON.stringify(saved);
    assert.ok(!privateSession.includes('literal text') && !privateSession.includes('Native group text'));
    await checkpoint('messaging', { deviceId: enrollment.deviceId, conversationId: direct.conversation.id, groupId: group.conversation.id });
    const alerts = await client.messageAlerts(enrollment.deviceId);
    assert.deepEqual(new Set(alerts.alerts.map(a => a.conversationId)), new Set([direct.conversation.id, group.conversation.id]));
    state.updateSettings({ messageNotifications: true });
    await controller.pollMessages();
    assert.equal(messageNotices.length, 1);
    assert.deepEqual(Object.keys(messageNotices[0]).sort(), ['conversationId', 'deviceId', 'expiresAt']);
    assert.equal(await controller.openMessage(messageNotices[0]), true, 'Click rechecks authenticated access before navigation');
    assert.equal((await client.conversations(enrollment.deviceId)).conversations.length, 2);
    const directHistory = await client.conversationMessages(enrollment.deviceId, direct.conversation.id);
    assert.equal(directHistory.messages.length, 2); assert.equal(directHistory.conversation.unread, 1);
    assert.equal(directHistory.messages[1].text, 'Reply from a fictional colleague.');
    assert.equal((await client.conversationMessages(enrollment.deviceId, direct.conversation.id, { after: sent.message.sequence })).messages.length, 1);
    const groupHistory = await client.conversationMessages(enrollment.deviceId, group.conversation.id);
    assert.equal(groupHistory.messages.length, 2); assert.equal(groupHistory.messages[1].text, 'Reply to the native group.');
    await client.markConversationRead(enrollment.deviceId, direct.conversation.id, directHistory.messages[1].sequence);
    await client.markConversationRead(enrollment.deviceId, group.conversation.id, groupHistory.messages[1].sequence);
    assert.deepEqual((await client.messageAlerts(enrollment.deviceId)).alerts, []);
    controller.messageAttempt = -Infinity; await controller.pollMessages();
    assert.equal(messageNotices.length, 1, 'Already-read messages are not delivered again');
    await checkpoint('messages-read');
    const edit = { revision: groupHistory.conversation.revision, title: 'Updated native group', userIds: [fixture.userId, ...fixture.messageUserIds], ownerId: fixture.messageUserIds[0] };
    const changed = await client.updateMessageGroup(enrollment.deviceId, group.conversation.id.toUpperCase(), edit);
    assert.equal(changed.conversation.ownerId, edit.ownerId);
    assert.deepEqual((await client.updateMessageGroup(enrollment.deviceId, group.conversation.id, edit)).conversation, changed.conversation);
    await client.leaveMessageGroup(enrollment.deviceId, group.conversation.id); await client.leaveMessageGroup(enrollment.deviceId, group.conversation.id);
    await assert.rejects(client.conversationMessages(enrollment.deviceId, group.conversation.id), { code: 'access_denied' });
    await checkpoint('groups-left', { deviceId: enrollment.deviceId });
    const rejoinedGroup = await client.conversationMessages(enrollment.deviceId, group.conversation.id);
    assert.equal(rejoinedGroup.messages.length, 1); assert.equal(rejoinedGroup.messages[0].text, 'After rejoining the group.');
    await client.markConversationRead(enrollment.deviceId, group.conversation.id, rejoinedGroup.messages[0].sequence);
    assert.throws(() => controller.callDirectory(enrollment.deviceId, contact.id, '*97', personal.id), /active calling account/);
    assert.equal(await controller.callDirectory(enrollment.deviceId, contact.id, '*97', account.id), true);
    await until('directory call connected', () => state.calls.length === 1 && state.calls[0].connectedAt);
    await controller.report();
    const activity = await client.directoryStatus(enrollment.deviceId, [contact.id]);
    assert.equal(activity.contacts[0].activity.state, 'in_call'); assert.equal(activity.contacts[0].activity.source, 'device');
    await checkpoint('activity-shared');
    assert.equal((await client.directoryStatus(enrollment.deviceId, [contact.id])).contacts[0].activity, null);
    await checkpoint('calling', { deviceId: enrollment.deviceId });
    await assert.rejects(controller.refresh(), error => error.code === 'access_denied');
    await controller.applying;
    assert.equal(client.snapshot().organisations[0].status, 'suspended');
    assert.deepEqual(state.accounts.map(a => a.id), [personal.id]);
    assert.equal(client.configurations().length, 0);
    assert.equal(client.directorySnapshot(enrollment.deviceId), null);
    await assert.rejects(client.conversations(enrollment.deviceId), { code: 'access_denied' });
    await until('managed registration withdrawn', () => !registered(account.id));
    assert.equal(registered(personal.id), true);
    assert.equal(state.calls.length, 1); assert.ok(state.calls[0].connectedAt);
    assert.throws(() => controller.callDirectory(enrollment.deviceId, contact.id, '*97', account.id), /unavailable/);
    await assert.rejects(engine.request('makeCall', { accountId: account.id, uri: 'sip:*97@sipper.test' }), /not active/);
    await checkpoint('suspended');
    await controller.refresh();
    await until('managed registration restored', () => registered(account.id));
    await client.refreshDirectory(enrollment.deviceId);
    state.hangup(state.calls[0].id);
    await until('call ended', () => state.calls.length === 0);
    await controller.setAvailability(fixture.organisationId, 'unset');
    await client.disconnect(enrollment.deviceId); await controller.applying;
    assert.equal(client.snapshot().enrollments.length, 0);
    assert.equal(client.directorySnapshot(enrollment.deviceId), null);
    await assert.rejects(client.conversationMessages(enrollment.deviceId, direct.conversation.id), { code: 'access_denied' });
    assert.deepEqual(state.accounts.map(a => a.id), [personal.id]);
    await checkpoint('disconnected', { deviceId: enrollment.deviceId });
    await controller.connect(fixture.organisationId);
    const replacement = client.snapshot().enrollments[0];
    assert.notEqual(replacement.deviceId, enrollment.deviceId);
    const retained = await client.conversationMessages(replacement.deviceId, direct.conversation.id);
    assert.equal(retained.messages.length, 2); assert.equal(retained.conversation.unread, 0, 'Read state belongs to the user across devices');
    await client.signOut(); await controller.applying;
    assert.equal(client.snapshot().error, null);
    assert.equal(client.snapshot().signedIn, false);
    assert.equal(client.snapshot().enrollments.length, 0);
    const signedOut = newClient(); signedOut.load();
    assert.equal(signedOut.snapshot().signedIn, false); assert.equal(saved, null);
    assert.deepEqual(state.accounts.map(a => a.id), [personal.id]);
    assert.equal(registered(personal.id), true);
    store.flush();
    assert.deepEqual(store.load(STORE_FILES.accounts).map(a => a.id), [personal.id]);
    assert.equal(passwords.lookup(personal.id).password, 'fixture-personal');
    await checkpoint('signed-out', { deviceId: replacement.deviceId });
  } finally {
    controller?.stop(); client.cancelSignIn(); await state.shutdown();
  }
});
