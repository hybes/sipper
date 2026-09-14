// Display formatting shared by the renderer and the main process (Sipper/Views/Shared.swift).

import { OUTCOMES, recordDuration } from './models.js';

/** "4:05" or "1:02:03". */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "45s", "3 min 20s", "1 h 5 min". */
export function spokenDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s === 0 ? `${m} min` : `${m} min ${s}s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function dayTitle(date, now = new Date()) {
  const day = startOfDay(date);
  const today = startOfDay(now);
  if (day === today) return 'Today';
  if (today - day <= 26 * 3600 * 1000 && today - day > 0) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(date);
}

export function dayKey(date) {
  return startOfDay(date);
}

export function timeOfDay(date) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date);
}

export function shortDateTime(date) {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function recordSummary(record, now = Date.now()) {
  if (!record.endedAt) return 'In progress';
  if (record.outcome === 'completed') {
    const duration = recordDuration(record, now);
    return duration > 0 ? spokenDuration(duration) : 'Completed';
  }
  if (record.outcome === 'failed') {
    return record.statusCode > 0 ? `Failed · ${record.statusCode} ${record.statusText}` : 'Failed';
  }
  return OUTCOMES[record.outcome] ?? record.outcome;
}
