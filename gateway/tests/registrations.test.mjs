import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeRegistration, reportRegistrations } from '../src/registrations.mjs';

test('device contact observations keep SIP peers separate from raw contact data and fail closed', async () => {
  const endpoint = `d${'a'.repeat(32)}`;
  let contacts = [];
  const ari = { request: async (method, path) => {
    assert.equal(method, 'GET'); assert.ok(path.endsWith(`/aor/${endpoint}`));
    return [{ attribute: 'max_contacts', value: '1' }, ...contacts.map(value => ({ attribute: 'contact', value }))];
  } };
  assert.equal((await observeRegistration(ari, endpoint)).state, 'unregistered');
  for (const [uri, ip] of [['sip:private@192.0.2.4:4321;transport=tls', '192.0.2.4'], ['sip:private@[2001:db8::1]:4321;transport=tls', '2001:db8::1'], ['sip:private@untrusted.invalid', null]]) {
    contacts = [uri];
    const report = await observeRegistration(ari, endpoint);
    assert.equal(report.state, 'registered'); assert.equal(report.ip, ip);
    assert.ok(!JSON.stringify(report).includes('private'));
  }
  await assert.rejects(observeRegistration(ari, 'upstream'));
  contacts.push('sip:other@192.0.2.2'); await assert.rejects(observeRegistration(ari, endpoint));
  contacts = [];
  const sent = [];
  await reportRegistrations(ari, async (...args) => sent.push(args), [endpoint], () => true);
  assert.equal(sent[0][1], 'registrations'); assert.equal(sent[0][2].reports[0].state, 'unregistered');
  await reportRegistrations(ari, async () => assert.fail('former owner must not report'), [endpoint], () => false);
});
