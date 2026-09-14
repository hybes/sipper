// Parses sipper://add-accounts links and native messaging payloads (docs/PROTOCOL.md).
// Ported from Sipper/Import/ImportParser.swift; the messages and rules match the Mac app.

import { makeAccount, newID, parseTransport, transportDefaultPort } from './models.js';

export const IMPORT_SCHEME = 'sipper';
export const IMPORT_ACTION = 'add-accounts';
export const MAX_PAYLOAD_BYTES = 512 * 1024;

export class ImportError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.detail = detail;
  }
}

const errors = {
  notAnImportURL: () => new ImportError('notAnImportURL', 'This link is not a Sipper import link.'),
  missingPayload: () => new ImportError('missingPayload', 'The import link has no payload.'),
  payloadTooLarge: () => new ImportError('payloadTooLarge', 'The import payload is too large.'),
  invalidBase64: () => new ImportError('invalidBase64', 'The import payload is not valid base64url.'),
  invalidJSON: (detail) => new ImportError('invalidJSON', `The import payload is not valid JSON (${detail}).`, detail),
  unsupportedVersion: (version) =>
    new ImportError('unsupportedVersion', `Import format version ${version} is not supported by this version of Sipper.`, version),
  noAccounts: () => new ImportError('noAccounts', 'The import contains no accounts.'),
};

/** Scheme, action and raw query of a URL string, without URLSearchParams' "+ means space" rule. */
function splitURL(link) {
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(String(link ?? '').trim());
  if (!match) return null;
  let rest = match[2];
  let query = '';
  const questionMark = rest.indexOf('?');
  if (questionMark >= 0) {
    query = rest.slice(questionMark + 1);
    rest = rest.slice(0, questionMark);
  }
  const hash = query.indexOf('#');
  if (hash >= 0) query = query.slice(0, hash);
  const action = rest.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  return { scheme: match[1].toLowerCase(), action, query };
}

export function isImportURL(link) {
  const parts = splitURL(link);
  return Boolean(parts && parts.scheme === IMPORT_SCHEME && parts.action === IMPORT_ACTION);
}

function queryValue(query, name) {
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    const key = equals >= 0 ? pair.slice(0, equals) : pair;
    if (key !== name) continue;
    const value = equals >= 0 ? pair.slice(equals + 1) : '';
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function decodeBase64URL(input) {
  let text = String(input).trim().replaceAll('-', '+').replaceAll('_', '/').replaceAll('=', '');
  if (!/^[A-Za-z0-9+/]*$/.test(text)) return null;
  const remainder = text.length % 4;
  if (remainder === 1) return null;
  if (remainder > 0) text += '='.repeat(4 - remainder);
  return Buffer.from(text, 'base64');
}

export function encodeBase64URL(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Builds an import link for a JSON document (a string or bytes). */
export function makeImportURL(json) {
  return `${IMPORT_SCHEME}://${IMPORT_ACTION}?payload=${encodeBase64URL(Buffer.from(json))}`;
}

export function parseImportURL(link) {
  const parts = splitURL(link);
  if (!parts || parts.scheme !== IMPORT_SCHEME || parts.action !== IMPORT_ACTION) throw errors.notAnImportURL();
  const payload = queryValue(parts.query, 'payload');
  if (!payload) throw errors.missingPayload();
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES * 2) throw errors.payloadTooLarge();
  const data = decodeBase64URL(payload);
  if (!data) throw errors.invalidBase64();
  return parseImportJSON(data);
}

export function parseImportJSON(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  if (bytes.length > MAX_PAYLOAD_BYTES) throw errors.payloadTooLarge();
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw errors.invalidJSON(error.message);
  }
  return importRequestFrom(document);
}

const quoted = (key) => `“${key}”`;

function expectOptionalObject(value, key) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw errors.invalidJSON(`${quoted(key)} must be an object`);
  return value;
}

function expectOptionalString(object, key, path) {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw errors.invalidJSON(`${quoted(path ? `${path}.${key}` : key)} must be a string`);
  return value;
}

