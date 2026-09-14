// Ported from SipperTests/SIPAccountTests.swift and SIPTypesTests.swift.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountMatches, accountValidationErrors, addressOfRecord, callURI, codecDisplayName, contactMatchesNumber,
  decodeAccount, decodeSettings, defaultLabel, defaultSettings, displayLabel, effectiveAuthUsername,
  effectivePort, effectiveServer, makeAccount, makeContact, normaliseDialString, parseTransport, proxyURI,
  registrarURI, seedCodecs, transportDefaultPort, usesSeparateServer,
} from '../src/core/models.js';
import {
  nextRefresh, parseSIPAddress, parseVoicemail, registration, registrationDetail, registrationShortLabel,
} from '../src/core/sip.js';

const account = (fields = {}) => makeAccount({ profileID: 'P', username: '1001', domain: 'pbx.example.com', ...fields });

test('registrar URI uses the domain and carries the transport', () => {
  assert.equal(registrarURI(account({ transport: 'udp' })), 'sip:pbx.example.com;transport=udp');
  assert.equal(registrarURI(account({ transport: 'tcp' })), 'sip:pbx.example.com;transport=tcp');
  assert.equal(registrarURI(account({ transport: 'tls' })), 'sip:pbx.example.com;transport=tls');
  assert.equal(registrarURI(account({ server: 'edge.example.com', port: 5080, transport: 'tcp' })),
    'sip:pbx.example.com;transport=tcp', 'the registrar is always the domain, never the server');
});

test('proxy URI defaults to the domain and the transport port', () => {
  assert.equal(proxyURI(account({ transport: 'udp' })), 'sip:pbx.example.com:5060;transport=udp;lr');
  assert.equal(proxyURI(account({ transport: 'tcp' })), 'sip:pbx.example.com:5060;transport=tcp;lr');
  assert.equal(proxyURI(account({ transport: 'tls' })), 'sip:pbx.example.com:5061;transport=tls;lr');
});

test('proxy URI uses a separate server, a custom port and brackets IPv6', () => {
  assert.equal(proxyURI(account({ server: 'edge.example.com', port: 5080, transport: 'tcp' })), 'sip:edge.example.com:5080;transport=tcp;lr');
  assert.equal(proxyURI(account({ server: 'edge.example.com', transport: 'tls' })), 'sip:edge.example.com:5061;transport=tls;lr');
  assert.equal(proxyURI(account({ port: 15060 })), 'sip:pbx.example.com:15060;transport=udp;lr');
  assert.equal(proxyURI(account({ server: '2001:db8::1' })), 'sip:[2001:db8::1]:5060;transport=udp;lr');
  assert.equal(proxyURI(account({ server: '[2001:db8::1]', port: 5070, transport: 'tcp' })), 'sip:[2001:db8::1]:5070;transport=tcp;lr');
  assert.equal(proxyURI(account({ server: '192.0.2.10' })), 'sip:192.0.2.10:5060;transport=udp;lr');
});

test('effective values', () => {
  const plain = account();
  assert.equal(effectiveServer(plain), 'pbx.example.com');
  assert.equal(effectivePort(plain), 5060);
  assert.equal(effectiveAuthUsername(plain), '1001');
  assert.equal(usesSeparateServer(plain), false);

  const separate = account({ server: 'edge.example.com', port: 5080, transport: 'tls', authUsername: 'auth1001' });
  assert.equal(effectiveServer(separate), 'edge.example.com');
  assert.equal(effectivePort(separate), 5080);
  assert.equal(effectiveAuthUsername(separate), 'auth1001');
  assert.equal(usesSeparateServer(separate), true);
  assert.equal(usesSeparateServer(account({ server: 'PBX.EXAMPLE.COM' })), false);
});

test('address of record quotes the display name and neutralises quotes', () => {
  assert.equal(addressOfRecord(account()), 'sip:1001@pbx.example.com');
  assert.equal(addressOfRecord(account({ displayName: '   ' })), 'sip:1001@pbx.example.com');
  assert.equal(addressOfRecord(account({ displayName: 'Alex Morgan' })), '"Alex Morgan" <sip:1001@pbx.example.com>');
  assert.equal(addressOfRecord(account({ displayName: ' Alex ' })), '"Alex" <sip:1001@pbx.example.com>');
  assert.equal(addressOfRecord(account({ displayName: 'Alex "The Voice" H' })), '"Alex \'The Voice\' H" <sip:1001@pbx.example.com>');
});

test('call URIs for numbers, user@host and full URIs', () => {
  assert.equal(callURI(account(), '2001'), 'sip:2001@pbx.example.com;transport=udp');
  assert.equal(callURI(account({ transport: 'tls' }), '2001'), 'sip:2001@pbx.example.com;transport=tls');
  assert.equal(callURI(account(), ' +44 (0)20 7946-0958 '), 'sip:+4402079460958@pbx.example.com;transport=udp');
  assert.equal(callURI(account(), '020.7946.0958'), 'sip:02079460958@pbx.example.com;transport=udp');
  assert.equal(callURI(account(), '*97#'), 'sip:*97#@pbx.example.com;transport=udp');
  assert.equal(callURI(account({ transport: 'tcp' }), 'alice@other.example.com'), 'sip:alice@other.example.com');
  assert.equal(callURI(account(), 'sip:bob@x.example.com;transport=tls'), 'sip:bob@x.example.com;transport=tls');
  assert.equal(callURI(account(), '  SIPS:bob@x.example.com  '), 'SIPS:bob@x.example.com');
});

