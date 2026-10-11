import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { engineExecutable, engineStartParams, freePort, startEngine, startSIPServer, testAccount } from '../support.mjs';

test('gateway accounts require a valid lease, verified TLS and mandatory SRTP in the native engine', { skip: !fs.existsSync(engineExecutable) }, async t => {
  const engine = await startEngine('gateway admission'); t.after(() => engine.shutdown());
  const account = testAccount('1001', 9, { gateway: true, managedUntil: Date.now() + 60_000,
    registrar: 'sip:sipper.test;transport=tls', proxy: 'sip:127.0.0.1:9;transport=tls;lr', srtp: 'mandatory' });
  const sync = value => engine.request('syncAccounts', { accounts: [value] });
  await engine.request('start', { ...engineStartParams, verifyTls: false });
  assert.deepEqual((await sync(account)).appliedAccountIds, []);
  await engine.request('stop');
  await engine.request('start', { ...engineStartParams, verifyTls: true });
  for (const change of [{ gateway: 'true' }, { managedUntil: null }, { managedUntil: Date.now() - 1 },
    { srtp: 'optional' }, { registrar: 'sip:sipper.test;transport=udp' }, { proxy: 'sip:127.0.0.1:9;transport=tcp;lr' }]) {
    assert.deepEqual((await sync({ ...account, ...change })).appliedAccountIds, []);
  }
});

