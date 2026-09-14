// sipper-browser-host speaks Chrome's native messaging framing and hands accounts over as a
// sipper://add-accounts link (docs/PROTOCOL.md). SIPPER_HOST_DRY_RUN makes it print the link
// instead of opening it, so no installed copy of Sipper is launched.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseImportURL } from '../../src/core/importParser.js';
import { hostExecutable, windowsRoot } from '../support.mjs';

function startHost() {
  const child = spawn(hostExecutable, ['chrome-extension://gdijljkcflnaikcbjeahedncdgbceehp/'], {
    env: { ...process.env, SIPPER_HOST_DRY_RUN: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = Buffer.alloc(0);
  const replies = [];
  const waiting = [];
  const links = [];
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const reply = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      if (waiting.length > 0) waiting.shift()(reply);
      else replies.push(reply);
    }
  });
  child.stderr.on('data', (chunk) => links.push(...chunk.toString().split(/\r?\n/).filter(Boolean)));

  const sendRaw = (bytes) => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length, 0);
    child.stdin.write(Buffer.concat([header, bytes]));
    return new Promise((resolve) => (replies.length > 0 ? resolve(replies.shift()) : waiting.push(resolve)));
  };
  return {
    links,
    send: (message) => sendRaw(Buffer.from(JSON.stringify(message))),
    sendRaw,
    close: () => new Promise((resolve) => {
      child.on('exit', resolve);
      child.stdin.end();
    }),
  };
}

test('sipper-browser-host answers pings and hands accounts over', { skip: !fs.existsSync(hostExecutable) && `no host at ${hostExecutable}` }, async (t) => {
  const host = startHost();
  t.after(() => host.close());
  const { version } = JSON.parse(fs.readFileSync(path.join(windowsRoot, 'package.json'), 'utf8'));

  assert.deepEqual(await host.send({ type: 'ping' }), { ok: true, type: 'pong', version });

  const payload = {
    version: 1,
    source: { provider: 'fusionpbx', url: 'https://pbx.example.com/app/extensions/extensions.php' },
    profile: { name: 'pbx.example.com' },
    accounts: [
      { username: '1001', domain: 'pbx.example.com', password: 'p+/=ß&?#', label: 'Alex · Büro' },
      { username: '1002', domain: 'pbx.example.com', password: 's3cret', transport: 'tls' },
    ],
  };
  assert.deepEqual(await host.send({ type: 'add-accounts', payload }), { ok: true, type: 'queued', count: 2 });
  const request = parseImportURL(host.links.at(-1));
  assert.equal(request.provider, 'fusionpbx');
  assert.equal(request.profileName, 'pbx.example.com');
  assert.deepEqual(request.candidates.map((c) => c.password), ['p+/=ß&?#', 's3cret']);
  assert.equal(request.candidates[0].account.label, 'Alex · Büro');
  assert.equal(request.candidates[1].account.transport, 'tls');

  const failures = [
    [{ type: 'add-accounts', payload: { version: 2, accounts: [{ username: '1' }] } }, /version 2 is not supported/],
    [{ type: 'add-accounts', payload: { version: 1, accounts: [] } }, /no accounts/],
    [{ type: 'add-accounts', payload: { accounts: [] } }, /missing key “version”/],
    [{ type: 'add-accounts', payload: { version: 1 } }, /missing key “accounts”/],
    [{ type: 'add-accounts' }, /Missing payload/],
    [{ type: 'add-accounts', payload: 'nope' }, /not valid JSON/],
    [{ type: 'bogus' }, /Unknown message type/],
  ];
  for (const [message, expected] of failures) {
    const reply = await host.send(message);
    assert.equal(reply.ok, false);
    assert.match(reply.error, expected);
  }
  assert.deepEqual(await host.sendRaw(Buffer.from('{not json')), { ok: false, error: 'Message was not valid JSON.' });
});
