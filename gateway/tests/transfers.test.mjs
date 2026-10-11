import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.mjs';
import { Calls } from '../src/calls.mjs';

function fixture(t, incoming = false, otherIncoming = false) {
  const directory = mkdtempSync(join(tmpdir(), 'sipper-transfer-')), path = join(directory, 'state.sqlite');
  const stores = [], open = () => { const state = new State(path, `owner-${stores.length}`, 'fixture'); stores.push(state); return state; };
  t.after(() => { for (const state of stores) state.close(); rmSync(directory, { recursive: true, force: true }); });
  const ari = new EventEmitter(), channels = new Map(), bridges = new Map(), attempts = new Map(), requests = [], reports = [];
  const error = status => Object.assign(new Error('Fixture request failed'), { status });
  const f = { ari, channels, bridges, attempts, requests, reports, open, error, state: open(), offline: false, allowed: true, controlled: true };
  ari.request = async (method, path, body, query = {}) => {
    requests.push([method, path, body, query]);
    if (f.before) await f.before(method, path, body, query);
    const [kind, id, action] = path.split('/');
    let result;
    if (kind === 'applications') result = { channel_ids: [...channels.keys()] };
    else if (kind === 'channels') {
      if (method === 'GET') result = id ? channels.get(id) : [...channels.values()];
      if (method === 'POST' && !id) channels.set(query.channelId, { id: query.channelId, state: 'Ringing' });
      else if (method === 'POST' && action === 'transfer_progress') {
        if (!channels.has(id)) throw error(404);
      } else if (method === 'DELETE') {
        channels.delete(id); for (const set of bridges.values()) set.delete(id);
      }
    } else if (kind === 'bridges') {
      if (method === 'GET' && bridges.has(id)) result = { id, channels: [...bridges.get(id)] };
      if (method === 'POST' && !action) { if (bridges.has(id)) throw error(409); bridges.set(id, new Set()); }
      if (action === 'addChannel') {
        if (!bridges.has(id)) throw error(404);
        for (const channel of query.channel.split(',')) {
          if (!channels.has(channel)) throw error(400);
          for (const set of bridges.values()) set.delete(channel);
          bridges.get(id).add(channel);
        }
      }
      if (method === 'DELETE') bridges.delete(id);
    }
    if (method === 'GET' && result === undefined) throw error(404);
    if (f.after) await f.after(method, path, body, query);
    return result;
  };
  f.portal = async (method, path, body) => {
    reports.push([method, path, body]);
    if (f.offline) throw error(503);
    if (path === 'transfers' && method === 'GET') return { transfers: [...attempts.values()].filter(attempt => attempt.state === 'pending') };
    if (path === 'transfers') {
      if (!f.allowed) throw error(409);
      const attempt = attempts.get(body.transferId) ?? { id: body.transferId, ...body, state: 'pending',
        configurationId: 'config', revision: 1, expiresAt: new Date(Date.now() + 45000).toISOString() };
      attempts.set(attempt.id, attempt); return attempt;
    }
    if (path.startsWith('transfers/')) {
      const attempt = attempts.get(path.slice(10)); if (!attempt) throw error(404);
      if (body && attempt.state !== 'pending' && attempt.state !== body.state) throw error(409);
      if (body) attempt.state = body.state;
      return { ...attempt, endRequested: Boolean(f.endRequested) };
    }
    return { state: body?.event === 'ended' ? 'ended' : 'answered', endRequested: Boolean(f.endRequested) };
  };
  f.upstreams = { get: () => ({ id: 'route' }) };
  f.createController = state => {
    const calls = new Calls(ari, f.portal, f.upstreams, state);
    calls.asteriskStartedAt = '2026-09-28T09:00:00Z'; calls.canControl = () => f.controlled;
    return calls;
  };
  f.calls = f.createController(f.state);
  for (const [id, direction] of [['source', incoming], ['consult', otherIncoming]]) {
    const call = { id, parent: `${id}-${direction ? 'remote' : 'phone'}`, winner: `${id}-${direction ? 'phone' : 'remote'}`,
      incoming: direction, connected: true, reported: true, bridge: `bridge-${id}`, upstream: 'route',
      configurationId: 'config', revision: 1, originDeviceId: direction ? undefined : 'device',
      asteriskStartedAt: f.calls.asteriskStartedAt,
      legs: new Map([[`${id}-${direction ? 'phone' : 'remote'}`, direction ? { deviceId: 'device' } : {}]]) };
    f.state.save(call); f.calls.calls.set(id, call);
    for (const name of [call.parent, call.winner]) { channels.set(name, { id: name, state: 'Up' }); f.calls.channels.set(name, call); }
    bridges.set(call.bridge, new Set([call.parent, call.winner]));
  }
  f.event = (blind = false) => ({ type: 'ChannelTransfer', referred_by: { source_channel: { id: 'source-phone' } },
    refer_to: { requested_destination: blind ? { destination: '23456789' } : { protocol_id: 'private-dialog', destination: 'ignored' },
      ...(blind ? {} : { destination_channel: { id: 'consult-phone' } }) } });
  f.restart = () => {
    ari.off('event', f.calls.listener);
    f.state = open(); f.calls = f.createController(f.state); f.calls.accepting = false; f.calls.restore(f.state.load());
    return f.calls;
  };
  return f;
}

