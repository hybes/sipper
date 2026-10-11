import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { upstreamStatus, reportUpstreamStatus } from '../src/upstream-status.mjs';

test('AMI snapshots are complete, bounded, authenticated and strip upstream credentials', async t => {
  const id = `u${'a'.repeat(32)}r1`, password = 'test-observer-password-'.repeat(2);
  let mode = 'registered', commands = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('error', () => {});
    socket.write('Asterisk Call Manager/11.0.0\r\n');
    socket.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\r\n\r\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 4);
        const action = /^Action: (.+)$/m.exec(frame)?.[1].trim(), actionId = /^ActionID: (.+)$/m.exec(frame)?.[1].trim();
        commands.push(action);
        if (action === 'Login') {
          assert.ok(frame.includes(`Secret: ${password}`)); assert.ok(frame.includes('Events: off'));
          socket.write(`Response: ${mode === 'denied' ? 'Error' : 'Success'}\r\nActionID: ${actionId}\r\n\r\n`);
        } else {
          assert.equal(action, 'PJSIPShowRegistrationsOutbound');
          if (mode === 'oversized') { socket.end('x'.repeat(4 * 1024 * 1024 + 1)); return; }
          socket.write(`Response: Success\r\nEventList: start\r\nActionID: ${actionId}\r\n\r\n`);
          const event = `Event: OutboundRegistrationDetail\r\nObjectName: ${id}\r\nStatus: ${mode === 'failed' ? 'Rejected' : mode === 'unregistered' ? 'Unregistered' : 'Registered'}\r\nActionID: ${actionId}\r\n\r\n`;
          socket.write(event.slice(0, 19)); socket.write(event.slice(19));
          socket.write(`Event: AuthDetail\r\nPassword: private-upstream-password\r\nActionID: ${actionId}\r\n\r\n`);
          if (mode === 'duplicate') socket.write(event);
          if (mode !== 'incomplete') socket.write(`Event: OutboundRegistrationDetailComplete\r\nEventList: Complete\r\nActionID: ${actionId}\r\n\r\n`);
          socket.end();
        }
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { url: `tcp://127.0.0.1:${server.address().port}`, password };
  for (mode of ['registered', 'failed', 'unregistered']) {
    commands = [];
    assert.deepEqual([...(await upstreamStatus(options))], [[id, mode]]);
    assert.deepEqual(commands, ['Login', 'PJSIPShowRegistrationsOutbound']);
  }
  for (mode of ['denied', 'incomplete', 'duplicate', 'oversized']) await assert.rejects(upstreamStatus(options), /snapshot unavailable/);
  await assert.rejects(upstreamStatus({ ...options, password: `${password}\r\nAction: Command` }), /Invalid private AMI/);
  await assert.rejects(upstreamStatus({ ...options, url: 'tcp://example.invalid:5038' }), /Invalid private AMI/);
  mode = 'registered';
  const sent = [], routes = [{ id, configurationId: 'a'.repeat(32), revision: 1 }];
  await reportUpstreamStatus(options, async (...args) => sent.push(args), routes, () => true);
  assert.equal(sent[0][1], 'upstream-registrations');
  assert.deepEqual(Object.keys(sent[0][2].reports[0]).sort(), ['configurationId', 'observedAt', 'revision', 'state']);
  assert.equal(sent[0][2].reports[0].state, 'registered');
  await reportUpstreamStatus(options, () => assert.fail('former owner must not report'), routes, () => false);
});
