import { Button, Checkbox, cleanError, cx, Dialog, EmptyState, Field, InfoBar, PageHeader, Select, TextField } from '../components.js';
import { html, useEffect, useLayoutEffect, useRef, useState } from '../lib.js';
import { service, useAppState } from '../store.js';
import { useUI } from '../ui.js';

async function request(name, ...args) {
  const result = await service(name, ...args);
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
}
const accessLost = error => ['access_denied', 'sign_in_required', 'cancelled'].includes(error.code);
const definiteFailure = error => accessLost(error) || ['invalid_message_input', 'messages_changed', 'message_rate_limit'].includes(error.code);
const date = value => new Date(value).toLocaleString();

// Three independent in-memory pages: conversation metadata, history and colleague search.
function useMessagePage(load, keys) {
  const [page, setPage] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null), [denied, setDenied] = useState(false);
  const lifecycle = useRef(0), pending = useRef(null), loader = useRef(load);
  loader.current = load;
  const refresh = async () => {
    const generation = lifecycle.current;
    if (document.hidden || pending.current === generation) return;
    pending.current = generation; setBusy(true);
    try {
      const value = await loader.current();
      if (generation === lifecycle.current && !document.hidden) { setPage(value); setError(null); setDenied(false); }
      return value;
    } catch (problem) {
      if (generation === lifecycle.current) {
        setError(cleanError(problem));
        if (accessLost(problem)) { setPage(null); setDenied(true); }
      }
    } finally { if (generation === lifecycle.current) { pending.current = null; setBusy(false); } }
  };
  useEffect(() => {
    lifecycle.current++; pending.current = null; setPage(null); setError(null); setDenied(false);
    refresh();
    const poll = setInterval(refresh, 5000);
    const expiry = setInterval(() => setPage(current => current && Date.parse(current.expiresAt) <= Date.now() ? null : current), 1000);
    return () => { lifecycle.current++; clearInterval(poll); clearInterval(expiry); };
  }, keys);
  return { page, busy, error, denied, refresh };
}

export function MessagesPage() {
  const managed = useAppState().managed, ui = useUI();
  const [device, setDevice] = useState(null), [visible, setVisible] = useState(!document.hidden), [locked, setLocked] = useState(false);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const entries = managed?.signedIn ? managed.enrollments.filter(e => managed.organisations.some(o => o.id === e.organisationId && o.status === 'active' && o.licensed)) : [];
  const entry = entries.find(e => e.deviceId === device) ?? entries[0];
  const notification = ui.selection.notification;
  useEffect(() => {
    if (notification && entries.some(e => e.deviceId === notification.deviceId) && !locked) setDevice(notification.deviceId);
  }, [notification, locked]);
  return html`<div class="page messages-page">
    <${PageHeader} title="Messages" />
    ${!entry ? html`<div class="page-body"><${EmptyState} title="Managed messages"
      description="Sign in and connect a licensed customer to message their people.">
      <${Button} onClick=${() => ui.navigate({ kind: 'settings', tab: 'managed' })}>Managed accounts</${Button}>
    </${EmptyState}></div>` : html`
      <div class="directory-toolbar"><${Select} label="Customer" value=${entry.deviceId} disabled=${locked} onChange=${setDevice}
        options=${entries.map(e => ({ value: e.deviceId, label: managed.organisations.find(o => o.id === e.organisationId)?.name ?? 'Managed customer' }))} /></div>
      ${notification && locked && entries.some(e => e.deviceId === notification.deviceId) ? html`<p class="directory-notice caption" role="status">New message ready. Send or clear your draft, or close the open dialogue, to view it.</p>` : null}
      ${visible ? html`<${CustomerMessages} key=${`${managed.identity.id}:${entry.deviceId}`} deviceId=${entry.deviceId} onLock=${setLocked}
        notification=${notification?.deviceId === entry.deviceId ? notification : null}
        consumeNotification=${() => ui.navigate(current => current.notification === notification ? { kind: 'messages' } : current)} />` : null}`}
  </div>`;
}

