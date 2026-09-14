// Call history: filters, search, day groups, call back and recordings.

import { dayKey, dayTitle, recordSummary, timeOfDay } from '../../core/format.js';
import { contactMatchesNumber, displayLabel, recordDisplayName, recordWasMissed } from '../../core/models.js';
import {
  Button, confirmDialog, cx, EmptyState, Icon, IconButton, PageHeader, Segmented, Select, showMenu,
} from '../components.js';
import { html, useEffect, useMemo, useRef, useState } from '../lib.js';
import { accountLabel, act, service, useAppState } from '../store.js';
import { useUI } from '../ui.js';
import { deleteRecording, openRecording, recordIcon, recordTone } from './actions.js';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'missed', label: 'Missed' },
  { value: 'incoming', label: 'Incoming' },
  { value: 'outgoing', label: 'Outgoing' },
];
const PAGE_SIZE = 150;

export function HistoryRow({ record, selected, onSelect, onDelete }) {
  const state = useAppState();
  const ui = useUI();
  const known = state.contacts.some((contact) => contactMatchesNumber(contact, record.remoteNumber));
  const menu = () => showMenu([
    { label: 'Call back', onSelect: () => act('callBack', record.id) },
    !known && { label: 'Add to contacts…', onSelect: () => ui.openDialog({ kind: 'addContact', number: record.remoteNumber, name: record.remoteName }) },
    { label: 'Copy number', onSelect: () => service('copyText', record.remoteNumber) },
    record.recordingPath && 'separator',
    record.recordingPath && { label: 'Play recording', onSelect: () => openRecording(record) },
    record.recordingPath && { label: 'Show recording in folder', onSelect: () => service('showRecording', record.id) },
    record.recordingPath && { label: 'Delete recording…', onSelect: () => deleteRecording(record) },
    'separator',
    { label: 'Delete from history', onSelect: () => (onDelete ? onDelete() : act('deleteHistory', [record.id])) },
  ]);

  return html`<div role="listitem" tabindex="0" class=${cx('history-row', selected && 'selected', recordWasMissed(record) && 'missed')}
    aria-label=${`${recordDisplayName(record)}, ${recordSummary(record)}, ${timeOfDay(new Date(record.startedAt))}`}
    onClick=${(event) => onSelect?.(event)}
    onDblClick=${() => act('callBack', record.id)}
    onKeyDown=${(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter') act('callBack', record.id);
      if (event.key === ' ') {
        event.preventDefault();
        onSelect?.(event);
      }
    }}
    onContextMenu=${(event) => {
      event.preventDefault();
      onSelect?.(event, true);
      menu();
    }}>
    <${Icon} name=${recordIcon(record)} className=${cx('history-icon', recordTone(record))} />
    <div class="history-text">
      <span class="history-name">${recordDisplayName(record)}</span>
      <span class="caption ellipsis">${recordSummary(record)} · ${accountLabel(state, record.accountID)}</span>
    </div>
    <div class="history-trailing">
      ${record.recordingPath ? html`<${IconButton} icon="waveform" label="Play recording" onClick=${(event) => {
        event.stopPropagation();
        openRecording(record);
      }} />` : null}
      <span class="caption tabular history-time">${timeOfDay(new Date(record.startedAt))}</span>
      <${IconButton} icon="callRegular" label=${`Call ${record.remoteNumber} back`} onClick=${(event) => {
        event.stopPropagation();
        act('callBack', record.id);
      }} />
    </div>
  </div>`;
}

export function HistoryPage() {
  const state = useAppState();
  const [filter, setFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const sentinel = useRef(null);

  useEffect(() => {
    if (state.unseenMissedCalls > 0) act('markMissedCallsSeen');
  }, [state.unseenMissedCalls]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return state.history.filter((record) => {
      if (filter === 'missed' && !recordWasMissed(record)) return false;
      if ((filter === 'incoming' || filter === 'outgoing') && record.direction !== filter) return false;
      if (accountFilter && record.accountID !== accountFilter) return false;
      if (needle && !`${record.remoteName} ${record.remoteNumber} ${record.remoteURI}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [state.history, filter, accountFilter, search]);

  useEffect(() => setLimit(PAGE_SIZE), [filter, accountFilter, search]);

  const hasMore = filtered.length > limit;
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLimit((current) => current + PAGE_SIZE);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, limit]);

  const groups = [];
  for (const record of filtered.slice(0, limit)) {
    const date = new Date(record.startedAt);
    const key = dayKey(date);
    if (groups.at(-1)?.key !== key) groups.push({ key, title: dayTitle(date), records: [] });
    groups.at(-1).records.push(record);
  }

  const select = (record, event, fromMenu) => setSelected((current) => {
    if (fromMenu) return current.has(record.id) ? current : new Set([record.id]);
    if (event?.ctrlKey || event?.metaKey) {
      const next = new Set(current);
      if (next.has(record.id)) next.delete(record.id);
      else next.add(record.id);
      return next;
    }
    return new Set([record.id]);
  });

  const deleteSelection = (fallbackID) => {
    const ids = selected.size > 0 ? [...selected] : [fallbackID];
    act('deleteHistory', ids);
    setSelected(new Set());
  };

  const clearAll = async () => {
    const response = await confirmDialog({
      type: 'warning',
      message: 'Clear all call history?',
      detail: 'Recording files stay in the recordings folder.',
      buttons: ['Clear history', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) act('clearHistory');
  };

  const accountOptions = [{ value: null, label: 'All accounts' }, ...state.accounts.map((a) => ({ value: a.id, label: displayLabel(a) }))];

  let body;
  if (state.history.length === 0) {
    body = html`<${EmptyState} icon="history" title="No calls yet" description="Calls you make and receive appear here." />`;
  } else if (filtered.length === 0) {
    body = search.trim()
      ? html`<${EmptyState} icon="search" title=${`No results for “${search.trim()}”`} description="Check the spelling or try part of the number." />`
      : html`<${EmptyState} icon="history" title="No calls match these filters" />`;
  } else {
    body = html`<div class="history-list" role="list" aria-label="Calls"
      onKeyDown=${(event) => {
        if (event.key === 'Delete' && selected.size > 0) {
          event.preventDefault();
          deleteSelection();
        }
      }}>
      ${groups.map((group) => html`<section key=${group.key} class="day-group" aria-label=${group.title}>
        <h2 class="day-title">${group.title}</h2>
        ${group.records.map((record) => html`<${HistoryRow} key=${record.id} record=${record} selected=${selected.has(record.id)}
          onSelect=${(event, fromMenu) => select(record, event, fromMenu)}
          onDelete=${() => deleteSelection(record.id)} />`)}
      </section>`)}
      ${hasMore ? html`<div ref=${sentinel} class="load-more caption">Loading more calls…</div>` : null}
    </div>`;
  }

  return html`<div class="page">
    <${PageHeader} title="History">
      <${Button} kind="subtle" icon="delete" disabled=${state.history.length === 0} onClick=${clearAll}>Clear history</${Button}>
    </${PageHeader}>
    <div class="toolbar">
      <div class="search-field">
        <${Icon} name="search" />
        <input type="search" class="text-field" placeholder="Name or number" aria-label="Search history" spellcheck=${false}
          value=${search} onInput=${(event) => setSearch(event.currentTarget.value)} />
      </div>
      <${Segmented} label="Direction" value=${filter} options=${FILTERS} onChange=${setFilter} />
      <${Select} label="Account" value=${accountFilter} options=${accountOptions} onChange=${setAccountFilter} />
    </div>
    <div class="page-body scroll history-body">${body}</div>
  </div>`;
}
