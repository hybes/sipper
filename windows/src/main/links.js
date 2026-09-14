// Links Sipper is launched with: sip:, sips: and tel: numbers, sipper://add-accounts imports, and
// sipper://toast/… actions from notification buttons, which carry a per-run token so a web page
// cannot answer or decline calls by opening such a link.

import { randomBytes, timingSafeEqual } from 'node:crypto';

const LINK = /^(sipper|sips?|tel):/i;

/** The first link in a command line. Chromium may add or reorder switches, so search rather than index. */
export function findLink(argv) {
  return argv.slice(1).find((argument) => typeof argument === 'string' && LINK.test(argument)) ?? null;
}

export class LinkTokens {
  constructor() {
    this.token = randomBytes(18).toString('hex');
  }

  toastURL(action, callId) {
    return `sipper://toast/${action}?call=${callId}&token=${this.token}`;
  }

  isToastLink(link) {
    return /^sipper:\/\/toast\//i.test(link);
  }

  /** { action, callId } for a genuine notification action, otherwise null. */
  parseToastAction(link) {
    const match = /^sipper:\/\/toast\/(answer|decline|open)\?([^#]*)$/i.exec(link);
    if (!match) return null;
    const params = new URLSearchParams(match[2]);
    const token = Buffer.from(params.get('token') ?? '');
    const expected = Buffer.from(this.token);
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) return null;
    const callId = Number.parseInt(params.get('call') ?? '', 10);
    return { action: match[1].toLowerCase(), callId: Number.isInteger(callId) ? callId : null };
  }
}
