// Shared controls in the Windows 11 idiom: buttons, fields, switches, dialogs, status dots, the
// keypad and call controls. Menus and confirmations are native, through the main process.

import { formatDuration } from '../core/format.js';
import { contactInitials } from '../core/models.js';
import { nextRefresh, registrationDetail } from '../core/sip.js';
import { ICONS } from './icons.js';
import { html, useEffect, useRef, useState } from './lib.js';
import { service } from './store.js';

export const cx = (...parts) => parts.filter(Boolean).join(' ');

/** Errors from IPC arrive wrapped in "Error invoking remote method …"; keep the useful part. */
export const cleanError = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

export function Icon({ name, size = 16, className }) {
  const icon = ICONS[name] ?? ICONS.info;
  return html`<svg class=${cx('icon', className)} width=${size} height=${size} viewBox=${icon.viewBox} aria-hidden="true" focusable="false">
    ${icon.paths.map((d) => html`<path d=${d} />`)}
  </svg>`;
}

export function Button({ kind = 'standard', size, icon, block, className, children, ...rest }) {
  return html`<button type="button" class=${cx('button', kind !== 'standard' && kind, size, block && 'block', className)} ...${rest}>
    ${icon ? html`<${Icon} name=${icon} />` : null}
    ${children !== undefined && children !== null ? html`<span>${children}</span>` : null}
  </button>`;
}

export function IconButton({ icon, label, kind = 'subtle', active, size = 16, className, ...rest }) {
  return html`<button type="button" class=${cx('icon-button', kind, active && 'active', className)} aria-label=${label} title=${label}
    aria-pressed=${active === undefined ? undefined : String(Boolean(active))} ...${rest}>
    <${Icon} name=${icon} size=${size} />
  </button>`;
}

export function TextField({ value, onValue, label, invalid, inputRef, className, multiline, rows = 3, ...rest }) {
  const props = {
    class: cx('text-field', invalid && 'invalid', className),
    value: value ?? '',
    'aria-label': label,
    'aria-invalid': invalid ? 'true' : undefined,
    spellcheck: false,
    ref: inputRef,
    onInput: (event) => onValue?.(event.currentTarget.value),
    ...rest,
  };
  return multiline ? html`<textarea rows=${rows} ...${props}></textarea>` : html`<input type="text" ...${props} />`;
}

/**
 * A labelled input or select. The label wraps the control, so clicking it focuses the control; the
 * hint sits outside the label so it is not read as part of the field's name.
 */
export function Field({ label, hint, children, className }) {
  return html`<div class=${cx('field', className)}>
    <label class="field-control">
      <span class="field-label">${label}</span>
      ${children}
    </label>
    ${hint ? html`<span class="field-hint">${hint}</span>` : null}
  </div>`;
}

const encodeOption = (value) => (value === null || value === undefined ? '' : String(value));

export function Select({ value, onChange, options = [], groups, label, className, ...rest }) {
  const all = groups ? groups.flatMap((group) => group.options) : options;
  const option = (item) => html`<option value=${encodeOption(item.value)} disabled=${item.disabled}>${item.label}</option>`;
  return html`<select class=${cx('select', className)} value=${encodeOption(value)} aria-label=${label}
    onChange=${(event) => {
      const raw = event.currentTarget.value;
      const match = all.find((item) => encodeOption(item.value) === raw);
      onChange(match ? match.value : raw);
    }} ...${rest}>
    ${groups ? groups.map((group) => html`<optgroup label=${group.label}>${group.options.map(option)}</optgroup>`) : options.map(option)}
  </select>`;
}

export function Toggle({ checked, onChange, label, disabled, ...rest }) {
  return html`<label class=${cx('toggle', disabled && 'disabled')}>
    <input type="checkbox" role="switch" checked=${Boolean(checked)} disabled=${disabled}
      onChange=${(event) => onChange(event.currentTarget.checked)} aria-label=${typeof label === 'string' ? undefined : rest['aria-label']} />
    <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
    ${label ? html`<span class="toggle-label">${label}</span>` : null}
  </label>`;
}