test('managed access controls real SIP admission without ending established calls', { skip: !fs.existsSync(engineExecutable) }, async t => {
  const port = await freePort();
  const server = await startSIPServer(port);
  t.after(() => server.stop());
  const caller = await startEngine('managed caller');
  const callee = await startEngine('personal callee');
  t.after(async () => { await caller.shutdown(); await callee.shutdown(); });
  await caller.request('start', engineStartParams);
  await callee.request('start', engineStartParams);
  const personal = testAccount('1002', port);
  await callee.request('syncAccounts', { accounts: [personal], stunServers: [] });
  await callee.waitFor('registration', e => e.state === 'registered');

  const sync = account => caller.request('syncAccounts', { accounts: account ? [account] : [], stunServers: [] });
  const managed = () => testAccount('1001', port, { managedUntil: Date.now() + 60_000 });
  const connect = async () => {
    caller.clearEvents(); callee.clearEvents();
    const outgoing = await caller.request('makeCall', { accountId: 'acc-1001', uri: 'sip:1002@sipper.test' });
    const incoming = await callee.waitFor('incomingCall');
    await assert.rejects(callee.request('answer', { callId: incoming.call.id, expectedStartedAt: incoming.call.startedAt - 1 }), /no longer exists/);
    await callee.request('answer', { callId: incoming.call.id });
    await caller.waitFor('callChanged', e => e.call.id === outgoing.id && e.call.state === 'confirmed' && e.call.activeMedia);
    return { outgoing: outgoing.id, incoming: incoming.call.id };
  };
  const end = async call => {
    await caller.request('hangup', { callId: call.outgoing });
    await caller.waitFor('callEnded', e => e.call.id === call.outgoing);
    await callee.waitFor('callEnded', e => e.call.id === call.incoming);
  };
  const admissionBlocked = async () => {
    await assert.rejects(caller.request('makeCall', { accountId: 'acc-1001', uri: 'sip:1002@sipper.test' }), /not active/);
    await assert.rejects(caller.request('setRegistration', { accountId: 'acc-1001', enabled: true }), /not active/);
    await caller.request('reRegisterAll');
  };

  await t.test('asynchronous ICE setup is retained until the outgoing SIP dialog starts', async () => {
    caller.clearEvents(); await sync({ ...managed(), useIce: true });
    await caller.waitFor('registration', e => e.state === 'registered');
    await end(await connect());
    await sync(null);
  });

  await t.test('UDP and TCP network recovery preserve calls without reviving withdrawn registration', async () => {
    for (const transport of ['udp', 'tcp']) {
      const account = { ...managed(), registrar: `sip:sipper.test;transport=${transport}`, proxy: `sip:127.0.0.1:${port};transport=${transport};lr` };
      await caller.request('testNetworkChanged', { available: false });
      caller.clearEvents(); await sync(account);
      await caller.waitFor('registration', e => e.state === 'failed' && e.reason === 'No network connection');
      caller.clearEvents(); await caller.request('testNetworkChanged', { available: true });
      await caller.waitFor('registration', e => e.state === 'registered');
      const call = await connect();
      caller.clearEvents(); await caller.request('testNetworkChanged', { available: false });
      await caller.waitFor('registration', e => e.state === 'failed' && e.reason === 'No network connection');
      await assert.rejects(caller.request('setRegistration', { accountId: account.id, enabled: true }), /No network/);
      await caller.request('reRegisterAll');
      caller.clearEvents(); await caller.request('testNetworkChanged', { available: true });
      await caller.waitFor('registration', e => e.state === 'registered');
      assert.equal((await caller.request('activeCalls'))[0]?.state, 'confirmed');
      caller.clearEvents(); await sync(null);
      await caller.waitFor('registration', e => e.state === 'unregistered');
      caller.clearEvents(); await caller.request('testNetworkChanged', { available: true });
      await caller.waitFor('networkRecovered');
      await admissionBlocked();
      callee.clearEvents();
      const denied = await callee.request('makeCall', { accountId: personal.id, uri: 'sip:1001@sipper.test' });
      assert.equal((await callee.waitFor('callEnded', e => e.call.id === denied.id)).call.lastCode, 480);
      assert.equal((await caller.request('activeCalls'))[0]?.state, 'confirmed');
      caller.clearEvents(); await sync(account);
      await caller.waitFor('registration', e => e.state === 'registered');
      assert.deepEqual((await sync(account)).appliedAccountIds, [account.id]);
      await end(call); await sync(null);
    }
    caller.clearEvents(); await sync({ ...managed(), password: 'wrong-fixture-password' });
    await caller.waitFor('registration', e => e.state === 'failed' && e.code >= 300);
    await caller.request('testNetworkChanged', { available: false });
    caller.clearEvents(); await caller.request('testNetworkChanged', { available: true });
    await caller.waitFor('networkRecovered');
    await caller.waitFor('registration', e => e.state === 'failed' && e.code >= 300);
    await sync(null);
  });

  await t.test('direct DND rejects new incoming calls without changing registration, outgoing or admitted calls', async t => {
    caller.clearEvents(); await sync(managed());
    await caller.waitFor('registration', e => e.state === 'registered');
    const existing = await connect();
    caller.clearEvents(); callee.clearEvents();
    const ringingPeer = await callee.request('makeCall', { accountId: personal.id, uri: 'sip:1001@sipper.test' });
    const ringing = (await caller.waitFor('incomingCall')).call;
    caller.clearEvents();
    let offers = 0, registrations = 0;
    const offeredDuringDnd = () => offers++, registeredDuringDnd = () => registrations++;
    caller.on('incomingCall', offeredDuringDnd); caller.on('registration', registeredDuringDnd);
    t.after(() => { caller.off('incomingCall', offeredDuringDnd); caller.off('registration', registeredDuringDnd); });
    assert.deepEqual((await sync({ ...managed(), managedDoNotDisturb: true })).appliedAccountIds, ['acc-1001']);
    assert.equal((await caller.request('activeCalls')).find(c => c.id === existing.outgoing)?.state, 'confirmed');
    await caller.request('answer', { callId: ringing.id });
    await callee.waitFor('callChanged', e => e.call.id === ringingPeer.id && e.call.state === 'confirmed');
    caller.clearEvents(); callee.clearEvents();
    const blocked = await callee.request('makeCall', { accountId: personal.id, uri: 'sip:1001@sipper.test' });
    const ended = await callee.waitFor('callEnded', e => e.call.id === blocked.id);
    assert.equal(ended.call.lastCode, 486);
    assert.equal(offers, 0); assert.equal(registrations, 0);
    await caller.request('hangup', { callId: ringing.id });
    await caller.waitFor('callEnded', e => e.call.id === ringing.id);
    await callee.waitFor('callEnded', e => e.call.id === ringingPeer.id);
    await end(existing);
    await end(await connect()); // DND still permits outgoing calls.
    await sync({ ...managed(), managedDoNotDisturb: false });
    caller.clearEvents(); callee.clearEvents();
    const restored = await callee.request('makeCall', { accountId: personal.id, uri: 'sip:1001@sipper.test' });
    const offered = (await caller.waitFor('incomingCall')).call;
    await caller.request('hangup', { callId: offered.id });
    await callee.waitFor('callEnded', e => e.call.id === restored.id);
    for (const value of ['true', null, 1]) {
      assert.deepEqual((await sync({ ...managed(), managedDoNotDisturb: value })).appliedAccountIds, []);
    }
    await sync(null);
  });

  await t.test('lease renewal avoids re-registration, then expiry preserves the connected call', async () => {
    await sync(managed());
    await caller.waitFor('registration', e => e.state === 'registered');
    const call = await connect();
    caller.clearEvents();
    const applied = await sync({ ...managed(), managedUntil: Date.now() + 300 });
    assert.deepEqual(applied.appliedAccountIds, ['acc-1001']);
    await caller.waitFor('registration', e => e.state === 'unregistered');
    await admissionBlocked();
    assert.equal((await caller.request('activeCalls'))[0]?.id, call.outgoing);
    const from = (await caller.request('activeCalls')).find(c => c.id === call.outgoing);
    const to = (await callee.request('activeCalls')).find(c => c.id === call.incoming);
    await assert.rejects(caller.request('transfer', { callId: from.id, accountId: from.accountId, expectedStartedAt: from.startedAt, uri: 'sip:*97@sipper.test' }), /unavailable/);
    await callee.request('transfer', { callId: to.id, accountId: to.accountId, expectedStartedAt: to.startedAt, uri: 'sip:*97@sipper.test' });
    await callee.waitFor('transferStatus', e => e.callId === call.incoming && e.code === 403);
    assert.equal((await caller.request('activeCalls')).length, 1, 'an incoming REFER cannot create a new call after expiry');
    await caller.request('setMuted', { callId: call.outgoing, muted: true });
    await caller.waitFor('callChanged', e => e.call.id === call.outgoing && e.call.muted);
    assert.equal((await callee.request('activeCalls'))[0]?.id, call.incoming);
    await end(call);
    assert.deepEqual((await sync(null)).appliedAccountIds, []);
  });

  await t.test('explicit withdrawal preserves the call and leaves personal accounts usable', async () => {
    caller.clearEvents(); await sync(managed());
    await caller.waitFor('registration', e => e.state === 'registered');
    const call = await connect();
    await sync(null);
    await admissionBlocked();
    assert.equal((await caller.request('activeCalls'))[0]?.id, call.outgoing);
    const established = (await caller.request('activeCalls'))[0];
    const identity = { callId: established.id, accountId: established.accountId, expectedStartedAt: established.startedAt };
    caller.clearEvents();
    await caller.request('setHold', { ...identity, hold: true });
    await caller.waitFor('callChanged', e => e.call.id === established.id && e.call.onHold && !e.call.activeMedia);
    caller.clearEvents();
    await caller.request('setHold', { ...identity, hold: false });
    await caller.waitFor('callChanged', e => e.call.id === established.id && !e.call.onHold && e.call.activeMedia);
    await end(call);
    callee.clearEvents();
    const personalCall = await callee.request('makeCall', { accountId: personal.id, uri: 'sip:*97@sipper.test' });
    await callee.waitFor('callChanged', e => e.call.id === personalCall.id && e.call.state === 'confirmed');
    await callee.request('hangup', { callId: personalCall.id });
    await callee.waitFor('callEnded', e => e.call.id === personalCall.id);
  });

  await t.test('new settings wait for an existing call to finish before being acknowledged', async () => {
    caller.clearEvents(); await sync(managed());
    await caller.waitFor('registration', e => e.state === 'registered');
    const call = await connect();
    const changed = { ...managed(), regTimeout: 180 };
    assert.deepEqual((await sync(changed)).appliedAccountIds, []);
    await admissionBlocked();
    assert.equal((await caller.request('activeCalls'))[0]?.id, call.outgoing);
    await end(call);
    await caller.waitFor('registration', e => e.state === 'registered');
    assert.deepEqual((await sync(changed)).appliedAccountIds, ['acc-1001']);
  });

  await t.test('expiry rejects a ringing call, and malformed leases cannot restore access', async () => {
    caller.clearEvents(); callee.clearEvents();
    await sync(managed());
    await caller.waitFor('registration', e => e.state === 'registered');
    const call = await callee.request('makeCall', { accountId: personal.id, uri: 'sip:1001@sipper.test' });
    const incoming = await caller.waitFor('incomingCall');
    await sync({ ...managed(), managedUntil: Date.now() + 150 });
    await caller.waitFor('callEnded', e => e.call.id === incoming.call.id);
    await callee.waitFor('callEnded', e => e.call.id === call.id);
    await assert.rejects(caller.request('answer', { callId: incoming.call.id }), /no longer exists|unavailable/);
    for (const lease of [0, -1, 'tomorrow', Date.now() + 2 * 86400_000]) {
      assert.deepEqual((await sync({ ...managed(), managedUntil: lease })).appliedAccountIds, []);
    }
    await admissionBlocked();
  });
});