/** Validates the document's shape like the Mac app's Codable decoding does. */
export function importRequestFrom(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw errors.invalidJSON('the document must be an object');
  }
  if (!('version' in document)) throw errors.invalidJSON(`missing key ${quoted('version')}`);
  if (!Number.isInteger(document.version)) throw errors.invalidJSON(`${quoted('version')} must be a whole number`);
  if (!('accounts' in document)) throw errors.invalidJSON(`missing key ${quoted('accounts')}`);
  if (!Array.isArray(document.accounts)) throw errors.invalidJSON(`${quoted('accounts')} must be an array`);

  const source = expectOptionalObject(document.source, 'source');
  const profile = expectOptionalObject(document.profile, 'profile');
  const rawAccounts = document.accounts.map((account, index) => {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      throw errors.invalidJSON(`account ${index + 1} must be an object`);
    }
    const path = `accounts[${index}]`;
    const fields = {};
    for (const key of ['label', 'displayName', 'username', 'authUsername', 'password', 'domain', 'server',
      'transport', 'callerIdName', 'callerIdNumber', 'voicemailNumber', 'notes']) {
      fields[key] = expectOptionalString(account, key, path);
    }
    if (account.port !== undefined && account.port !== null) {
      if (!Number.isInteger(account.port)) throw errors.invalidJSON(`${quoted(`${path}.port`)} must be a whole number`);
      fields.port = account.port;
    } else {
      fields.port = null;
    }
    return fields;
  });

  if (document.version !== 1) throw errors.unsupportedVersion(document.version);
  if (rawAccounts.length === 0) throw errors.noAccounts();

  const provider = clean(expectOptionalString(source, 'provider', 'source')) ?? 'manual';
  return {
    provider,
    sourceURL: clean(expectOptionalString(source, 'url', 'source')),
    sourceTitle: clean(expectOptionalString(source, 'title', 'source')),
    profileName: clean(expectOptionalString(profile, 'name', 'profile')),
    candidates: rawAccounts.map((raw) => candidateFrom(raw, provider)),
  };
}

function candidateFrom(raw, provider) {
  const validationErrors = [];
  const username = clean(raw.username) ?? '';
  const domain = clean(raw.domain) ?? '';
  // Passwords are kept verbatim; only an empty or whitespace-only password is invalid.
  const password = (raw.password ?? '').trim() === '' ? '' : raw.password;
  if (!username) validationErrors.push('Username is missing.');
  if (!domain) validationErrors.push('Domain is missing.');
  if (!password) validationErrors.push('Password is missing.');

  let transport = 'udp';
  const rawTransport = clean(raw.transport);
  if (rawTransport) {
    const parsed = parseTransport(rawTransport);
    if (parsed) transport = parsed;
    else validationErrors.push(`Unknown transport “${rawTransport}”.`);
  }

  let port = null;
  if (raw.port !== null) {
    if (raw.port >= 1 && raw.port <= 65535) {
      port = raw.port === transportDefaultPort(transport) ? null : raw.port;
    } else {
      validationErrors.push(`Port ${raw.port} is out of range.`);
    }
  }

  const server = clean(raw.server) ?? '';
  const authUsername = clean(raw.authUsername);
  const account = makeAccount({
    profileID: newID(),
    label: clean(raw.label) ?? '',
    displayName: clean(raw.displayName) ?? '',
    username,
    authUsername: authUsername && authUsername !== username ? authUsername : '',
    domain,
    server: server.toLowerCase() === domain.toLowerCase() ? '' : server,
    port,
    transport,
    voicemailNumber: clean(raw.voicemailNumber) ?? '*97',
    callerIDName: clean(raw.callerIdName) ?? '',
    callerIDNumber: clean(raw.callerIdNumber) ?? '',
    notes: clean(raw.notes) ?? '',
    source: provider,
  });
  return { id: newID(), account, password, validationErrors, existingAccountID: null };
}

export function clean(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