test('attended transfers preserve both remote legs and commit topology before success for either call direction', async t => {
  for (const incoming of [false, true]) for (const otherIncoming of [false, true]) {
    const f = fixture(t, incoming, otherIncoming);
    f.before = async (method, path, _body, query) => {
      if (path.endsWith('/transfer_progress') && query.states === 'channel_answered') {
        const snapshot = f.state.load();
        assert.equal(snapshot.calls.length, 1); assert.equal(snapshot.calls[0].transferred, true);
        assert.equal(snapshot.transfers[0].phase, 'completed');
      }
    };
    await f.calls.transfers.begin(f.event());
    assert.equal(f.calls.calls.size, 1); assert.equal(f.bridges.size, 1);
    const call = f.calls.calls.get('source');
    assert.deepEqual([...f.bridges.get(call.bridge)].sort(), ['consult-remote', 'source-remote']);
    assert.deepEqual([...f.channels.keys()].sort(), ['consult-remote', 'source-remote']);
    assert.equal(f.calls.channels.get('consult-remote'), call);
    assert.equal([...f.attempts.values()][0].state, 'completed');
    assert.equal(f.state.load().transfers.length, 0);
    assert.equal(f.state.load().endings.length, 0, 'Transferred consultation must not terminate its moved remote');
    f.restart(); await f.calls.verifyRecovery(); await f.calls.reconcile();
    assert.equal(f.calls.calls.size, 1);
    assert.ok(!f.reports.some(([, , body]) => body?.event === 'connected'), 'Recovery must not reassign a transferred call to its former device');
    await f.calls.end(f.calls.calls.get('source'), 'completed'); await f.calls.tick();
    assert.equal(f.channels.size, 0); assert.equal(f.bridges.size, 0);
  }
});

test('blind transfer waits for an answer, rechecks authority and never journals its destination', async t => {
  for (const accepted of [true, false]) {
    const f = fixture(t);
    await f.calls.transfers.begin(f.event(true));
    const transfer = [...f.calls.transfers.pending.values()][0];
    assert.equal(transfer.phase, 'pending'); assert.equal(f.channels.get(transfer.target).state, 'Ringing');
    assert.deepEqual([...f.bridges.get('bridge-source')].sort(), ['source-phone', 'source-remote']);
    assert.ok(!JSON.stringify(f.state.load()).includes('23456789'));
    f.allowed = accepted; f.channels.get(transfer.target).state = 'Up';
    await f.calls.transfers.run(transfer, () => f.calls.transfers.complete(transfer));
    assert.equal([...f.attempts.values()][0].state, accepted ? 'completed' : 'failed');
    assert.equal(f.channels.has('source-phone'), !accepted);
    assert.equal(f.channels.has('source-remote'), true);
    assert.equal(f.channels.has(transfer.target), accepted);
    assert.equal(f.channels.has('consult-phone'), true);
  }
});

test('invalid, cross-account, cross-device and upstream REFER never creates an admission or dials', async t => {
  for (const kind of ['upstream', 'unresolved', 'other-remote', 'device', 'configuration', 'revision', 'suspended', 'destination', 'terminal-event']) {
    const f = fixture(t), event = f.event();
    if (kind === 'upstream') event.referred_by.source_channel.id = 'source-remote';
    if (kind === 'unresolved') delete event.refer_to.destination_channel;
    if (kind === 'other-remote') event.refer_to.destination_channel.id = 'consult-remote';
    if (kind === 'device') f.calls.calls.get('consult').originDeviceId = 'another-device';
    if (kind === 'configuration') f.calls.calls.get('consult').configurationId = 'another-account';
    if (kind === 'revision') f.calls.calls.get('consult').revision = 2;
    if (kind === 'suspended') f.calls.accepting = false;
    if (kind === 'destination') event.refer_to = { requested_destination: { destination: 'sip:2000@untrusted.invalid' } };
    if (kind === 'terminal-event') { event.state = 'channel_answered'; assert.equal(f.calls.transfers.event(event), true); }
    else await f.calls.transfers.begin(event);
    assert.equal(f.attempts.size, 0, kind); assert.equal(f.channels.size, 4, kind); assert.equal(f.bridges.size, 2, kind);
  }
});

test('uncertain ARI bridge failure restores both original conversations without publishing success', async t => {
  const f = fixture(t); let failed = false;
  f.after = async (method, path) => {
    if (!failed && method === 'POST' && path.startsWith('bridges/sipper-transfer-') && path.endsWith('/addChannel')) {
      failed = true; throw f.error(503); // The move took effect but its response was lost.
    }
  };
  await f.calls.transfers.begin(f.event());
  assert.equal([...f.attempts.values()][0].state, 'failed');
  for (const id of ['source', 'consult']) assert.deepEqual([...f.bridges.get(`bridge-${id}`)].sort(), [`${id}-phone`, `${id}-remote`]);
  assert.equal(f.channels.size, 4); assert.equal(f.bridges.size, 2);
  assert.ok(!f.requests.some(([, , , query]) => query.states === 'channel_answered'));
});

