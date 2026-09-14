// Helpers for the integration and end-to-end tests: the local SIP test server, engine processes
// that record their events, and account configurations for the test domain.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineClient } from '../src/main/engineClient.js';

export const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repository = path.resolve(windowsRoot, '..');
export const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
export const engineExecutable = process.env.SIPPER_ENGINE || path.join(windowsRoot, 'engine', 'build', exe('sipper-engine'));
export const hostExecutable = process.env.SIPPER_BROWSER_HOST || path.join(windowsRoot, 'engine', 'build', exe('sipper-browser-host'));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** tools/sip-test-server.py with users 1001 and 1002 (password "secret"), *97 answered, 2/5 voicemail for 1001. */
export async function startSIPServer(port) {
  const args = [
    path.join(repository, 'tools', 'sip-test-server.py'),
    '--port', String(port), '--tls-port', '0',
    '--user', '1001:secret', '--user', '1002:secret',
    '--mwi', '1001:2/5', '--answer-special',
  ];
  const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output.push(chunk.toString());
      if (output.join('').includes('listening on')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`sip-test-server exited (${code}): ${output.join('')}`)));
  });
  return { child, output, stop: () => child.kill() };
}

/** An engine plus a record of every event it sent, so waits never miss an early event. */
export async function startEngine(label) {
  const engine = new EngineClient({ executable: engineExecutable });
  const events = [];
  const waiters = new Set();
  const logs = [];
  const record = (type) => (payload) => {
    const entry = { type, ...payload };
    events.push(entry);
    for (const waiter of waiters) {
      if (waiter.matches(entry)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(entry);
      }
    }
  };
  for (const type of ['registration', 'incomingCall', 'callChanged', 'callEnded', 'voicemail', 'transferStatus']) {
    engine.on(type, record(type));
  }
  engine.on('log', (line) => logs.push(line));

  engine.waitFor = (type, predicate = () => true, timeout = 10000) => {
    const matches = (entry) => entry.type === type && predicate(entry);
    const seen = events.find(matches);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`${label}: timed out waiting for ${type}\n--- last log lines ---\n${logs.slice(-40).join('\n')}`));
      }, timeout);
      waiters.add(waiter);
    });
  };
  engine.clearEvents = () => events.splice(0, events.length);
  engine.label = label;
  await engine.launch();
  return engine;
}

export const engineStartParams = {
  userAgent: 'Sipper-test',
  stunServers: [],
  logLevel: 4,
  echoMode: 'off',
  ports: { udp: 0, tcp: 0, tls: 0 },
  verifyTls: false,
  nullAudio: true,
  codecs: [
    { id: 'PCMU/8000/1', enabled: true },
    { id: 'PCMA/8000/1', enabled: true },
  ],
};

/** Engine account configuration for user@sipper.test through the test server. */
export function testAccount(user, port, overrides = {}) {
  return {
    id: `acc-${user}`,
    aor: `sip:${user}@sipper.test`,
    registrar: 'sip:sipper.test;transport=udp',
    proxy: `sip:127.0.0.1:${port};transport=udp;lr`,
    regTimeout: 300,
    authUsername: user,
    password: 'secret',
    srtp: 'disabled',
    useIce: false,
    useStun: false,
    ...overrides,
  };
}
