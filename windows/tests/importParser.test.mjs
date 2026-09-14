// Ported from SipperTests/ImportParserTests.swift: the same links must behave the same on Windows.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeBase64URL, encodeBase64URL, isImportURL, makeImportURL, MAX_PAYLOAD_BYTES, parseImportJSON, parseImportURL,
} from '../src/core/importParser.js';
import { displayLabel, usesSeparateServer, effectiveAuthUsername } from '../src/core/models.js';

const documentedExampleURL = 'sipper://add-accounts?payload=eyJ2ZXJzaW9uIjoxLCJhY2NvdW50cyI6W3sidXNlcm5hbWUiOiIxMDAxIiwiZG9tYWluIjoicGJ4LmV4YW1wbGUuY29tIiwicGFzc3dvcmQiOiJzM2NyZXQifV19';
const documentedExampleJSON = '{"version":1,"accounts":[{"username":"1001","domain":"pbx.example.com","password":"s3cret"}]}';

const errorCode = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
};
const candidate = (accountJSON) => parseImportJSON(`{"version":1,"accounts":[${accountJSON}]}`).candidates[0];
const urlWithPayload = (payload) => `sipper://add-accounts?payload=${encodeURIComponent(payload)}`;

test('base64url decodes with and without padding and accepts both alphabets', () => {
  assert.equal(decodeBase64URL('aGVsbG8').toString(), 'hello');
  assert.equal(decodeBase64URL('aGVsbG8=').toString(), 'hello');
  assert.equal(decodeBase64URL('  aGVsbG8=\n').toString(), 'hello');
  const bytes = Buffer.from([0xfb, 0xff, 0xbf]);
  assert.equal(encodeBase64URL(bytes), '-_-_');
  assert.deepEqual(decodeBase64URL('-_-_'), bytes);
  assert.deepEqual(decodeBase64URL('+/+/'), bytes);
});

test('base64url rejects invalid input and round-trips every byte', () => {
  assert.equal(decodeBase64URL('a'), null);
  assert.equal(decodeBase64URL('!!!!'), null);
  assert.equal(decodeBase64URL('aGVs bG8'), null);
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const encoded = encodeBase64URL(bytes);
  assert.doesNotMatch(encoded, /[=+/]/);
  assert.deepEqual(decodeBase64URL(encoded), bytes);
});

test('recognises import links in host and path forms, case-insensitively', () => {
  assert.equal(isImportURL('sipper://add-accounts?payload=abc'), true);
  assert.equal(isImportURL('sipper:///add-accounts?payload=abc'), true);
  assert.equal(isImportURL('sipper:add-accounts?payload=abc'), true);
  assert.equal(isImportURL('SIPPER://ADD-ACCOUNTS?payload=abc'), true);
  assert.equal(isImportURL('https://add-accounts?payload=abc'), false);
  assert.equal(isImportURL('sipper://ping'), false);
  assert.equal(isImportURL('sipper://'), false);
  assert.equal(errorCode(() => parseImportURL('https://example.com/add-accounts')), 'notAnImportURL');
});

test('parses the documented example link', () => {
  const request = parseImportURL(documentedExampleURL);
  assert.equal(request.provider, 'manual');
  assert.equal(request.profileName, null);
  assert.equal(request.sourceURL, null);
  assert.equal(request.candidates.length, 1);
  const [only] = request.candidates;
  assert.deepEqual(only.validationErrors, []);
  assert.equal(only.existingAccountID, null);
  assert.equal(only.account.username, '1001');
  assert.equal(only.account.domain, 'pbx.example.com');
  assert.equal(only.password, 's3cret');
});

