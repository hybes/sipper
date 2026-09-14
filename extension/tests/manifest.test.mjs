import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXT_ROOT } from './helpers.mjs';

const read = (rel) => readFileSync(new URL(rel, EXT_ROOT), 'utf8');
const exists = (rel) => existsSync(fileURLToPath(new URL(rel, EXT_ROOT)));

test('manifest.json is valid Manifest V3 with the expected permissions', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.name, 'Sipper');
  assert.equal(m.description, 'Add SIP accounts from your PBX to Sipper');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(m.permissions, ['activeTab', 'scripting', 'nativeMessaging', 'storage']);
  assert.equal(m.host_permissions, undefined, 'no host permissions: activeTab only');
  assert.equal(m.background, undefined);
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.action.default_popup, 'popup.html');
  for (const size of ['16', '32', '48', '128']) {
    assert.ok(exists(m.icons[size]), `icon ${size} exists`);
    assert.ok(exists(m.action.default_icon[size]), `action icon ${size} exists`);
    const png = readFileSync(new URL(m.icons[size], EXT_ROOT));
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.equal(png.readUInt32BE(16), Number(size), `icon ${size} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `icon ${size} height`);
  }
});

test('manifest key pins the extension ID recorded in EXTENSION_ID', () => {
  const m = JSON.parse(read('manifest.json'));
  const der = Buffer.from(m.key, 'base64');
  assert.equal(der[0], 0x30, 'DER SEQUENCE (SubjectPublicKeyInfo)');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(read('EXTENSION_ID').trim(), id);
  assert.equal(read('EXTENSION_ID'), id, 'no trailing newline');
  assert.ok(read('README.md').includes(id), 'README mentions the ID');
});

test('popup.html references only files that exist and has no inline script', () => {
  const html = read('popup.html');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) {
    assert.ok(!/^https?:/.test(ref), `no remote resource: ${ref}`);
    assert.ok(exists(ref), `${ref} exists`);
  }
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc=/, 'every script has a src');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /javascript:/i);
  for (const rel of ['popup.js', 'page.js', 'payload.js', 'providers/index.js', 'providers/fusionpbx.js', 'providers/generic.js']) {
    assert.ok(exists(rel), `${rel} exists`);
  }
  const popup = read('popup.js');
  for (const imp of popup.matchAll(/from '(\.\/[^']+)'/g)) assert.ok(exists(imp[1]), `import ${imp[1]} exists`);
});

test('every element popup.js looks up by id exists in popup.html', () => {
  const html = read('popup.html');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const js = read('popup.js');
  const used = new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
  for (const view of ['loading', 'message', 'account', 'list', 'progress', 'result']) used.add(`view-${view}`);
  for (const prefix of ['account', 'list']) for (const f of ['server', 'port', 'transport', 'profile']) used.add(`${prefix}-${f}`);
  for (const id of used) assert.ok(ids.has(id), `#${id} exists in popup.html`);
});
