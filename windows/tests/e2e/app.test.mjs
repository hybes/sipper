// End-to-end test of Sipper for Windows. It adds an account through the interface, registers with
// tools/sip-test-server.py, calls the server's answering number, answers a call from an engine peer
// in the alert window, collects a missed call, and imports an account from a sipper:// link handed
// to a second launch. Audio uses PJSIP's null device; the ringtone and notifications are turned off.
//
//   npm run test:e2e                                   the development copy
//   SIPPER_APP=dist\win-unpacked\Sipper.exe npm run test:e2e   a packaged build
// Screenshots of each step go to tests/e2e/output.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';

import { makeImportURL } from '../../src/core/importParser.js';
import {
  engineExecutable, engineStartParams, freePort, startEngine, startSIPServer, testAccount, windowsRoot,
} from '../support.mjs';

const packaged = process.env.SIPPER_APP;
const output = path.join(windowsRoot, 'tests', 'e2e', 'output');

async function windowWithPage(app, page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().endsWith(page));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No window showing ${page}`);
}

test('Sipper for Windows works end to end', { timeout: 300000, skip: !fs.existsSync(engineExecutable) && `no engine at ${engineExecutable}` }, async (t) => {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const port = await freePort();
  const server = await startSIPServer(port);
  t.after(() => server.stop());

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipper-e2e-'));
  const env = { ...process.env, SIPPER_DATA_DIR: dataDir, SIPPER_NULL_AUDIO: '1', SIPPER_TEST_PASSWORDS: 'memory', SIPPER_LOG_STDERR: '1' };
  const appLog = fs.createWriteStream(path.join(output, 'app.log'));
  const app = await electron.launch({
    executablePath: packaged || undefined,
    args: packaged ? [] : [windowsRoot],
    env,
    timeout: 60000,
  });
  app.process().stderr.pipe(appLog);
  app.process().stdout.pipe(appLog);
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const shot = (name) => page.screenshot({ path: path.join(output, `${name}.png`) }).catch(() => {});
  await page.getByRole('heading', { name: 'Dialer' }).waitFor({ timeout: 30000 });
  await page.evaluate(() => window.sipper.invoke('updateSettings', { ringtone: 'silent', showNotifications: false }));

  await t.test('adds an account through the interface and registers it', async () => {
    try {
      await page.getByRole('button', { name: 'Add account…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add account' });
      await dialog.getByLabel('Label', { exact: true }).fill('Reception');
      await dialog.getByLabel('Username', { exact: true }).fill('1001');
      await dialog.getByLabel('Password', { exact: true }).fill('secret');
      await dialog.getByLabel('Domain', { exact: true }).fill('sipper.test');
      await dialog.getByLabel('Outbound proxy', { exact: true }).fill('127.0.0.1');
      await dialog.getByLabel('Port', { exact: true }).fill(String(port));
      await dialog.getByRole('button', { name: 'Add account' }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.getByRole('heading', { name: 'Reception' }).waitFor();
      await page.getByText('Registered', { exact: true }).first().waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'Voicemail (2)' }).waitFor({ timeout: 10000 });
    } finally {
      await shot('01-account');
    }
  });

  await t.test('calls the answering number and lists the call in history', async () => {
    try {
      await page.getByRole('button', { name: 'Dialer', exact: true }).click();
      await page.getByLabel('Number to call').fill('*97');
      await page.getByRole('button', { name: 'Call', exact: true }).click();
      const hangUp = page.getByRole('button', { name: 'Hang up', exact: true });
      await hangUp.waitFor({ timeout: 15000 });
      await shot('02-in-call');
      await hangUp.waitFor({ state: 'detached', timeout: 20000 });
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await page.getByRole('listitem', { name: /^\*97, / }).first().waitFor();
    } finally {
      await shot('03-history');
    }
  });

  const peer = await startEngine('peer');
  t.after(() => peer.shutdown());
  await peer.request('start', engineStartParams);
  await peer.request('syncAccounts', { accounts: [testAccount('1002', port)], stunServers: [] });
  await peer.waitFor('registration', (event) => event.state === 'registered', 15000);

  await t.test('rings in the alert window and answers from it', async () => {
    try {
      const call = await peer.request('makeCall', { accountId: 'acc-1002', uri: 'sip:1001@sipper.test;transport=udp' });
      const alert = await windowWithPage(app, 'incoming.html');
      await alert.getByRole('button', { name: 'Answer' }).click();
      await peer.waitFor('callChanged', (event) => event.call.id === call.id && event.call.state === 'confirmed', 15000);
      const hangUp = page.getByRole('button', { name: 'Hang up', exact: true });
      await hangUp.waitFor({ timeout: 10000 });
      await shot('04-answered');
      await hangUp.click();
      await peer.waitFor('callEnded', (event) => event.call.id === call.id, 15000);
    } finally {
      await shot('04-answered-after');
    }
  });

  await t.test('lists a call that stopped ringing as missed', async () => {
    try {
      peer.clearEvents();
      const call = await peer.request('makeCall', { accountId: 'acc-1002', uri: 'sip:1001@sipper.test;transport=udp' });
      await page.getByRole('button', { name: 'Answer', exact: true }).first().waitFor({ timeout: 15000 });
      await peer.request('hangup', { callId: call.id });
      await peer.waitFor('callEnded', (event) => event.call.id === call.id, 15000);
      await page.getByRole('button', { name: /History.*1 missed call/ }).click({ timeout: 10000 });
      await page.getByRole('listitem', { name: /Missed/ }).first().waitFor();
    } finally {
      await shot('05-missed');
    }
  });

  await t.test('imports an account from a sipper:// link opened by a second launch', async () => {
    try {
      const link = makeImportURL(JSON.stringify({
        version: 1,
        source: { provider: 'fusionpbx', url: 'https://pbx.example.com/app/extensions/extension_edit.php' },
        profile: { name: 'Imported PBX' },
        accounts: [{ username: '1003', domain: 'sipper.test', password: 'secret', server: '127.0.0.1', port, label: 'Imported desk' }],
      }));
      const second = spawn(packaged || electronPath, packaged ? [link] : [windowsRoot, link], { env, stdio: 'ignore' });
      await new Promise((resolve) => second.on('exit', resolve));
      const dialog = page.getByRole('dialog', { name: 'Add 1 account from FusionPBX' });
      await dialog.waitFor({ timeout: 20000 });
      await shot('06-import');
      await dialog.getByRole('button', { name: 'Import 1 account' }).click();
      await page.getByRole('button', { name: /Imported desk/ }).waitFor();
      await page.getByRole('region', { name: 'Imported PBX' }).waitFor();
    } finally {
      await shot('07-imported');
    }
  });

  assert.deepEqual(pageErrors, [], 'no errors in the window');
});
