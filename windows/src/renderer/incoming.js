// The incoming-call alert window: one card per ringing call. Enter answers and Escape declines
// the first call, but only once the window has focus (it appears without taking it).

import { displayLabel } from '../core/models.js';
import { callDisplayName } from '../core/sip.js';
import { Icon } from './components.js';
import { html, render, useEffect, useRef } from './lib.js';
import { accountByID, act, loadState, service, useAppState } from './store.js';

function IncomingCard({ call, account }) {
  return html`<article class="incoming-card" aria-label=${`Incoming call from ${callDisplayName(call)}`}>
    <div class="incoming-top">
      <span class="incoming-pulse" aria-hidden="true"><${Icon} name="callIncomingFilled" size=${20} /></span>
      <div class="incoming-text">
        <span class="incoming-kicker">Incoming call</span>
        <span class="incoming-name">${callDisplayName(call)}</span>
        ${call.remoteName ? html`<span class="incoming-detail">${call.remoteNumber}</span>` : null}
        ${account ? html`<span class="incoming-detail">via ${displayLabel(account)}</span>` : null}
      </div>
    </div>
    <div class="incoming-actions">
      <button type="button" class="button danger" onClick=${() => act('decline', call.id)}><${Icon} name="callEnd" /><span>Decline</span></button>
      <button type="button" class="button success" onClick=${() => act('answer', call.id)}><${Icon} name="call" /><span>Answer</span></button>
    </div>
  </article>`;
}

function IncomingWindow() {
  const state = useAppState();
  const ringing = state.calls.filter((call) => call.state === 'incoming');
  const list = useRef(null);
  const first = ringing[0]?.id;

  useEffect(() => {
    const node = list.current;
    const observer = new ResizeObserver(() => service('incomingFit', node.getBoundingClientRect().height));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (first === undefined) return undefined;
    const onKey = (event) => {
      if (event.target.closest?.('button')) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        act('answer', first);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        act('decline', first);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [first]);

  return html`<div class="incoming-list" ref=${list}>
    ${ringing.length === 0
      ? html`<div class="incoming-card"><p class="caption">No incoming calls</p></div>`
      : ringing.map((call) => html`<${IncomingCard} key=${call.id} call=${call} account=${accountByID(state, call.accountID)} />`)}
  </div>`;
}

loadState().then(() => {
  document.body.classList.add(`platform-${window.sipper.platform}`);
  render(html`<${IncomingWindow} />`, document.getElementById('root'));
});
