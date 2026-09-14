// JSON files in the app's data folder (%APPDATA%\Sipper on Windows). Writes are debounced and
// atomic (temporary file, then rename). Ported from Sipper/Store/PersistenceStore.swift.

import fs from 'node:fs';
import path from 'node:path';

export const STORE_FILES = {
  profiles: 'profiles.json',
  accounts: 'accounts.json',
  history: 'history.json',
  contacts: 'contacts.json',
  settings: 'settings.json',
};

export class JSONStore {
  constructor(directory, { delay = 300, log = () => {} } = {}) {
    this.directory = directory;
    this.delay = delay;
    this.log = log;
    this.pending = new Map();
    fs.mkdirSync(directory, { recursive: true });
  }

  pathFor(file) {
    return path.join(this.directory, file);
  }

  /** Parsed contents, or null when the file is missing. An unreadable file is set aside, not overwritten. */
  load(file) {
    const target = this.pathFor(file);
    let text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      const backup = `${target}.corrupt-${Math.floor(Date.now() / 1000)}`;
      try {
        fs.renameSync(target, backup);
      } catch {
        // Leave it in place; the next save replaces it.
      }
      this.log(`Sipper: could not read ${file} (${error.message}); moved it to ${path.basename(backup)}`);
      return null;
    }
  }

  /** Saves after a short pause; the newest value for a file wins. */
  saveSoon(file, value) {
    const existing = this.pending.get(file);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(file);
      this.#write(file, value);
    }, this.delay);
    this.pending.set(file, { timer, value });
  }

  /** Writes every pending save now (used when quitting). */
  flush() {
    for (const [file, { timer, value }] of this.pending) {
      clearTimeout(timer);
      this.#write(file, value);
    }
    this.pending.clear();
  }

  saveNow(file, value) {
    const existing = this.pending.get(file);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(file);
    }
    this.#write(file, value);
  }

  #write(file, value) {
    const target = this.pathFor(file);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
      fs.renameSync(temporary, target);
    } catch (error) {
      this.log(`Sipper: saving ${file} failed: ${error.message}`);
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing more to do.
      }
    }
  }
}