test('restart rolls back an interrupted move; committed transfer cleanup and reports survive portal loss', async t => {
  for (const committed of [false, true]) {
    const f = fixture(t); let interrupted = false;
    f.after = async (method, path, _body, query) => {
      const cut = committed ? path.endsWith('/transfer_progress') && query.states === 'channel_answered'
        : method === 'POST' && path.startsWith('bridges/sipper-transfer-') && path.endsWith('/addChannel');
      if (cut && !interrupted) { interrupted = true; f.controlled = false; throw f.error(503); }
    };
    await f.calls.transfers.begin(f.event()).catch(() => {});
    assert.equal(f.state.load().transfers[0].phase, committed ? 'completed' : 'moving');
    f.restart(); f.controlled = true; f.after = undefined; f.offline = true;
    await f.calls.verifyRecovery(); await assert.rejects(f.calls.reconcile());
    assert.equal(f.channels.size, committed ? 2 : 4);
    assert.equal(f.state.load().transfers.length, 1, 'Unsent result stays durable');
    f.offline = false; await f.calls.reconcile();
    assert.equal(f.state.load().transfers.length, 0);
    assert.equal(f.calls.calls.size, committed ? 1 : 2);
    assert.equal([...f.attempts.values()][0].state, committed ? 'completed' : 'failed');
    if (!committed) for (const id of ['source', 'consult']) assert.equal(f.bridges.get(`bridge-${id}`).size, 2);
  }
});

test('a caller hangup and timeout cancel a pending blind leg; opposite attempts cannot overlap', async t => {
  for (const action of ['hangup', 'timeout']) {
    const f = fixture(t);
    await f.calls.transfers.begin(f.event(true));
    const transfer = [...f.calls.transfers.pending.values()][0];
    const opposite = f.event(); opposite.referred_by.source_channel.id = 'consult-phone'; opposite.refer_to.destination_channel.id = 'source-phone';
    await f.calls.transfers.begin(opposite);
    assert.equal(f.attempts.size, 1);
    if (action === 'timeout') transfer.expires = Date.now() - 1;
    else {
      f.channels.delete('source-remote');
      f.calls.event({ type: 'ChannelDestroyed', channel: { id: 'source-remote' } });
      await transfer.work;
    }
    await f.calls.tick(); await f.calls.reconcile();
    assert.equal([...f.attempts.values()][0].state, 'failed');
    assert.equal(f.channels.has(transfer.target), false);
    assert.equal(f.calls.calls.has('consult'), true);
    assert.equal(f.calls.calls.has('source'), action !== 'hangup');
  }
});

test('orphan admission is failed after a late HTTP response and admin end applies to a committed continuation', async t => {
  const f = fixture(t);
  f.attempts.set('orphan', { id: 'orphan', state: 'pending' });
  await f.calls.reconcile(); assert.equal(f.attempts.get('orphan').state, 'failed');
  f.attempts.clear(); f.endRequested = true;
  await f.calls.transfers.begin(f.event()); await f.calls.tick();
  assert.equal(f.calls.calls.size, 0); assert.equal(f.channels.size, 0);
  assert.ok(f.reports.some(([, , body]) => body?.event === 'ended' && body.reason === 'admin_ended'));
});

test('pending snapshot racing terminal completion cannot rewrite the outcome or pause healthy calls', async t => {
  const f = fixture(t), portal = f.calls.portal;
  f.attempts.set('racing', { id: 'racing', state: 'completed' });
  f.calls.portal = async (method, path, body) => path === 'transfers' && method === 'GET'
    ? { transfers: [{ id: 'racing' }] } : portal(method, path, body);
  await f.calls.reconcile();
  assert.equal(f.attempts.get('racing').state, 'completed'); assert.equal(f.calls.calls.size, 2);
});

test('a failed topology commit pauses control and recovery restores calls without a success notification', async t => {
  const f = fixture(t), persist = f.state.transfer.bind(f.state);
  f.state.transfer = (transfer, continuation) => {
    if (continuation) throw new Error('Fixture disk full');
    persist(transfer);
  };
  await assert.rejects(f.calls.transfers.begin(f.event()), /commit unavailable/);
  assert.equal(f.calls.storageFailed, true); assert.equal(f.calls.accepting, false);
  assert.equal(f.state.load().calls.length, 2); assert.equal(f.state.load().transfers[0].phase, 'moving');
  assert.ok(!f.requests.some(([, , , query]) => query.states === 'channel_answered'));
  f.restart(); await f.calls.verifyRecovery(); await f.calls.reconcile();
  assert.equal(f.calls.calls.size, 2); assert.equal(f.channels.size, 4); assert.equal(f.bridges.size, 2);
  assert.equal([...f.attempts.values()][0].state, 'failed');
});