test('parses the full documented document', () => {
  const request = parseImportJSON(JSON.stringify({
    version: 1,
    source: { provider: 'fusionpbx', url: 'https://pbx.example.com/app/extensions/extension_edit.php?id=1', title: 'Extension 1001' },
    profile: { name: 'pbx.example.com' },
    accounts: [{
      label: '1001 · Alex', displayName: 'Alex Morgan', username: '1001', authUsername: '1001', password: 's3cret',
      domain: 'tenant.pbx.example.com', server: 'pbx.example.com', port: 5060, transport: 'udp',
      callerIdName: 'Alex Morgan', callerIdNumber: '01onward', voicemailNumber: '*97', notes: 'Desk phone',
    }],
  }));
  assert.equal(request.provider, 'fusionpbx');
  assert.equal(request.sourceURL, 'https://pbx.example.com/app/extensions/extension_edit.php?id=1');
  assert.equal(request.sourceTitle, 'Extension 1001');
  assert.equal(request.profileName, 'pbx.example.com');
  const { account } = request.candidates[0];
  assert.equal(account.label, '1001 · Alex');
  assert.equal(account.displayName, 'Alex Morgan');
  assert.equal(account.authUsername, '');
  assert.equal(account.domain, 'tenant.pbx.example.com');
  assert.equal(account.server, 'pbx.example.com');
  assert.equal(account.port, null);
  assert.equal(account.transport, 'udp');
  assert.equal(account.callerIDName, 'Alex Morgan');
  assert.equal(account.callerIDNumber, '01onward');
  assert.equal(account.notes, 'Desk phone');
  assert.equal(account.source, 'fusionpbx');
  assert.equal(account.isEnabled, true);
});

test('ignores unknown query parameters and round-trips makeImportURL', () => {
  const extra = 'sipper://add-accounts?foo=bar&payload=eyJ2ZXJzaW9uIjoxLCJhY2NvdW50cyI6W3sidXNlcm5hbWUiOiIxMDAxIiwiZG9tYWluIjoicGJ4LmV4YW1wbGUuY29tIiwicGFzc3dvcmQiOiJzM2NyZXQifV19&baz=1';
  assert.equal(parseImportURL(extra).candidates.length, 1);
  assert.equal(makeImportURL(documentedExampleJSON), documentedExampleURL);
  const json = '{"version":1,"accounts":[{"username":"1001","domain":"pbx.example.com","password":"p+/=ß&?#","label":"Alex · Büro"}]}';
  const [survivor] = parseImportURL(makeImportURL(json)).candidates;
  assert.equal(survivor.password, 'p+/=ß&?#');
  assert.equal(survivor.account.label, 'Alex · Büro');
});

test('a standard-alphabet payload keeps its plus signs', () => {
  const standard = Buffer.from('{"version":1,"accounts":[{"username":"1001","domain":"d","password":"~~~>"}]}').toString('base64');
  assert.match(standard, /\+/);
  assert.equal(parseImportURL(`sipper://add-accounts?payload=${standard}`).candidates[0].password, '~~~>');
});

test('errors: payload, base64, JSON shape, version, accounts, size', () => {
  assert.equal(errorCode(() => parseImportURL('sipper://add-accounts')), 'missingPayload');
  assert.equal(errorCode(() => parseImportURL('sipper://add-accounts?payload=')), 'missingPayload');
  assert.equal(errorCode(() => parseImportURL('sipper://add-accounts?other=1')), 'missingPayload');
  assert.equal(errorCode(() => parseImportURL(urlWithPayload('!!!'))), 'invalidBase64');

  assert.throws(() => parseImportJSON('{}'), (error) => error.code === 'invalidJSON' && error.detail.includes('version'));
  assert.throws(() => parseImportJSON('{"version":1}'), (error) => error.code === 'invalidJSON' && error.detail.includes('accounts'));
  assert.equal(errorCode(() => parseImportJSON('{"version":"one","accounts":[]}')), 'invalidJSON');
  assert.throws(() => parseImportJSON('not json at all'), (error) => error.code === 'invalidJSON' && error.message.includes(error.detail));

  assert.throws(() => parseImportJSON('{"version":2,"accounts":[{"username":"1"}]}'), (error) => error.code === 'unsupportedVersion' && error.detail === 2);
  assert.equal(errorCode(() => parseImportJSON('{"version":0,"accounts":[]}')), 'unsupportedVersion');
  assert.equal(errorCode(() => parseImportJSON('{"version":1,"accounts":[]}')), 'noAccounts');

  assert.equal(errorCode(() => parseImportURL(urlWithPayload('A'.repeat(MAX_PAYLOAD_BYTES * 2 + 1)))), 'payloadTooLarge');
  assert.equal(errorCode(() => parseImportJSON(Buffer.alloc(MAX_PAYLOAD_BYTES + 1))), 'payloadTooLarge');
});

