// Separate, OS-encrypted storage. It is never part of manual account exports or renderer state.
import { createHash } from 'node:crypto';
import { SafeStoragePasswordStore } from './passwords.js';

export class ManagedStorage {
  constructor(directory, safeStorage, origin) {
    this.safeStorage = safeStorage;
    const namespace = createHash('sha256').update(origin).digest('hex').slice(0, 24);
    this.store = new SafeStoragePasswordStore(directory, safeStorage, `managed-${namespace}.json`);
  }
  #check() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Secure managed-account storage is unavailable.');
    }
  }
  read() {
    this.#check();
    const result = this.store.lookup('session');
    if (result.status === 'missing') return null;
    if (result.status !== 'found') throw new Error('The saved managed session could not be unlocked.');
    try { return JSON.parse(result.password); }
    catch { throw new Error('The saved managed session could not be read.'); }
  }
  save(value) { this.#check(); this.store.set('session', JSON.stringify(value)); }
  clear() { this.store.remove('session'); }
}
