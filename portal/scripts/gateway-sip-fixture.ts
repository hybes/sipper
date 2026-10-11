// SIP signalling fixture only. It negotiates SRTP but does not send media.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type { TLSSocket } from 'node:tls'

export const header = (message: string, name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(message)?.[1]?.trim() ?? ''
const status = (message: string) => Number(/^SIP\/2.0 (\d+)/.exec(message)?.[1])
const digest = (algorithm: string, value: string) => createHash(algorithm).update(value).digest('hex')
export class Phone {
  private data = ''
  private messages: string[] = []
  private pending: { match: (message: string) => boolean; resolve: (message: string) => void; reject: (error: Error) => void }[] = []
  private sequence = 0
  private registrationId = randomUUID()
  private tag = randomBytes(8).toString('hex')
  constructor(private socket: TLSSocket, private account: { password: string; settings: { username: string; domain: string } }) {
    socket.on('data', chunk => {
      this.data += chunk.toString()
      while (this.data.includes('\r\n\r\n')) {
        const end = this.data.indexOf('\r\n\r\n') + 4
        const size = Number(header(this.data.slice(0, end), 'Content-Length') || 0)
        if (Buffer.byteLength(this.data) < end + size) break
        const message = this.data.slice(0, end + size); this.data = this.data.slice(end + size)
        if (message.startsWith('OPTIONS ')) { this.respond(message, 200); continue }
        if (message.startsWith('NOTIFY ')) this.respond(message, 200);
        const index = this.pending.findIndex(wait => wait.match(message))
        if (index < 0) this.messages.push(message)
        else this.pending.splice(index, 1)[0]!.resolve(message)
      }
    })
    socket.on('error', error => { for (const wait of this.pending.splice(0)) wait.reject(error) })
  }
  receive(match: (message: string) => boolean, timeout = 8000): Promise<string> {
    const index = this.messages.findIndex(match)
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!)
    return new Promise((resolve, reject) => {
      const wait = { match, resolve: (message: string) => { clearTimeout(timer); resolve(message) }, reject: (error: Error) => { clearTimeout(timer); reject(error) } }
      const timer = setTimeout(() => { this.pending = this.pending.filter(w => w !== wait); reject(new Error('SIP fixture timed out')) }, timeout)
      this.pending.push(wait)
    })
  }
  private get contact() { return `sip:${this.account.settings.username}@127.0.0.1:${this.socket.localPort};transport=tls` }
  private sdp() {
    return ['v=0', 'o=fixture 1 1 IN IP4 127.0.0.1', 's=Fixture signalling test', 'c=IN IP4 127.0.0.1', 't=0 0',
      'm=audio 40000 RTP/SAVP 0', 'a=rtpmap:0 PCMU/8000', `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${randomBytes(30).toString('base64')}`, 'a=sendrecv', ''].join('\r\n')
  }
  private send(method: string, uri: string, id: string, sequence: number, extra: string[] = [], body = '', to?: string, from?: string, branch = `z9hG4bK${randomBytes(8).toString('hex')}`) {
    const identity = `<sip:${this.account.settings.username}@${this.account.settings.domain}>`
    const request = [`${method} ${uri} SIP/2.0`, `Via: SIP/2.0/TLS 127.0.0.1:${this.socket.localPort};branch=${branch};rport`,
      `From: ${from ?? `${identity};tag=${this.tag}`}`, `To: ${to ?? identity}`, `Call-ID: ${id}`, `CSeq: ${sequence} ${method}`, 'Max-Forwards: 70',
      `Contact: <${this.contact}>`, ...extra, ...(body ? ['Content-Type: application/sdp'] : []), `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n')
    this.socket.write(request)
    return branch
  }
  private async authenticated(method: string, uri: string, id: string, body: string, password: string, extra: string[] = []) {
    let seq = ++this.sequence
    const branch = this.send(method, uri, id, seq, extra, body)
    const response = await this.receive(m => header(m, 'Call-ID') === id && status(m) >= 200)
    assert.equal(status(response), 401, 'Gateway must challenge SIP requests')
    if (method === 'INVITE') this.send('ACK', uri, id, seq, [], '', header(response, 'To'), undefined, branch)
    const values = Object.fromEntries([...header(response, 'WWW-Authenticate').matchAll(/([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m => [m[1], m[2] ?? m[3]]))
    if (values.algorithm?.toUpperCase() !== 'SHA-256') return { id, response, sequence: seq, uri }
    assert.ok(values.nonce && values.realm && values.qop?.split(',').includes('auth'))
    const cnonce = randomBytes(12).toString('hex'), hash = (v: string) => digest('sha256', v)
    const answer = hash(`${hash(`${this.account.settings.username}:${values.realm}:${password}`)}:${values.nonce}:00000001:${cnonce}:auth:${hash(`${method}:${uri}`)}`)
    const authorization = `Digest username="${this.account.settings.username}", realm="${values.realm}", nonce="${values.nonce}", uri="${uri}", response="${answer}", algorithm=SHA-256, qop=auth, nc=00000001, cnonce="${cnonce}"${values.opaque ? `, opaque="${values.opaque}"` : ''}`
    seq = ++this.sequence
    this.send(method, uri, id, seq, [...extra, `Authorization: ${authorization}`], body)
    const result = await this.receive(m => header(m, 'Call-ID') === id && status(m) >= 200)
    if (method === 'INVITE') {
      const target = status(result) < 300 ? /<([^>]+)>/.exec(header(result, 'Contact'))?.[1] ?? uri : uri
      this.send('ACK', target, id, seq, [], '', header(result, 'To'))
    }
    return { id, response: result, sequence: seq, uri }
  }
  async register(password = this.account.password, expires = 300) {
    return status((await this.authenticated('REGISTER', `sip:${this.account.settings.domain}`, this.registrationId, '', password, [`Expires: ${expires}`])).response)
  }
  async call(number: string) { return this.authenticated('INVITE', `sip:${number}@${this.account.settings.domain}`, randomUUID(), this.sdp(), this.account.password) }
  async incoming() { const request = await this.receive(m => m.startsWith('INVITE ')); this.respond(request, 180); return request }
  respond(request: string, code: number, body = '') {
    const reason = ({ 180: 'Ringing', 200: 'OK', 486: 'Busy Here', 487: 'Request Terminated' } as Record<number, string>)[code] ?? 'Fixture response'
    this.socket.write([`SIP/2.0 ${code} ${reason}`, ...['Via', 'From', 'To', 'Call-ID', 'CSeq'].map(name => `${name}: ${header(request, name)}${name === 'To' && !header(request, 'To').includes(';tag=') ? `;tag=${this.tag}` : ''}`),
      `Contact: <${this.contact}>`, ...(body ? ['Content-Type: application/sdp'] : []), `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n'))
  }
  answer(request: string) { this.respond(request, 200, this.sdp()); return this.receive(m => m.startsWith('ACK ') && header(m, 'Call-ID') === header(request, 'Call-ID')) }
  async bye(dialog: { id: string; response: string; sequence: number; uri: string }) {
    const uri = /<([^>]+)>/.exec(header(dialog.response, 'Contact'))?.[1] ?? dialog.uri
    this.send('BYE', uri, dialog.id, ++this.sequence, [], '', header(dialog.response, 'To'))
    assert.equal(status(await this.receive(m => header(m, 'Call-ID') === dialog.id && header(m, 'CSeq').endsWith(' BYE'))), 200)
  }
  async transfer(dialog: { id: string; response: string; uri: string }, destination: string, consultation?: { id: string; response: string }) {
    const uri = /<([^>]+)>/.exec(header(dialog.response, 'Contact'))?.[1] ?? dialog.uri
    const tag = (name: string) => /;tag=([^;>\s]+)/.exec(header(consultation!.response, name))?.[1]
    const replaces = consultation ? `?Replaces=${encodeURIComponent(`${consultation.id};to-tag=${tag('To')};from-tag=${tag('From')}`)}` : ''
    this.send('REFER', uri, dialog.id, ++this.sequence, [`Refer-To: <sip:${destination}@${this.account.settings.domain}${replaces}>`], '', header(dialog.response, 'To'))
    const response = await this.receive(m => header(m, 'Call-ID') === dialog.id && header(m, 'CSeq').endsWith(' REFER') && status(m) >= 200)
    if (status(response) !== 202) return status(response)
    for (;;) {
      const notify = await this.receive(m => m.startsWith('NOTIFY ') && header(m, 'Call-ID') === dialog.id)
      const result = status(notify.split('\r\n\r\n')[1] ?? '')
      if (result >= 200) return result
    }
  }
  async ended(dialog: { id: string }) {
    const bye = await this.receive(m => m.startsWith('BYE ') && header(m, 'Call-ID') === dialog.id)
    this.respond(bye, 200)
  }
}