export function Checkbox({ checked, onChange, label, disabled, ...rest }) {
  return html`<label class=${cx('checkbox', disabled && 'disabled')}>
    <input type="checkbox" checked=${Boolean(checked)} disabled=${disabled} onChange=${(event) => onChange(event.currentTarget.checked)} ...${rest} />
    <span class="checkbox-box" aria-hidden="true"><${Icon} name="checkmark" size=${12} /></span>
    ${label ? html`<span>${label}</span>` : null}
  </label>`;
}

/** A settings row: text on the left, a switch on the right; the whole row toggles. */
export function SwitchRow({ label, description, checked, onChange, disabled }) {
  return html`<label class=${cx('setting-row', 'switch-row', disabled && 'disabled')}>
    <span class="setting-text">
      <span class="setting-label">${label}</span>
      ${description ? html`<span class="setting-description">${description}</span>` : null}
    </span>
    <span class="setting-control toggle">
      <span class="switch-state" aria-hidden="true">${checked ? 'On' : 'Off'}</span>
      <input type="checkbox" role="switch" checked=${Boolean(checked)} disabled=${disabled} onChange=${(event) => onChange(event.currentTarget.checked)} />
      <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
    </span>
  </label>`;
}

export function SettingRow({ label, description, children, className }) {
  return html`<div class=${cx('setting-row', className)}>
    <div class="setting-text">
      <span class="setting-label">${label}</span>
      ${description ? html`<span class="setting-description">${description}</span>` : null}
    </div>
    <div class="setting-control">${children}</div>
  </div>`;
}

export function Segmented({ value, options, onChange, label }) {
  const move = (event, index) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    event.currentTarget.parentElement.children[options.indexOf(next)]?.focus();
  };
  return html`<div class="segmented" role="radiogroup" aria-label=${label}>
    ${options.map((option, index) => html`<button type="button" role="radio" aria-checked=${String(option.value === value)}
      tabindex=${option.value === value ? 0 : -1}
      class=${cx('segmented-item', option.value === value && 'selected')}
      onClick=${() => onChange(option.value)} onKeyDown=${(event) => move(event, index)}>${option.label}</button>`)}
  </div>`;
}

/** Coloured registration dot. Every use sits next to the state in words, so it is hidden from screen readers. */
export function StatusDot({ registration, size = 8 }) {
  const state = registration?.state ?? 'unregistered';
  return html`<span class=${cx('status-dot', `status-${state}`)} style=${{ width: `${size}px`, height: `${size}px` }}
    aria-hidden="true" title=${registrationDetail(registration)}></span>`;
}

export function useNow(interval = 1000, enabled = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval, enabled]);
  return now;
}

/** "Calling…", "Ringing…", a running talk timer or the hold state. */
export function CallStatusText({ call }) {
  const ticking = call.state === 'confirmed' && !call.isOnHold && !call.isRemoteHold;
  const now = useNow(1000, ticking);
  switch (call.state) {
    case 'calling': return 'Calling…';
    case 'incoming': return 'Incoming call';
    case 'early': return 'Ringing…';
    case 'connecting': return 'Connecting…';
    case 'confirmed':
      if (call.isOnHold) return 'On hold';
      if (call.isRemoteHold) return 'Held by the other party';
      return html`<span class="tabular">${formatDuration((now - (call.connectedAt ?? now)) / 1000)}</span>`;
    default: return 'Ended';
  }
}

/** Registration detail with a live countdown to the next re-REGISTER. */
export function RegistrationDetail({ registration }) {
  const refresh = nextRefresh(registration);
  const now = useNow(1000, refresh !== null);
  if (refresh === null) return registrationDetail(registration);
  const remaining = (refresh - now) / 1000;
  return remaining > 0
    ? html`<span class="tabular">Registered · re-registers in ${formatDuration(remaining)}</span>`
    : 'Registered · re-registering…';
}

export function EmptyState({ icon, title, description, children }) {
  return html`<div class="empty-state">
    ${icon ? html`<${Icon} name=${icon} size=${40} className="empty-icon" />` : null}
    <h2 class="empty-title">${title}</h2>
    ${description ? html`<p class="empty-description">${description}</p>` : null}
    ${children ? html`<div class="empty-actions">${children}</div>` : null}
  </div>`;
}

