import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

export class Ari extends EventEmitter {
  constructor({ url, username = 'sipper-controller', password }) {
    super();
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/ari') throw new Error('Invalid ARI URL');
    if (!password || password.length < 32) throw new Error('ARI password is required');
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  async request(method, path, body, query = {}) {
    const url = new URL(`${this.url.href}/${path}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    const response = await fetch(url, { method, headers: { authorization: this.authorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) { const error = new Error(`ARI request failed (${response.status})`); error.status = response.status; throw error; }
    if (response.status === 204) return;
    return response.json();
  }
  async connect() {
    if (this.socket) throw new Error('ARI connection already exists');
    const url = new URL(`${this.url.href}/events`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('app', 'sipper');
    const socket = new WebSocket(url, { headers: { authorization: this.authorization }, handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    this.socket = socket;
    socket.on('message', bytes => { try { this.emit('event', JSON.parse(bytes.toString())); } catch { this.emit('fault'); } });
    socket.on('error', () => this.emit('fault'));
    let alive = true;
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!alive) { socket.terminate(); return; }
      alive = false; socket.ping();
    }, 10_000);
    heartbeat.unref();
    socket.on('pong', () => { alive = true; });
    socket.on('close', () => { clearInterval(heartbeat); if (this.socket === socket) this.socket = undefined; this.emit('disconnected'); });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new Error('ARI connection failed')));
      socket.once('close', () => reject(new Error('ARI connection closed')));
    });
  }
  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
  close() { this.socket?.terminate(); }
  async put(type, id, fields) {
    return this.request('PUT', `asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(id)}`,
      { fields: Object.entries(fields).map(([attribute, value]) => ({ attribute, value: String(value) })) });
  }
  async remove(type, id) {
    try { await this.request('DELETE', `asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(id)}`); }
    catch (error) { if (error.status !== 404) throw error; }
  }
}
