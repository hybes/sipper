// Runs sipper-engine as a child process and speaks its JSON-lines protocol
// (windows/engine/PROTOCOL.md). Plain Node: no Electron imports, so tests can use it too.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export class EngineClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.executable  path to sipper-engine
   * @param {number} [options.requestTimeout]  milliseconds before a request is abandoned
   */
  constructor({ executable, requestTimeout = 15000 }) {
    super();
    this.executable = executable;
    this.requestTimeout = requestTimeout;
    this.child = null;
    this.nextID = 1;
    this.pending = new Map();
    this.pjsipVersion = '';
  }

  get isAlive() {
    return this.child !== null;
  }

  /** Starts the process and resolves once it has said hello. */
  launch() {
    if (this.child) return Promise.resolve(this.pjsipVersion);
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;

      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => this.#receive(line, (hello) => {
        if (settled) return;
        settled = true;
        this.pjsipVersion = hello.pjsip || '';
        resolve(this.pjsipVersion);
      }));

      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        this.emit('log', `sipper-engine: ${line}`);
      });

      child.on('error', (error) => {
        this.child = null;
        this.#failPending(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        const error = new Error(`The SIP engine stopped (${signal || `exit code ${code}`}).`);
        this.#failPending(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.emit('exit', { code, signal });
      });

      // Writing to a process that has died must not crash the app.
      child.stdin.on('error', () => {});
    });
  }

  /** Sends a request and resolves with its result, or rejects with the engine's message. */
  request(method, params = {}) {
    if (!this.child) return Promise.reject(new Error('The SIP engine is not running.'));
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The SIP engine did not answer ${method} in time.`));
      }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Asks the engine to unregister and exit; kills it if it does not within `grace` ms. */
  async shutdown(grace = 4000) {
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    this.request('shutdown').catch(() => {});
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), grace);
    await exited;
    clearTimeout(timer);
  }

  #receive(line, onHello) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('log', `sipper-engine: ${line}`);
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error || 'The SIP engine reported an error.'));
      return;
    }
    if (message.event === 'hello') {
      onHello(message);
      return;
    }
    if (message.event === 'log') {
      this.emit('log', message.line);
      return;
    }
    if (message.event) this.emit(message.event, message);
  }

  #failPending(error) {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(id);
    }
  }
}