test('dial strings are normalised', () => {
  assert.equal(normaliseDialString('+44 (0)20-7946.0958'), '+4402079460958');
  assert.equal(normaliseDialString('*97#'), '*97#');
  assert.equal(normaliseDialString('1234AbCd'), '1234AbCd');
  assert.equal(normaliseDialString('ext. 12'), '12');
  assert.equal(normaliseDialString(''), '');
});

test('matching and labels', () => {
  const a = account();
  assert.equal(accountMatches(a, '1001', 'PBX.Example.COM'), true);
  assert.equal(accountMatches(a, '1001', 'other.example.com'), false);
  assert.equal(accountMatches(a, '1002', 'pbx.example.com'), false);
  assert.equal(accountMatches(a, '1001 ', 'pbx.example.com'), false);
  assert.equal(displayLabel(a), '1001@pbx.example.com');
  assert.equal(defaultLabel(a), '1001@pbx.example.com');
  assert.equal(displayLabel(account({ label: 'Desk' })), 'Desk');
});

test('validation', () => {
  assert.deepEqual(accountValidationErrors(account()), []);
  assert.deepEqual(accountValidationErrors(account({ server: 'edge.example.com', port: 65535, transport: 'tls' })), []);
  assert.equal(accountValidationErrors(account({ username: '  ' })).length, 1);
  assert.match(accountValidationErrors(account({ username: '' }))[0], /Username/);
  assert.match(accountValidationErrors(account({ domain: '' }))[0], /Domain/);
  assert.match(accountValidationErrors(account({ domain: 'pbx example.com' }))[0], /spaces/);
  assert.match(accountValidationErrors(account({ port: 0 }))[0], /Port/);
  assert.match(accountValidationErrors(account({ port: 65536 }))[0], /Port/);
  assert.match(accountValidationErrors(account({ registrationExpiry: 30 }))[0], /expiry/);
  assert.equal(accountValidationErrors(account({ registrationExpiry: 86401 })).length, 1);
  assert.deepEqual(accountValidationErrors(account({ registrationExpiry: 60 })), []);
  assert.equal(accountValidationErrors(account({ username: '', domain: '', port: 99999 })).length, 3);
});

test('transports parse loosely and know their default ports', () => {
  assert.equal(parseTransport(' TLS '), 'tls');
  assert.equal(parseTransport('Udp'), 'udp');
  assert.equal(parseTransport(''), null);
  assert.equal(parseTransport(null), null);
  assert.equal(parseTransport('sctp'), null);
  assert.equal(transportDefaultPort('udp'), 5060);
  assert.equal(transportDefaultPort('tcp'), 5060);
  assert.equal(transportDefaultPort('tls'), 5061);
});

test('decoding fills defaults and rejects records without identity', () => {
  const decoded = decodeAccount({ id: 'A', profileID: 'P', username: '1001', domain: 'd', transport: 'bogus', port: '5060' });
  assert.equal(decoded.transport, 'udp');
  assert.equal(decoded.port, null);
  assert.equal(decoded.voicemailNumber, '*97');
  assert.equal(decoded.registrationExpiry, 300);
  assert.equal(decodeAccount({ id: 'A', profileID: 'P', domain: 'd' }), null);

  const settings = decodeSettings({ ringVolume: 4, sipLogLevel: 'loud', codecs: [{ codecID: 'PCMU/8000/1' }], echoMode: 'nope' }, 'UA');
  assert.equal(settings.ringVolume, 1);
  assert.equal(settings.sipLogLevel, 4);
  assert.deepEqual(settings.codecs, [{ codecID: 'PCMU/8000/1', isEnabled: true }]);
  assert.equal(settings.echoMode, 'software');
  assert.deepEqual(decodeSettings(null, 'UA'), defaultSettings('UA'));
});

test('contacts match normalised numbers', () => {
  const contact = makeContact({ name: 'Alice', numbers: [{ number: '+44 20 7946 0958' }] });
  assert.equal(contactMatchesNumber(contact, '+442079460958'), true);
  assert.equal(contactMatchesNumber(contact, '2079460958'), false);
  assert.equal(contactMatchesNumber(contact, ''), false);
});

test('codec seeding puts wideband first and enables the usual four', () => {
  const seeded = seedCodecs([{ id: 'GSM/8000/1' }, { id: 'PCMA/8000/1' }, { id: 'zzz/8000/1' }, { id: 'opus/48000/2' }, { id: 'PCMU/8000/1' }]);
  assert.deepEqual(seeded.map((c) => c.codecID), ['opus/48000/2', 'PCMU/8000/1', 'PCMA/8000/1', 'GSM/8000/1', 'zzz/8000/1']);
  assert.deepEqual(seeded.map((c) => c.isEnabled), [true, true, true, false, false]);
});

