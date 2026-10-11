import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

// A short-lived, bounded AMI request. Never log frames: AuthDetail can contain
// upstream credentials. Only opaque route names and registration state escape.
export async function upstreamStatus({ url = 'tcp://127.0.0.1:5038', password }) {
  const address = new URL(url), host = address.hostname.replace(/^\[|\]$/g, '');
  if (!['tcp:', 'tls:'].includes(address.protocol) || address.username || address.password || address.pathname
    || address.search || address.hash || !address.port
    || (address.protocol === 'tcp:' && !['127.0.0.1', '::1', 'localhost'].includes(host))
    || typeof password !== 'string' || password.length < 32 || /[\r\n]/.test(password)) throw new Error('Invalid private AMI configuration');
  return new Promise((resolve, reject) => {
    const actionId = randomUUID(), reports = new Map();
    let buffer = '', bytes = 0, loggedIn = false, listed = false, done = false;
    const socket = address.protocol === 'tls:'
      ? tls.connect({ host, port: Number(address.port), ...(net.isIP(host) ? {} : { servername: host }), minVersion: 'TLSv1.2' })
      : net.connect({ host, port: Number(address.port) });
    const finish = (error) => {
      if (done) return;
      done = true; clearTimeout(timer); buffer = ''; socket.destroy();
      if (error) reject(new Error('Upstream registration snapshot unavailable'));
      else resolve(reports);
    };
    const timer = setTimeout(() => finish(true), 5000);
    socket.on('error', () => finish(true));
    socket.on('close', () => finish(true));
    socket.once(address.protocol === 'tls:' ? 'secureConnect' : 'connect', () => {
      socket.write(`Action: Login\r\nActionID: ${actionId}\r\nUsername: sipper-observer\r\nSecret: ${password}\r\nEvents: off\r\n\r\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) return finish(true);
      buffer += chunk;
      let end;
      while (!done && (end = buffer.indexOf('\r\n\r\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 4);
        const fields = Object.fromEntries(frame.split('\r\n').filter(line => line.includes(':')).map(line => {
          const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
        }));
        if (fields.actionid !== actionId) continue;
        if (fields.response === 'Error') return finish(true);
        if (!loggedIn) {
          if (fields.response !== 'Success') return finish(true);
          loggedIn = true;
          socket.write(`Action: PJSIPShowRegistrationsOutbound\r\nActionID: ${actionId}\r\n\r\n`);
        } else if (fields.response === 'Success' && fields.eventlist === 'start') listed = true;
        else if (listed && fields.event === 'OutboundRegistrationDetail') {
          const state = { Registered: 'registered', Unregistered: 'unregistered', Rejected: 'failed' }[fields.status];
          if (!/^u[a-f0-9]{32}r[1-9][0-9]*$/.test(fields.objectname ?? '')) continue;
          if (!state || reports.has(fields.objectname)) return finish(true);
          reports.set(fields.objectname, state);
        } else if (listed && fields.event === 'OutboundRegistrationDetailComplete' && fields.eventlist === 'Complete') finish(false);
      }
    });
  });
}

export async function reportUpstreamStatus(options, portal, routes, current) {
  if (!routes.length || !current()) return;
  const observedAt = new Date().toISOString(), snapshot = await upstreamStatus(options);
  const reports = routes.filter(route => snapshot.has(route.id)).map(route => ({
    configurationId: route.configurationId, revision: route.revision, state: snapshot.get(route.id), observedAt,
  }));
  for (let offset = 0; offset < reports.length && current(); offset += 20) {
    await portal('POST', 'upstream-registrations', { reports: reports.slice(offset, offset + 20) });
  }
}