test('candidate validation', () => {
  const broken = candidate('{"username":"   ","domain":"","password":""}');
  assert.equal(broken.validationErrors.length, 3);
  for (const word of ['username', 'domain', 'password']) {
    assert.ok(broken.validationErrors.some((e) => e.toLowerCase().includes(word)));
  }

  const request = parseImportJSON('{"version":1,"accounts":[{"username":"1001","domain":"pbx.example.com","password":"a"},{"username":"","domain":"pbx.example.com","password":"b"}]}');
  assert.equal(request.candidates.length, 2);
  assert.equal(request.candidates.filter((c) => c.validationErrors.length === 0).length, 1);

  const sctp = candidate('{"username":"1001","domain":"pbx.example.com","password":"x","transport":"sctp"}');
  assert.equal(sctp.validationErrors.length, 1);
  assert.match(sctp.validationErrors[0], /sctp/);

  assert.equal(candidate('{"username":"1","domain":"d","password":"x","transport":" TLS "}').account.transport, 'tls');
  assert.equal(candidate('{"username":"1","domain":"d","password":"x","transport":"Tcp"}').account.transport, 'tcp');
  assert.equal(candidate('{"username":"1","domain":"d","password":"x","transport":""}').account.transport, 'udp');

  assert.match(candidate('{"username":"1","domain":"d","password":"x","port":70000}').validationErrors[0], /70000/);
  assert.equal(candidate('{"username":"1","domain":"d","password":"x","port":0}').validationErrors.length, 1);
});

test('ports, defaults, servers, auth usernames and trimming', () => {
  assert.equal(candidate('{"username":"1","domain":"d","password":"x","port":5060}').account.port, null);
  assert.equal(candidate('{"username":"1","domain":"d","password":"x","transport":"tls","port":5061}').account.port, null);
  assert.equal(candidate('{"username":"1","domain":"d","password":"x","port":5061}').account.port, 5061);
  assert.equal(candidate('{"username":"1","domain":"d","password":"x","transport":"tcp","port":5080}').account.port, 5080);

  const defaults = candidate('{"username":"1001","domain":"pbx.example.com","password":"x"}').account;
  assert.equal(defaults.transport, 'udp');
  assert.equal(defaults.port, null);
  assert.equal(defaults.server, '');
  assert.equal(defaults.voicemailNumber, '*97');
  assert.equal(defaults.source, 'manual');
  assert.equal(displayLabel(defaults), '1001@pbx.example.com');

  const same = candidate('{"username":"1","domain":"pbx.example.com","password":"x","server":"PBX.Example.COM"}').account;
  assert.equal(same.server, '');
  assert.equal(usesSeparateServer(same), false);
  assert.equal(usesSeparateServer(candidate('{"username":"1","domain":"tenant.pbx.example.com","password":"x","server":"pbx.example.com"}').account), true);

  assert.equal(candidate('{"username":"1001","domain":"d","password":"x","authUsername":"1001"}').account.authUsername, '');
  assert.equal(effectiveAuthUsername(candidate('{"username":"1001","domain":"d","password":"x","authUsername":"1001-auth"}').account), '1001-auth');

  const trimmed = candidate('{"username":" 1001 ","domain":"\\n pbx.example.com ","password":"x","label":"  Desk  ","server":"  pbx.example.com  ","voicemailNumber":" *98 ","notes":"  n  "}').account;
  assert.equal(trimmed.username, '1001');
  assert.equal(trimmed.domain, 'pbx.example.com');
  assert.equal(trimmed.label, 'Desk');
  assert.equal(trimmed.server, '');
  assert.equal(trimmed.voicemailNumber, '*98');
  assert.equal(trimmed.notes, 'n');
  assert.equal(candidate('{"username":"1","domain":"d","password":"  spaced  "}').password, '  spaced  ');
});

test('each candidate gets a unique id and account id', () => {
  const request = parseImportJSON('{"version":1,"accounts":[{"username":"1001","domain":"pbx.example.com","password":"a"},{"username":"1002","domain":"pbx.example.com","password":"b"}]}');
  assert.equal(new Set(request.candidates.map((c) => c.id)).size, 2);
  assert.equal(new Set(request.candidates.map((c) => c.account.id)).size, 2);
});
