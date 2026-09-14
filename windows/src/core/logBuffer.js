// Ring buffer of PJSIP and app log lines for Settings › Diagnostics. Ported from
// Sipper/SIP/SIPLogBuffer.swift. Listeners hear about new lines at most every 250 ms.

export class LogBuffer {
  constructor({ capacity = 4000, mirror = false } = {}) {
    this.capacity = capacity;
    this.mirror = mirror;
    this.lines = [];
    this.listeners = new Set();
    this.timer = null;
  }

  append(line) {
    if (this.mirror && line.startsWith('Sipper:')) process.stderr.write(`${line}\n`);
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    this.#notifySoon();
  }

  snapshot() {
    return this.lines.slice();
  }

  clear() {
    this.lines = [];
    this.#notifySoon();
  }

  export() {
    return this.lines.join('\n');
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #notifySoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const listener of this.listeners) listener();
    }, 250);
  }
}
