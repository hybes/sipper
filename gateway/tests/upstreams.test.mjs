import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Upstreams, upstreamObjects } from '../src/upstreams.mjs';

test('a fresh controller reaches its not-ready heartbeat without an approved PBX', async () => {
  const heartbeats = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    heartbeats.push({ path: request.url, body: JSON.parse(body) });
    // Stop before ARI connectivity or any call handling. Only startup is tested.
    response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const hosts of ['', ' , ', undefined]) {
      const env = { ...process.env, SIPPER_PORTAL_URL: `http://127.0.0.1:${server.address().port}`,
        SIPPER_GATEWAY_API_KEY: 'fictional-gateway-key'.repeat(3), SIPPER_ARI_PASSWORD: 'fictional-ari-password'.repeat(3) };
      if (hosts === undefined) delete env.SIPPER_UPSTREAM_HOSTS; else env.SIPPER_UPSTREAM_HOSTS = hosts;
      await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url))],
        { env, timeout: 8000 }), error => error.code === 1
          && error.stdout.includes('No upstream PBX hosts are approved')
          && error.stderr.includes('Gateway controller could not start.'));
    }
    assert.equal(heartbeats.length, 3);
    for (const heartbeat of heartbeats) {
      assert.equal(heartbeat.path, '/api/gateway/heartbeat');
      assert.equal(heartbeat.body.ready, false);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('an empty allowlist creates no upstream objects even when an account is assigned', async () => {
  const changes = [];
  const manager = new Upstreams({ put: async (...args) => changes.push(args) }, new Set());
  const account = { id: randomUUID(), revision: 1, password: 'fictional-private-password',
    settings: { server: 'pbx.example.invalid', domain: 'example.invalid', username: '1001', transport: 'tls', srtp: 'required' } };
  await manager.reconcile([account]);
  assert.equal(manager.errors.get(account.id), 'unsupported_settings');
  assert.equal(manager.accounts.size, 0);
  assert.deepEqual(changes, []);
});

test('upstreams require approved encrypted routes and keep secrets out of stored routing metadata', async () => {
  const account = { id: randomUUID(), revision: 1, password: 'a;password=with-sensitive-characters', settings: { server: 'pbx.example.invalid', domain: 'example.invalid', username: '1001', transport: 'tls', srtp: 'required' } };
  const hosts = new Set(['pbx.example.invalid']);
  const built = upstreamObjects(account, hosts);
  assert.equal(built.objects.auth.password, account.password);
  assert.equal(built.objects.registration.line, 'yes');
  assert.throws(() => upstreamObjects(account, new Set()));
  assert.throws(() => upstreamObjects({ ...account, settings: { ...account.settings, transport: 'udp' } }, hosts));
  const changes = [];
  const manager = new Upstreams({ put: async (type, id) => changes.push([type,id]), remove: async (type,id) => changes.push([`remove:${type}`,id]) }, hosts);
  await manager.reconcile([account]);
  assert.equal(changes.length, 4);
  assert.ok(!JSON.stringify([...manager.accounts.values()]).includes(account.password));
  const next = { ...account, revision: 2 };
  await manager.reconcile([next], new Set([built.id]));
  assert.equal(changes.length, 4, 'configuration changes wait for established calls');
  await manager.reconcile([next]);
  assert.equal(changes.length, 12);
  await manager.reconcile([next, { ...account, id: randomUUID(), settings: { ...account.settings, server: 'unapproved.example.invalid' } }]);
  assert.equal(manager.errors.size, 1, 'one unsupported tenant does not stop other accounts');
  assert.equal(manager.accounts.size, 1);
  await manager.reconcile([]);
  assert.equal(manager.accounts.size, 0);
});

test('reconnecting adopts complete routes but recreates lost Asterisk objects from current authorised settings', async () => {
  const account = { id:randomUUID(),revision:1,password:'private-upstream',settings:{server:'pbx.example.invalid',domain:'example.invalid',username:'1001',transport:'tls',srtp:'required'} };
  const live = new Set(), changes = [], persisted = new Map();
  let unavailable = false;
  const manager = new Upstreams({
    put: async (type,id) => { live.add(`${type}/${id}`); changes.push(['put',type,id]); },
    remove: async (type,id) => { live.delete(`${type}/${id}`); changes.push(['remove',type,id]); },
    request: async (_method,path) => {
      if (unavailable) throw Object.assign(new Error('Unavailable'),{status:503});
      if (!live.has(path.split('/').slice(-2).join('/'))) throw Object.assign(new Error('Not found'),{status:404});
    },
  },new Set(['pbx.example.invalid']));
  manager.state = {route: route => persisted.set(route.id,route),removeRoute:id=>persisted.delete(id)};
  await manager.reconcile([account]); const original=[...manager.accounts.values()]; changes.length=0;
  await manager.restore(original); assert.equal(changes.length,0,'A transport reconnect must not re-register complete routes');
  unavailable=true;
  await assert.rejects(manager.restore(original),{status:503}); assert.equal(manager.accounts.size,1); assert.equal(changes.length,0);
  unavailable=false; live.clear();
  await manager.restore(original); assert.equal(manager.accounts.size,0); assert.equal(persisted.size,0);
  await manager.reconcile([{...account,revision:2}]);
  assert.equal(live.size,4); assert.equal([...manager.accounts.values()][0].revision,2);
  assert.ok(!JSON.stringify([...manager.accounts.values()]).includes(account.password));
  live.delete(`auth/${[...manager.accounts.keys()][0]}`);
  await manager.restore([...manager.accounts.values()]); await manager.reconcile([]);
  assert.equal(live.size,0,'A withdrawn route must not return after a partial object loss');
});
