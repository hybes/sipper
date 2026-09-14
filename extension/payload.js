// Builds the hand-off document and URL described in docs/PROTOCOL.md.
// Works in the popup and under Node (uses only TextEncoder/TextDecoder, btoa/atob).

export const PROTOCOL_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 512 * 1024;
export const TRANSPORTS = ['udp', 'tcp', 'tls'];
export const DEFAULT_PORTS = { udp: 5060, tcp: 5060, tls: 5061 };
export const HANDOFF_SCHEME = 'sipper://add-accounts?payload=';

const trim = (v) => (v == null ? '' : String(v).trim());

export function normaliseTransport(value) {
  const t = trim(value).toLowerCase();
  return TRANSPORTS.includes(t) ? t : 'udp';
}

export function defaultPort(transport) {
  return DEFAULT_PORTS[normaliseTransport(transport)];
}

export function parsePort(value) {
  const t = trim(value);
  if (!t) return null;
  if (!/^\d{1,5}$/.test(t)) return NaN;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : NaN;
}

// "1001 · Ben Hybert" when a caller id name is known, otherwise "1001 @ domain".
export function defaultLabel({ username, callerIdName, domain }) {
  const user = trim(username);
  const name = trim(callerIdName);
  if (user && name) return `${user} · ${name}`;
  if (user && trim(domain)) return `${user} @ ${trim(domain)}`;
  return user;
}

// Trims every string, drops empty optional fields and omits values equal to the
// protocol defaults (transport udp, port 5060/5061 for the transport, server == domain).
export function normaliseAccount(input = {}) {
  const account = {};
  const username = trim(input.username);
  const domain = trim(input.domain);
  const password = trim(input.password);
  const transport = normaliseTransport(input.transport);
  const port = typeof input.port === 'number' ? input.port : parsePort(input.port);
  const server = trim(input.server);
  const authUsername = trim(input.authUsername);

  const label = trim(input.label);
  if (label) account.label = label;
  const displayName = trim(input.displayName);
  if (displayName) account.displayName = displayName;
  account.username = username;
  if (authUsername && authUsername !== username) account.authUsername = authUsername;
  account.password = password;
  account.domain = domain;
  if (server && server.toLowerCase() !== domain.toLowerCase()) account.server = server;
  if (Number.isFinite(port) && port !== defaultPort(transport)) account.port = port;
  if (transport !== 'udp') account.transport = transport;
  for (const key of ['callerIdName', 'callerIdNumber', 'voicemailNumber', 'notes']) {
    const v = trim(input[key]);
    if (v) account[key] = v;
  }
  return account;
}

// -> [] when the account can be imported, otherwise human-readable problems.
export function validateAccount(input = {}) {
  const problems = [];
  if (!trim(input.username)) problems.push('Username (extension) is required.');
  if (!trim(input.domain)) problems.push('Domain is required.');
  if (!trim(input.password)) problems.push('Password is required.');
  const port = typeof input.port === 'number' ? input.port : parsePort(input.port);
  if (Number.isNaN(port)) problems.push('Port must be a number between 1 and 65535.');
  if (input.transport != null && trim(input.transport) && !TRANSPORTS.includes(trim(input.transport).toLowerCase())) {
    problems.push('Transport must be udp, tcp or tls.');
  }
  return problems;
}

export function buildDocument({ source, profileName, accounts }) {
  const doc = { version: PROTOCOL_VERSION };
  if (source && (source.provider || source.url || source.title)) {
    doc.source = {};
    if (trim(source.provider)) doc.source.provider = trim(source.provider);
    if (trim(source.url)) doc.source.url = trim(source.url);
    if (trim(source.title)) doc.source.title = trim(source.title);
  }
  if (trim(profileName)) doc.profile = { name: trim(profileName) };
  doc.accounts = (accounts || []).map(normaliseAccount);
  return doc;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// RFC 4648 §5 without padding.
export function base64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(value) {
  let s = String(value).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  while (s.length % 4 !== 0) s += '=';
  return new TextDecoder().decode(base64ToBytes(s));
}

export function encodePayload(doc) {
  return base64urlEncode(JSON.stringify(doc));
}

export function decodePayload(encoded) {
  return JSON.parse(base64urlDecode(encoded));
}

export function payloadSize(doc) {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

export function buildHandoffURL(doc) {
  return HANDOFF_SCHEME + encodePayload(doc);
}

export function parseHandoffURL(url) {
  const u = new URL(url);
  if (u.protocol !== 'sipper:' || u.host !== 'add-accounts') throw new Error('Not a sipper://add-accounts URL');
  const payload = u.searchParams.get('payload');
  if (!payload) throw new Error('Missing payload');
  return decodePayload(payload);
}
