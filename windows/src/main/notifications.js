// Incoming and missed call notifications. On Windows the incoming-call toast is built from XML so
// it can use the call scenario (it stays on screen) with Answer and Decline buttons; the buttons
// open sipper://toast/… links, which reach the running app as a second launch.

import { Notification } from 'electron';

import { recordDisplayName } from '../core/models.js';
import { callDisplayName } from '../core/sip.js';

const escapeXML = (text) => String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function incomingToastXML({ title, detail, answerURL, declineURL, openURL }) {
  return [
    `<toast scenario="incomingCall" useButtonStyle="true" activationType="protocol" launch="${escapeXML(openURL)}">`,
    '<visual><binding template="ToastGeneric">',
    '<text hint-callScenarioCenterAlign="true">Incoming call</text>',
    `<text hint-callScenarioCenterAlign="true">${escapeXML(title)}</text>`,
    detail ? `<text hint-callScenarioCenterAlign="true">${escapeXML(detail)}</text>` : '',
    '</binding></visual>',
    '<actions>',
    `<action content="Answer" activationType="protocol" arguments="${escapeXML(answerURL)}" hint-buttonStyle="Success"/>`,
    `<action content="Decline" activationType="protocol" arguments="${escapeXML(declineURL)}" hint-buttonStyle="Critical"/>`,
    '</actions>',
    '<audio silent="true"/>',
    '</toast>',
  ].join('');
}

export class CallNotifications {
  constructor({ tokens, onAnswer, onDecline, onOpenCall, onOpenHistory }) {
    this.tokens = tokens;
    this.onAnswer = onAnswer;
    this.onDecline = onDecline;
    this.onOpenCall = onOpenCall;
    this.onOpenHistory = onOpenHistory;
    this.incoming = new Map();
    this.others = new Set();
  }

  get supported() {
    return Notification.isSupported();
  }

  showIncoming(call, accountLabel) {
    if (!this.supported) return;
    this.removeIncoming(call.id);
    const title = callDisplayName(call);
    const detail = [call.remoteName ? call.remoteNumber : '', accountLabel].filter(Boolean).join(' · ');
    let notification;
    if (process.platform === 'win32') {
      notification = new Notification({
        toastXml: incomingToastXML({
          title,
          detail,
          answerURL: this.tokens.toastURL('answer', call.id),
          declineURL: this.tokens.toastURL('decline', call.id),
          openURL: this.tokens.toastURL('open', call.id),
        }),
      });
    } else {
      notification = new Notification({
        title: 'Incoming call',
        subtitle: title,
        body: detail,
        silent: true,
        actions: [{ type: 'button', text: 'Answer' }, { type: 'button', text: 'Decline' }],
      });
      notification.on('action', (_event, index) => (index === 0 ? this.onAnswer(call.id) : this.onDecline(call.id)));
    }
    notification.on('click', () => this.onOpenCall(call.id));
    notification.show();
    this.incoming.set(call.id, notification);
  }

  removeIncoming(callId) {
    const notification = this.incoming.get(callId);
    if (!notification) return;
    this.incoming.delete(callId);
    notification.close();
  }

  showMissed(record) {
    if (!this.supported) return;
    this.#show(new Notification({ title: 'Missed call', body: recordDisplayName(record) }), this.onOpenHistory);
  }

  showTest() {
    if (!this.supported) return false;
    this.#show(new Notification({
      title: 'Sipper notifications work',
      body: 'Incoming calls will show here with Answer and Decline buttons.',
    }));
    return true;
  }

  #show(notification, onClick) {
    // Keep a reference until the notification goes away, or its events never fire.
    this.others.add(notification);
    notification.on('close', () => this.others.delete(notification));
    if (onClick) notification.on('click', onClick);
    notification.show();
  }
}