function CustomerMessages({ deviceId, onLock, notification, consumeNotification }) {
  const [cursor, setCursor] = useState(null), [selected, setSelected] = useState(null), [creating, setCreating] = useState(false), [locked, lock] = useState(false);
  const list = useMessagePage(() => request('managedConversations', deviceId, { after: cursor }), [deviceId, cursor]);
  const setLock = lock;
  useLayoutEffect(() => { onLock(locked || creating); }, [locked, creating]);
  useLayoutEffect(() => () => onLock(false), []);
  useEffect(() => {
    if (notification && !locked && !creating) { setCursor(null); setSelected(notification.conversationId); consumeNotification(); }
  }, [notification, locked, creating]);
  useEffect(() => { if (list.denied) { setSelected(null); setCreating(false); setLock(false); } }, [list.denied]);
  const created = id => { setCreating(false); setCursor(null); setSelected(id); list.refresh(); };
  return html`<div class="messages-workspace">
    <div class="messages-actions"><${Button} disabled=${locked || list.denied} onClick=${() => setCreating(true)}>New conversation</${Button}>
      <${Button} disabled=${list.busy} onClick=${list.refresh}>${list.busy ? 'Refreshing…' : 'Refresh'}</${Button}>
    </div>
    ${list.error ? html`<div class="directory-notice"><${InfoBar} severity="error" title="Messages unavailable">${list.error}</${InfoBar}></div>` : null}
    <div class="split messages-split">
      <div class="split-list" aria-label="Conversations">
        ${cursor ? html`<${Button} disabled=${locked} onClick=${() => setCursor(null)}>Latest conversations</${Button}>` : null}
        ${list.page?.conversations.map(conversation => html`<button type="button" key=${conversation.id} class=${cx('contact-row', selected === conversation.id && 'selected')}
          disabled=${locked} aria-current=${selected === conversation.id ? 'true' : undefined} onClick=${() => setSelected(conversation.id)}>
          <span class="contact-row-text"><span class="ellipsis">${conversation.title}</span><span class="caption">${date(conversation.updatedAt)}</span></span>
          ${conversation.unread ? html`<span class="nav-badge" aria-label=${`${conversation.unread} unread messages`}>${conversation.unread}</span>` : null}
        </button>`)}
        ${!list.page?.conversations.length ? html`<p class="caption list-empty" role="status">${list.busy ? 'Loading conversations…' : !list.page ? 'Refresh to load conversations.' : 'No conversations yet.'}</p>` : null}
        ${list.page?.nextCursor ? html`<${Button} disabled=${locked} onClick=${() => setCursor(list.page.nextCursor)}>More conversations</${Button}>` : null}
      </div>
      <div class="split-detail messages-detail">
        ${selected && !list.denied ? html`<${ConversationPane} key=${selected} deviceId=${deviceId} id=${selected} onRead=${list.refresh} onLock=${setLock} onLeft=${() => { setSelected(null); list.refresh(); }} />`
          : html`<p class="secondary">Select a conversation or start a new one.</p>`}
      </div>
    </div>
    ${creating && !list.denied ? html`<${NewConversation} deviceId=${deviceId} onCreated=${created} onClose=${() => setCreating(false)} />` : null}
  </div>`;
}