test('codec display names', () => {
  assert.equal(codecDisplayName('opus/48000/2'), 'opus 48 kHz stereo');
  assert.equal(codecDisplayName('PCMU/8000/1'), 'PCMU 8 kHz');
  assert.equal(codecDisplayName('weird'), 'weird');
});

// MARK: SIP addresses

test('SIP addresses: quoted and unquoted names, parameters, tel and sips', () => {
  assert.deepEqual(parseSIPAddress('"Alex Morgan" <sip:1001@pbx.example.com>;tag=1a2b3c'),
    { displayName: 'Alex Morgan', uri: 'sip:1001@pbx.example.com', user: '1001', host: 'pbx.example.com' });
  assert.equal(parseSIPAddress('Alex <sip:1001@pbx.example.com>').displayName, 'Alex');
  assert.deepEqual(parseSIPAddress('sip:1001@pbx.example.com;transport=tcp;ob'),
    { displayName: '', uri: 'sip:1001@pbx.example.com', user: '1001', host: 'pbx.example.com' });
  const bracketed = parseSIPAddress('<sip:1001@pbx.example.com:5080;transport=tls?Subject=hi>');
  assert.equal(bracketed.user, '1001');
  assert.equal(bracketed.host, 'pbx.example.com');
  assert.deepEqual(parseSIPAddress('tel:+442079460958'), { displayName: '', uri: 'tel:+442079460958', user: '+442079460958', host: '' });
  const secure = parseSIPAddress('"Alice" <sips:alice@secure.example.com:5061>');
  assert.equal(secure.user, 'alice');
  assert.equal(secure.host, 'secure.example.com');
  assert.equal(parseSIPAddress('SIP:1001@PBX.example.com').host, 'PBX.example.com');
});

test('SIP addresses: escapes, IPv6, missing user, percent-encoding, whitespace, empty', () => {
  assert.equal(parseSIPAddress('"Alex \\"The Voice\\" H" <sip:1001@pbx.example.com>').displayName, 'Alex "The Voice" H');
  const ipv6 = parseSIPAddress('<sip:1001@[2001:db8::1]:5060>');
  assert.equal(ipv6.user, '1001');
  assert.equal(ipv6.host, '2001:db8::1');
  assert.equal(parseSIPAddress('sip:pbx.example.com').user, '');
  assert.equal(parseSIPAddress('sip:pbx.example.com').host, 'pbx.example.com');
  assert.equal(parseSIPAddress('<sip:pbx.example.com:5060>').host, 'pbx.example.com');
  assert.equal(parseSIPAddress('sip:%2B441234@pbx.example.com').user, '+441234');
  assert.equal(parseSIPAddress('  "Alex" <sip:1001@pbx.example.com>  \r\n').displayName, 'Alex');
  assert.deepEqual(parseSIPAddress(''), { displayName: '', uri: '', user: '', host: '' });
});

// MARK: Voicemail and registration

test('voicemail summaries', () => {
  assert.deepEqual(parseVoicemail('Messages-Waiting: yes\r\nVoice-Message: 2/5 (0/0)'), { hasMessages: true, newCount: 2, oldCount: 5 });
  assert.deepEqual(parseVoicemail('Messages-Waiting: no\r\nVoice-Message: 0/3 (0/0)'), { hasMessages: false, newCount: 0, oldCount: 3 });
  assert.deepEqual(parseVoicemail('Messages-Waiting: no'), { hasMessages: false, newCount: 0, oldCount: 0 });
  assert.deepEqual(parseVoicemail(''), { hasMessages: false, newCount: 0, oldCount: 0 });
  assert.deepEqual(parseVoicemail('\r\n'), { hasMessages: false, newCount: 0, oldCount: 0 });
  assert.deepEqual(parseVoicemail('messages-waiting: NO\nvoice-message: 1/0'), { hasMessages: true, newCount: 1, oldCount: 0 });
  const fax = parseVoicemail('Message-Account: sip:*97@pbx.example.com\r\nMessages-Waiting: yes\r\nFax-Message: 4/1\r\n');
  assert.equal(fax.hasMessages, true);
  assert.equal(fax.newCount, 0);
});

test('registration labels and refresh time', () => {
  assert.equal(registrationShortLabel(registration.failed(401, 'Unauthorized')), 'Failed (401)');
  assert.equal(registrationShortLabel(registration.failed(0, 'Engine not running')), 'Failed');
  assert.equal(registrationDetail(registration.failed(0, 'Engine not running')), 'Engine not running');
  assert.equal(registrationDetail(registration.failed(403, 'Forbidden')), '403 Forbidden');
  assert.equal(registrationShortLabel(registration.unregistered()), 'Off');
  assert.equal(nextRefresh(registration.registered(300, 1000)), 1000 + 295000);
  assert.equal(nextRefresh(registration.registering()), null);
});
