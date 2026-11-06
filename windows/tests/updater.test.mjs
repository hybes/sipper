// The Windows updater against a fake electron-updater: status reporting, failed downloads and
// install ordering (Sipper shuts down before the installer starts).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { Updater } from '../src/main/updater.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');

async function harness(t, { calls = [] } = {}) {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const fake = new EventEmitter();
  const installs = [];
  let quits = 0;
  fake.quitAndInstall = (...args) => installs.push(args);
  const sent = [];
  const state = { settings: { checkForUpdates: true }, calls, log: { append: () => {} } };
  const updater = new Updater({
    app: { isPackaged: true, getVersion: () => '0.2.0' }, state, send: (s) => sent.push(s), quit: () => { quits++; },
    loadUpdater: async () => fake,
  });
  await updater.start();
  t.after(() => updater.stop());
  return { fake, updater, installs, sent, quits: () => quits, state };
}

test('a failed background download is reported, not left as an unhandled rejection', async (t) => {
  const { fake, updater } = await harness(t);
  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  fake.checkForUpdates = async () => {
    fake.emit('update-available', { version: '0.2.1' });
    const downloadPromise = Promise.reject(new Error('net::ERR_CONNECTION_RESET'));
    downloadPromise.finally(() => fake.emit('error', new Error('net::ERR_CONNECTION_RESET'))).catch(() => {});
    return { downloadPromise };
  };
  await updater.check();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(unhandled, null);
  assert.equal(updater.snapshot().state, 'error');
  assert.match(updater.snapshot().error, /connection/);
});

test('installing waits for a normal shutdown and is refused during a call', async (t) => {
  const calls = [];
  const { fake, updater, installs, quits } = await harness(t, { calls });
  assert.throws(() => updater.install(), /No update/);
  fake.emit('update-downloaded', { version: '0.2.1' });
  calls.push({ id: 1 });
  assert.throws(() => updater.install(), /Finish your call/);
  calls.length = 0;
  assert.equal(updater.finishInstall(), false, 'an ordinary quit installs nothing extra');
  updater.install();
  assert.equal(quits(), 1, 'Sipper quits normally first');
  assert.deepEqual(installs, [], 'the installer has not started during shutdown');
  assert.equal(updater.finishInstall(), true);
  assert.deepEqual(installs, [[true, true]]);
});

test('development copies and the opt-out never load the updater', async () => {
  let loaded = false;
  const updater = new Updater({ app: { isPackaged: false, getVersion: () => '0.2.0' }, state: {}, send: () => {}, quit: () => {},
    loadUpdater: async () => { loaded = true; } });
  await updater.start();
  assert.equal(loaded, false);
  assert.equal(updater.snapshot().supported, false);
  await assert.rejects(updater.check(), /installed app/);
});