function ConversationPane({ deviceId, id, onRead, onLock, onLeft }) {
  const [before, setBefore] = useState(null), [draft, setDraft] = useState(''), [pending, setPending] = useState(null), [sending, setSending] = useState(false), [sendError, setSendError] = useState(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const history = useMessagePage(() => request('managedConversationMessages', deviceId, id, { before }), [deviceId, id, before]);
  const alive = useRef(true), read = useRef('0'), reading = useRef(false), writing = useRef(false), historyElement = useRef(null);
  useLayoutEffect(() => () => { alive.current = false; onLock(false); }, []);
  useLayoutEffect(() => { onLock(Boolean(sending || pending || groupOpen || draft)); }, [sending, pending, groupOpen, draft]);
  useEffect(() => { if (history.denied) { setDraft(''); setPending(null); setSendError(null); setGroupOpen(false); } }, [history.denied]);
  const page = history.page, sequence = page?.messages.at(-1)?.sequence;
  useEffect(() => {
    if (historyElement.current) historyElement.current.scrollTop = before ? 0 : historyElement.current.scrollHeight;
  }, [page?.messages.at(-1)?.id, before]);
  useEffect(() => {
    if (!sequence || reading.current || BigInt(sequence) <= BigInt(read.current) || document.hidden) return;
    reading.current = true;
    request('managedMarkConversationRead', deviceId, id, sequence).then(() => {
      if (alive.current && !document.hidden) { read.current = sequence; onRead(); }
    }).catch(() => {}).finally(() => { reading.current = false; });
  }, [sequence, page?.expiresAt]);
  const send = async () => {
    if (writing.current || !page || Date.parse(page.expiresAt) <= Date.now()) return;
    writing.current = true;
    const input = pending ?? { id: crypto.randomUUID(), text: draft };
    setPending(input); setSending(true); setSendError(null);
    try {
      await request('managedSendMessage', deviceId, id, input);
      if (alive.current && !document.hidden) { setPending(null); setDraft(''); setBefore(null); history.refresh(); onRead(); }
    } catch (problem) {
      if (alive.current && !document.hidden) {
        setSendError(cleanError(problem));
        if (definiteFailure(problem)) setPending(null);
      }
    } finally { writing.current = false; if (alive.current) setSending(false); }
  };
  return html`<div class="message-conversation">
    ${page ? html`<div><h2 class="detail-title">${page.conversation.title}</h2><p class="caption message-roster">${page.conversation.participants.map(p => p.name).join(', ')}</p></div>` : null}
    ${history.error ? html`<${InfoBar} severity="error" title="History unavailable">${history.error}</${InfoBar}>` : null}
    <div class="messages-actions">
      ${!history.denied ? html`<${MeetingLaunch} deviceId=${deviceId} conversationId=${id} enabled=${Boolean(page && Date.parse(page.expiresAt) > Date.now())} />` : null}
      ${page?.conversation.kind === 'group' && page.conversation.revision ? html`<${Button} disabled=${sending || Boolean(pending)} onClick=${() => setGroupOpen({ conversation: page.conversation, userId: page.userId })}>Group settings</${Button}>` : null}
      ${before ? html`<${Button} disabled=${sending} onClick=${() => setBefore(null)}>Latest messages</${Button}>` : null}
      <${Button} disabled=${!page?.nextCursor || sending} onClick=${() => setBefore(page.nextCursor)}>Older messages</${Button}>
      <${Button} disabled=${history.busy} onClick=${history.refresh}>Refresh history</${Button}>
    </div>
    <div class="message-history" aria-label="Message history" ref=${historyElement}>
      ${page?.messages.map(message => html`<article key=${message.id} class="text-message"><div class="caption">${message.senderId === page.userId ? 'You' : message.senderName} · ${date(message.createdAt)}</div>
        <p class="selectable message-body">${message.text}</p></article>`)}
      ${!page?.messages.length ? html`<p class="caption" role="status">${history.busy ? 'Loading messages…' : !page ? 'Refresh history to load current messages.' : 'No messages yet.'}</p>` : null}
    </div>
    <div class="message-composer">
      <${Field} label="Message"><${TextField} label="Message text" multiline rows=${2} value=${draft} maxLength=${4096}
        disabled=${sending || Boolean(pending) || history.denied} onValue=${setDraft} placeholder="Write a message…" /></${Field}>
      <p class="caption">${draft.length}/4096${page ? ` · Messages kept for ${page.retentionDays} days` : ''}</p>
      ${sendError ? html`<${InfoBar} severity="error" title="Message not confirmed">${sendError}</${InfoBar}>` : null}
      ${pending && !sending ? html`<p class="caption">This message may have been sent. Retry keeps the same message ID.</p>` : null}
      <div class="messages-actions">
        <${Button} kind="accent" disabled=${sending || !page || (!pending && !draft.trim())} onClick=${send}>${sending ? 'Sending…' : pending ? 'Retry message' : 'Send message'}</${Button}>
        ${pending && !sending ? html`<${Button} onClick=${() => { setPending(null); setDraft(''); setSendError(null); }}>Discard message</${Button}>` : null}
      </div>
    </div>
    ${groupOpen ? html`<${NewConversation} deviceId=${deviceId} group=${groupOpen.conversation} userId=${groupOpen.userId}
      onCreated=${() => { setGroupOpen(false); history.refresh(); onRead(); }} onLeft=${onLeft}
      onClose=${() => { setGroupOpen(false); history.refresh(); }} />` : null}
  </div>`;
}

function MeetingLaunch({ deviceId, conversationId, enabled }) {
  const state = useAppState();
  const current = useMessagePage(() => request('managedCurrentMeeting', deviceId, conversationId), [deviceId, conversationId]);
  const nonce = useRef(''), working = useRef(false), alive = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [retry, setRetry] = useState(false);
  useEffect(() => () => { alive.current = false; }, []);
  const launch = async () => {
    if (!enabled || working.current || !current.page?.available) return;
    working.current = true; setBusy(true); setError(null);
    try {
      let value = current.page;
      if (!value.meeting) {
        nonce.current ||= crypto.randomUUID();
        value = await request('managedStartMeeting', deviceId, conversationId, nonce.current);
        nonce.current = ''; if (alive.current) setRetry(false);
      }
      if (!alive.current) return;
      if (!value.available || value.meeting.endedAt || Date.parse(value.meeting.expiresAt) <= Date.now()) throw Error('This meeting is closed. Refresh before starting another.');
      await request('managedOpenMeeting', deviceId, value.meeting.id);
      if (alive.current) await current.refresh();
    } catch (problem) {
      if (alive.current) {
        setError(cleanError(problem));
        if (accessLost(problem) || ['invalid_meeting_input', 'meeting_changed', 'meeting_rate_limit'].includes(problem.code)) nonce.current = '';
        setRetry(Boolean(nonce.current));
      }
    } finally { working.current = false; if (alive.current) setBusy(false); }
  };
  return html`<div class="message-meeting-launch"><${Button} disabled=${busy || state.changingAudio || !enabled || !current.page?.available || current.denied} onClick=${launch}>
    ${busy ? 'Opening meeting…' : current.page?.meeting ? 'Join meeting' : retry ? 'Retry starting meeting' : 'Start meeting'}
  </${Button}>${error || current.error ? html`<span class="caption" role="status">${error ?? current.error}</span>` : current.page && !current.page.available ? html`<span class="caption">Meetings are not available yet.</span>`
    : state.calls.some(call => call.state === 'confirmed' && !call.isOnHold) ? html`<span class="caption">Your phone calls will stay on hold while the meeting is open.</span>` : null}</div>`;
}

function NewConversation({ deviceId, onCreated, onClose, group = null, userId, onLeft }) {
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [cursor, setCursor] = useState(null), [chosen, setChosen] = useState(group?.participants.filter(p => p.id !== userId) ?? []), [title, setTitle] = useState(group?.title ?? '');
  const [working, setWorking] = useState(false), [pending, setPending] = useState(null), [error, setError] = useState(null);
  const [owner, setOwner] = useState(group?.ownerId ?? ''), [leaveConfirm, setLeaveConfirm] = useState(false);
  const canEdit = !group || group.ownerId === userId;
  const people = useMessagePage(() => request('managedMessagePeople', deviceId, { search: query, after: cursor }), [deviceId, query, cursor]);
  const alive = useRef(true), writing = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);
  const create = async (leave = false) => {
    if (writing.current || (!leave && (!people.page || !canEdit))) return;
    writing.current = true;
    const input = pending ?? (leave ? { leave: true } : group ? { revision: group.revision, title: title.trim(), userIds: [userId, ...chosen.map(p => p.id)], ownerId: owner } : { id: crypto.randomUUID(), userIds: chosen.map(p => p.id), title: chosen.length > 1 ? title.trim() : '' });
    setPending(input); setWorking(true); setError(null);
    try {
      const result = input.leave ? await request('managedLeaveMessageGroup', deviceId, group.id) : group ? await request('managedUpdateMessageGroup', deviceId, group.id, input) : await request('managedCreateConversation', deviceId, input);
      if (alive.current && !document.hidden) { if (input.leave) onLeft(); else onCreated(result.conversation.id); }
    } catch (problem) {
      if (alive.current) { setError(cleanError(problem)); if (definiteFailure(problem)) setPending(null); if (accessLost(problem)) { if (group) onLeft(); else onClose(); } }
    } finally { writing.current = false; if (alive.current) setWorking(false); }
  };
  return html`<${Dialog} title=${leaveConfirm ? 'Leave group?' : group ? 'Group settings' : 'New conversation'} onClose=${() => { if (!working) onClose(); }} footer=${html`
    <${Button} disabled=${working} onClick=${onClose}>Cancel</${Button}>
    ${pending && !working ? html`<${Button} onClick=${() => { setPending(null); setError(null); }}>Discard retry</${Button}>` : null}
    ${leaveConfirm ? html`<${Button} disabled=${working} onClick=${() => create(true)}>${working ? 'Leaving…' : 'Leave group'}</${Button}>`
      : canEdit ? html`<${Button} kind="accent" disabled=${working || !people.page || people.denied || (!group && !chosen.length) || ((group || chosen.length > 1) && !title.trim())} onClick=${() => create()}>${working ? 'Saving…' : pending ? 'Retry request' : group ? 'Save group' : 'Start conversation'}</${Button}>` : null}`}>
    ${leaveConfirm ? html`<p>You will lose access to this group's messages. If you own it, ownership passes to a remaining member.</p>
      ${error ? html`<${InfoBar} severity="error" title="Leaving not confirmed">${error}</${InfoBar}>` : null}` : html`
    ${canEdit ? html`<form class="messages-actions" onSubmit=${event => { event.preventDefault(); setCursor(null); setQuery(search.trim()); people.refresh(); }}>
      <${TextField} label="Search colleagues" value=${search} onValue=${setSearch} maxLength=${160} disabled=${working || Boolean(pending)} placeholder="Find a person…" />
      <${Button} type="submit" disabled=${working || Boolean(pending)}>Search</${Button}>
    </form>` : null}
    ${chosen.length ? html`<p class="caption">${chosen.map(p => p.name).join(', ')} · ${chosen.length}/19 selected</p>` : null}
    ${(group || chosen.length > 1) && canEdit ? html`<${Field} label="Group name"><${TextField} label="Group name" value=${title} onValue=${setTitle} maxLength=${160} disabled=${working || Boolean(pending)} /></${Field}>` : null}
    ${people.error || error ? html`<${InfoBar} severity="error" title="Conversation unavailable">${error ?? people.error}</${InfoBar}>` : null}
    ${pending && !working ? html`<p class="caption">The request may have completed. Retry keeps the same request.</p>` : null}
    ${group ? html`<p class="caption">New members see messages sent after they join.</p>
      ${canEdit ? html`<${Field} label="Group owner"><${Select} label="Group owner" value=${owner} disabled=${working || Boolean(pending)} onChange=${setOwner}
        options=${[{ value: userId, label: 'You' }, ...chosen.map(p => ({ value: p.id, label: p.name }))]} /></${Field}>
        ${chosen.map(person => html`<div key=${person.id} class="messages-actions"><span>${person.name}</span><${Button} disabled=${working || Boolean(pending)} onClick=${() => { setChosen(current => current.filter(p => p.id !== person.id)); if (owner === person.id) setOwner(userId); }}>Remove</${Button}></div>`)} ` : html`<p class="caption">Only the group owner can change its name or people.</p>`}` : null}
    ${canEdit ? html`<div class="message-people" aria-label="Colleagues">
      ${people.page?.people.map(person => html`<div key=${person.id}><${Checkbox} label=${person.name} checked=${chosen.some(p => p.id === person.id)}
        disabled=${working || Boolean(pending) || (chosen.length >= 19 && !chosen.some(p => p.id === person.id))}
        onChange=${checked => { setChosen(current => checked ? [...current, person] : current.filter(p => p.id !== person.id)); if (!checked && owner === person.id) setOwner(userId); }} /></div>`)}
      ${!people.page?.people.length ? html`<p class="caption" role="status">${people.busy ? 'Loading people…' : !people.page ? 'Refresh to load people.' : 'No people match your search.'}</p>` : null}
    </div>
    <div class="messages-actions"><${Button} disabled=${working || Boolean(pending) || people.busy} onClick=${people.refresh}>Refresh people</${Button}>
      ${cursor ? html`<${Button} disabled=${working || Boolean(pending)} onClick=${() => setCursor(null)}>First page</${Button}>` : null}
      ${people.page?.nextCursor ? html`<${Button} disabled=${working || Boolean(pending)} onClick=${() => setCursor(people.page.nextCursor)}>More people</${Button}>` : null}
    </div>` : null}
    ${group && error && !pending ? html`<${Button} disabled=${working} onClick=${onClose}>Reload group</${Button}>` : null}
    ${group ? html`<${Button} disabled=${working || Boolean(pending)} onClick=${() => { setLeaveConfirm(true); setError(null); }}>Leave group</${Button}>` : null}
    `}
  </${Dialog}>`;
}
