// Disposable local adapter for the real Worker proxy. It deliberately replaces
// only its HTTPS transport with loopback HTTP; it does not prove Cloudflare/TLS.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { proxyPortal } from '../../website/src/portal.js';

const origin = new URL(process.env.SIPPER_REHEARSAL_ORIGIN);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/') throw new Error('A loopback rehearsal origin is required');
const env = { PORTAL_ORIGIN: 'https://origin.example.invalid', SIPPER_EDGE_SHARED_SECRET: process.env.SIPPER_EDGE_SHARED_SECRET };
const server = createServer(async (incoming, outgoing) => {
  try {
    const base = `http://localhost:${server.address().port}`;
    const url = new URL(incoming.url, base);
    if (url.origin !== base) { outgoing.writeHead(400); outgoing.end(); return; }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    headers.set('cf-connecting-ip', incoming.socket.remoteAddress.replace(/^::ffff:/, ''));
    const request = new Request(url, {
      method: incoming.method, headers,
      ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
    });
    const response = await proxyPortal(request, env, (forwarded, options) => {
      const target = new URL(forwarded.url);
      target.protocol = origin.protocol; target.host = origin.host;
      return fetch(new Request(target, forwarded), options);
    });
    outgoing.writeHead(response.status, {
      ...Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie')),
      ...(response.headers.getSetCookie().length ? { 'Set-Cookie': response.headers.getSetCookie() } : {}),
    });
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.writeHead(502, { 'Cache-Control': 'no-store' }); outgoing.end('Local preview unavailable.');
  }
});
server.listen(0, '127.0.0.1', () => console.log(`http://localhost:${server.address().port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
