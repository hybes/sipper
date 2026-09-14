// SIP passwords, encrypted with Electron's safeStorage (the Windows Data Protection API, tied to
// the signed-in Windows user) and kept in passwords.json next to the other data files. Nothing
// is stored in clear. The Mac app keeps the same passwords in the Keychain.

import fs from 'node:fs';
import path from 'node:path';

export class SafeStoragePasswordStore {
  /**
   * @param {string} directory  data folder
   * @param {Electron.SafeStorage} safeStorage
   */
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'passwords.json');
    this.safeStorage = safeStorage;
    this.entries = this.#read();
  }

  /** { status: 'found', password } | { status: 'missing' } | { status: 'denied', reason } */
  lookup(accountID) {
    const encrypted = this.entries[accountID];
    if (!encrypted) return { status: 'missing' };
    try {
      return { status: 'found', password: this.safeStorage.decryptString(Buffer.from(encrypted, 'base64')) };
    } catch (error) {
      return { status: 'denied', reason: error.message };
    }
  }

  set(accountID, password) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure password storage is not available for this Windows user.');
    }
    this.entries[accountID] = this.safeStorage.encryptString(password).toString('base64');
    this.#write();
  }

  remove(accountID) {
    if (!(accountID in this.entries)) return;
    delete this.entries[accountID];
    this.#write();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {};
    } catch {
      return {};
    }
  }

  #write() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: this.entries }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

/** Keeps passwords in memory only. For tests and for development runs that must not touch the real store. */
export class MemoryPasswordStore {
  constructor() {
    this.entries = new Map();
  }

  lookup(accountID) {
    return this.entries.has(accountID) ? { status: 'found', password: this.entries.get(accountID) } : { status: 'missing' };
  }

  set(accountID, password) {
    this.entries.set(accountID, password);
  }

  remove(accountID) {
    this.entries.delete(accountID);
  }
}
