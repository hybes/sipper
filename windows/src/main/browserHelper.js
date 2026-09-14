// Installs the native messaging helper for Chromium-based browsers on Windows, so the Sipper
// browser extension can hand accounts straight to Sipper (docs/PROTOCOL.md). A manifest in the
// data folder names sipper-browser-host.exe; each browser finds it through a registry key.
// Ported from Sipper/Chrome/NativeMessagingInstaller.swift.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { PINNED_EXTENSION_ID } from '../core/extension.js';

export { PINNED_EXTENSION_ID };
export const HOST_NAME = 'com.hybes.sipper';

export const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', key: 'Software\\Google\\Chrome\\NativeMessagingHosts', userData: 'Google\\Chrome\\User Data' },
  { id: 'edge', name: 'Microsoft Edge', key: 'Software\\Microsoft\\Edge\\NativeMessagingHosts', userData: 'Microsoft\\Edge\\User Data' },
  { id: 'brave', name: 'Brave', key: 'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts', userData: 'BraveSoftware\\Brave-Browser\\User Data' },
  { id: 'vivaldi', name: 'Vivaldi', key: 'Software\\Vivaldi\\NativeMessagingHosts', userData: 'Vivaldi\\User Data' },
  { id: 'chromium', name: 'Chromium', key: 'Software\\Chromium\\NativeMessagingHosts', userData: 'Chromium\\User Data' },
];

const EXTENSION_ID = /^[a-p]{32}$/;

export function hostManifest({ hostPath, extensionID }) {
  return {
    name: HOST_NAME,
    description: 'Sipper SIP phone',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionID}/`],
  };
}

/** The default value of a key from `reg query … /ve` output, independent of the Windows display language. */
export function parseRegDefaultValue(output) {
  for (const line of String(output).split(/\r?\n/)) {
    const match = /\sREG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

export class BrowserHelper {
  constructor({ dataDir, hostPath, platform = process.platform, localAppData = process.env.LOCALAPPDATA ?? '', run } = {}) {
    this.dataDir = dataDir;
    this.hostPath = hostPath;
    this.platform = platform;
    this.localAppData = localAppData;
    this.run = run ?? ((args) => promisify(execFile)('reg.exe', args, { windowsHide: true }));
  }

  get supported() {
    return this.platform === 'win32';
  }

  get manifestPath() {
    return path.join(this.dataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`);
  }

  #browserPresent(browser) {
    return Boolean(this.localAppData) && fs.existsSync(path.join(this.localAppData, browser.userData));
  }

  #checkID(extensionID) {
    const id = String(extensionID ?? '').trim();
    if (!EXTENSION_ID.test(id)) throw new Error('An extension ID is 32 letters from a to p.');
    return id;
  }

  /** [{ id, name, status: 'installed' | 'elsewhere' | 'notInstalled' | 'browserMissing', detail }] */
  async status(extensionID = PINNED_EXTENSION_ID) {
    if (!this.supported) return [];
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch {
      // Not written yet.
    }
    const ours = manifest?.path === this.hostPath && manifest?.allowed_origins?.includes(`chrome-extension://${extensionID}/`);
    const entries = [];
    for (const browser of BROWSERS) {
      let registered = null;
      try {
        const { stdout } = await this.run(['query', `HKCU\\${browser.key}\\${HOST_NAME}`, '/ve']);
        registered = parseRegDefaultValue(stdout);
      } catch {
        registered = null;
      }
      let status;
      if (registered === null) status = this.#browserPresent(browser) ? 'notInstalled' : 'browserMissing';
      else if (path.resolve(registered).toLowerCase() === path.resolve(this.manifestPath).toLowerCase() && ours) status = 'installed';
      else status = 'elsewhere';
      entries.push({ id: browser.id, name: browser.name, status, detail: registered ?? '' });
    }
    return entries;
  }

  /** Writes the manifest and registers it for every browser that is present (Chrome's key always). */
  async install(extensionID = PINNED_EXTENSION_ID) {
    if (!this.supported) throw new Error('The browser helper is only available on Windows.');
    const id = this.#checkID(extensionID);
    if (!fs.existsSync(this.hostPath)) throw new Error(`The helper program is missing (${this.hostPath}). Reinstall Sipper.`);
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    fs.writeFileSync(this.manifestPath, `${JSON.stringify(hostManifest({ hostPath: this.hostPath, extensionID: id }), null, 2)}\n`, 'utf8');
    const written = [];
    for (const browser of BROWSERS) {
      if (browser.id !== 'chrome' && !this.#browserPresent(browser)) continue;
      await this.run(['add', `HKCU\\${browser.key}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', this.manifestPath, '/f']);
      written.push(browser.name);
    }
    return written;
  }

  async uninstall() {
    if (!this.supported) return;
    for (const browser of BROWSERS) {
      try {
        await this.run(['delete', `HKCU\\${browser.key}\\${HOST_NAME}`, '/f']);
      } catch {
        // Not registered for this browser.
      }
    }
    fs.rmSync(this.manifestPath, { force: true });
  }
}
