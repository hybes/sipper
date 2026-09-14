import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  base64urlDecode,
  base64urlEncode,
  buildDocument,
  buildHandoffURL,
  decodePayload,
  defaultLabel,
  defaultPort,
  encodePayload,
  normaliseAccount,
  parseHandoffURL,
  parsePort,
  payloadSize,
  validateAccount,
} from '../payload.js';

test('defaultLabel', () => {
  assert.equal(defaultLabel({ username: '1001', callerIdName: 'Alex', domain: 'pbx.example.com' }), '1001 · Alex');
  assert.equal(defaultLabel({ username: '1001', callerIdName: '', domain: 'pbx.example.com' }), '1001 @ pbx.example.com');
  assert.equal(defaultLabel({ username: ' 1001 ', callerIdName: '  ', domain: '' }), '1001');
});

test('ports and transports', () => {
  assert.equal(defaultPort('udp'), 5060);
  assert.equal(defaultPort('tcp'), 5060);
  assert.equal(defaultPort('tls'), 5061);
  assert.equal(defaultPort('bogus'), 5060);
  assert.equal(parsePort(''), null);
  assert.equal(parsePort('5060'), 5060);
  assert.ok(Number.isNaN(parsePort('0')));
  assert.ok(Number.isNaN(parsePort('70000')));
  assert.ok(Number.isNaN(parsePort('abc')));
});

test('normaliseAccount trims and omits defaults', () => {
  const a = normaliseAccount({
    label: ' 1001 · Alex ',
    displayName: 'Alex Morgan ',
    username: ' 1001',
    authUsername: '1001',
    password: ' s3cret ',
    domain: ' Tenant.example.com ',
    server: 'tenant.EXAMPLE.com',
    port: '5060',
    transport: 'UDP',
    callerIdName: 'Alex Morgan',
    callerIdNumber: '',
    notes: '',
  });
  assert.deepEqual(a, {
    label: '1001 · Alex',
    displayName: 'Alex Morgan',
    username: '1001',
    password: 's3cret',
    domain: 'Tenant.example.com',
    callerIdName: 'Alex Morgan',
  });
  assert.ok(!('port' in a), 'default port is omitted');
  assert.ok(!('transport' in a), 'udp is the default transport');
  assert.ok(!('server' in a), 'server equal to the domain is omitted');
  assert.ok(!('authUsername' in a), 'authUsername equal to username is omitted');
});

test('normaliseAccount keeps non-default connection details', () => {
  const tls = normaliseAccount({ username: '1001', password: 'x', domain: 'tenant.example.com', server: 'pbx.example.com', port: '5061', transport: 'tls' });
  assert.equal(tls.server, 'pbx.example.com');
  assert.equal(tls.transport, 'tls');
  assert.ok(!('port' in tls), '5061 is the TLS default');
  const tcp = normaliseAccount({ username: '1001', password: 'x', domain: 'd', port: 5080, transport: 'tcp', authUsername: 'auth1001' });
  assert.equal(tcp.port, 5080);
  assert.equal(tcp.transport, 'tcp');
  assert.equal(tcp.authUsername, 'auth1001');
  const udpCustom = normaliseAccount({ username: '1001', password: 'x', domain: 'd', port: '5061' });
  assert.equal(udpCustom.port, 5061, '5061 is not the UDP default');
});

test('validateAccount', () => {
  assert.deepEqual(validateAccount({ username: '1001', domain: 'd', password: 'p' }), []);
  const problems = validateAccount({ username: ' ', domain: '', password: '', port: 'x', transport: 'sctp' });
  assert.equal(problems.length, 5);
});

test('buildDocument structure follows PROTOCOL.md', () => {
  const doc = buildDocument({
    source: { provider: 'fusionpbx', url: 'https://pbx.example.com/app/extensions/extension_edit.php?id=x', title: 'Extension - FusionPBX' },
    profileName: ' pbx.example.com ',
    accounts: [{ username: '1001', password: 's3cret', domain: 'tenant.pbx.example.com', server: 'pbx.example.com', label: '1001 · Alex', displayName: 'Alex Morgan', notes: 'Desk phone' }],
  });
  assert.deepEqual(Object.keys(doc), ['version', 'source', 'profile', 'accounts']);
  assert.equal(doc.version, PROTOCOL_VERSION);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.source, { provider: 'fusionpbx', url: 'https://pbx.example.com/app/extensions/extension_edit.php?id=x', title: 'Extension - FusionPBX' });
  assert.deepEqual(doc.profile, { name: 'pbx.example.com' });
  assert.deepEqual(doc.accounts, [{
    label: '1001 · Alex',
    displayName: 'Alex Morgan',
    username: '1001',
    password: 's3cret',
    domain: 'tenant.pbx.example.com',
    server: 'pbx.example.com',
    notes: 'Desk phone',
  }]);
});

test('buildDocument omits empty source and profile', () => {
  const doc = buildDocument({ source: {}, profileName: '', accounts: [{ username: '1', password: '2', domain: '3' }] });
  assert.deepEqual(doc, { version: 1, accounts: [{ username: '1', password: '2', domain: '3' }] });
});

test('base64url round trip, including unicode and characters that need - and _', () => {
  const doc = buildDocument({ accounts: [{ username: '1001', password: 'p>>>???~~~ünïcödé 日本', domain: 'pbx.example.com', label: '1001 · Álex' }] });
  const encoded = encodePayload(doc);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'no +, / or = in the output');
  assert.deepEqual(decodePayload(encoded), doc);
  assert.equal(base64urlDecode(base64urlEncode('')), '');
  assert.equal(decodePayload(`${encoded}==`).accounts[0].password, doc.accounts[0].password, 'padding is accepted');
});

test('handoff URL matches the PROTOCOL.md example', () => {
  const doc = { version: 1, accounts: [{ username: '1001', domain: 'pbx.example.com', password: 's3cret' }] };
  assert.equal(
    buildHandoffURL(doc),
    'sipper://add-accounts?payload=eyJ2ZXJzaW9uIjoxLCJhY2NvdW50cyI6W3sidXNlcm5hbWUiOiIxMDAxIiwiZG9tYWluIjoicGJ4LmV4YW1wbGUuY29tIiwicGFzc3dvcmQiOiJzM2NyZXQifV19',
  );
  assert.deepEqual(parseHandoffURL(buildHandoffURL(doc)), doc);
  assert.throws(() => parseHandoffURL('https://example.com/?payload=abc'));
});

test('payload size limit constant and measurement', () => {
  assert.equal(MAX_PAYLOAD_BYTES, 512 * 1024);
  const doc = buildDocument({ accounts: [{ username: 'ü', password: 'p', domain: 'd' }] });
  assert.equal(payloadSize(doc), Buffer.byteLength(JSON.stringify(doc), 'utf8'));
});