export function PageHeader({ title, children }) {
  return html`<header class="page-header">
    <h1 class="page-title">${title}</h1>
    <div class="page-actions">${children}</div>
  </header>`;
}

export function InfoBar({ severity = 'info', title, children, action }) {
  const icon = { info: 'info', warning: 'warning', error: 'error', success: 'checkmarkCircle' }[severity];
  return html`<div class=${cx('infobar', severity)} role=${severity === 'error' ? 'alert' : 'status'}>
    <${Icon} name=${icon} className="infobar-icon" />
    <div class="infobar-text">${title ? html`<strong>${title}</strong> ` : null}${children}</div>
    ${action ?? null}
  </div>`;
}

export function Avatar({ contact, size = 40 }) {
  return html`<span class="avatar" aria-hidden="true" style=${{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` }}>
    ${contactInitials(contact) || '?'}
  </span>`;
}

/** A modal dialog in the style of a Windows content dialog. Escape closes it; focus stays inside. */
export function Dialog({ title, children, footer, onClose, width = 520, className }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    const previous = document.activeElement;
    const focusable = () => [...node.querySelectorAll('input, select, textarea, button, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.disabled && element.offsetParent !== null);
    (node.querySelector('[data-autofocus]') ?? focusable()[0])?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
      } else if (event.key === 'Tab') {
        const items = focusable();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  return html`<div class="dialog-backdrop">
    <div class=${cx('dialog', className)} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}
      style=${{ width: `min(${width}px, calc(100vw - 48px))` }}>
      <h2 class="dialog-title">${title}</h2>
      <div class="dialog-body">${children}</div>
      ${footer ? html`<div class="dialog-footer">${footer}</div>` : null}
    </div>
  </div>`;
}

const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', ''],
];

export function Keypad({ onKey, onLongPressZero, compact }) {
  const timer = useRef(null);
  const longPressed = useRef(false);
  const press = (digit) => {
    longPressed.current = false;
    if (digit === '0' && onLongPressZero) {
      timer.current = setTimeout(() => {
        longPressed.current = true;
        onLongPressZero();
      }, 500);
    }
  };
  const release = () => clearTimeout(timer.current);
  return html`<div class=${cx('keypad', compact && 'compact')} role="group" aria-label="Keypad">
    ${KEYS.map(([digit, letters]) => html`<button type="button" class="keypad-key"
      aria-label=${digit === '0' && onLongPressZero ? '0, hold for plus' : digit}
      onPointerDown=${() => press(digit)} onPointerUp=${release} onPointerLeave=${release}
      onClick=${() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onKey(digit);
      }}>
      <span class="keypad-digit">${digit}</span>
      <span class="keypad-letters">${letters}</span>
    </button>`)}
  </div>`;
}

export function CallControl({ icon, label, shortcut, active, tone, disabled, onClick }) {
  return html`<button type="button" class=${cx('call-control', active && 'active', tone)} disabled=${disabled}
    aria-pressed=${active === undefined ? undefined : String(Boolean(active))} title=${shortcut ? `${label} (${shortcut})` : label} onClick=${onClick}>
    <span class="call-control-circle"><${Icon} name=${icon} size=${20} /></span>
    <span class="call-control-label">${label}</span>
  </button>`;
}

/**
 * Shows a native context menu. Items are { label, onSelect, enabled, checked, submenu } or
 * 'separator'; falsy entries are skipped.
 */
export async function showMenu(items) {
  const handlers = new Map();
  let next = 1;
  const describe = (list) => list.filter(Boolean).map((item) => {
    if (item === 'separator') return { type: 'separator' };
    const id = next++;
    if (item.onSelect) handlers.set(id, item.onSelect);
    return { id, label: item.label, enabled: item.enabled, checked: item.checked, submenu: item.submenu ? describe(item.submenu) : undefined };
  });
  const chosen = await service('contextMenu', describe(items));
  handlers.get(chosen)?.();
}

/** Native message box; resolves with the index of the button pressed. */
export const confirmDialog = (options) => service('confirm', options);
