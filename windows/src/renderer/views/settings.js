// Settings: general, audio, network, codecs, browser extension, recording, diagnostics, about.

import { PINNED_EXTENSION_ID } from '../../core/extension.js';
import { codecDisplayName, ECHO_MODES, RINGTONES, TRANSPORTS, transportName } from '../../core/models.js';
import { isRegistered } from '../../core/sip.js';
import {
  Button, Checkbox, cleanError, cx, EmptyState, IconButton, InfoBar, PageHeader, Select, SettingRow, SwitchRow, TextField,
} from '../components.js';
import { html, useEffect, useRef, useState } from '../lib.js';
import { isRinging, onRingingChange, previewRingtone, stopRinging } from '../ringer.js';
import { act, registrationOf, service, useAppState } from '../store.js';
import { useUI } from '../ui.js';

const onWindows = () => window.sipper.platform === 'win32';
const systemName = () => (onWindows() ? 'Windows' : 'System');

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'audio', label: 'Audio' },
  { id: 'network', label: 'Network' },
  { id: 'codecs', label: 'Codecs' },
  { id: 'browser', label: 'Browser extension' },
  { id: 'recording', label: 'Recording' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'about', label: 'About' },
];

function Section({ title, footnote, children }) {
  return html`<section class="settings-section" aria-label=${title}>
    <h2 class="settings-section-title">${title}</h2>
    ${children}
    ${footnote ? html`<p class="settings-footnote">${footnote}</p>` : null}
  </section>`;
}

const update = (patch) => act('updateSettings', patch);

function GeneralSettings() {
  const state = useAppState();
  const s = state.settings;
  const [notificationsSupported, setNotificationsSupported] = useState(true);
  const [ringing, setRinging] = useState(isRinging());
  useEffect(() => {
    service('notificationsSupported').then(setNotificationsSupported);
    return onRingingChange(setRinging);
  }, []);

  return html`<div class="settings">
    <${Section} title="Behaviour">
      <${SwitchRow} label="Start Sipper when you sign in" description="Sipper starts in the notification area, ready for calls."
        checked=${s.launchAtLogin} onChange=${(on) => update({ launchAtLogin: on })} />
      <${SwitchRow} label="Show Sipper in the notification area"
        description="Closing the window then keeps Sipper running, so calls still ring. Without the icon, closing the window quits Sipper."
        checked=${s.showTrayIcon} onChange=${(on) => update({ showTrayIcon: on })} />
      <${SwitchRow} label="Start with the window hidden" checked=${s.startHidden} onChange=${(on) => update({ startHidden: on })} />
    </${Section}>

    <${Section} title="Incoming calls">
      <${SwitchRow} label="Show an alert window" description="A small window above the taskbar with Answer and Decline, even when Sipper is hidden."
        checked=${s.showIncomingCallAlert} onChange=${(on) => update({ showIncomingCallAlert: on })} />
      <${SwitchRow} label="Show notifications for incoming and missed calls"
        description=${notificationsSupported ? 'Incoming call notifications have Answer and Decline buttons.' : 'Notifications are not available on this system.'}
        checked=${s.showNotifications} onChange=${(on) => update({ showNotifications: on })} />
      <${SettingRow} label="Check notifications" description=${onWindows() ? 'If nothing appears, turn on notifications for Sipper in Windows Settings.' : 'Sends a sample notification.'}>
        <${Button} disabled=${!notificationsSupported} onClick=${() => service('testNotification')}>Send test</${Button}>
        ${onWindows() ? html`<${Button} icon="open" onClick=${() => service('openExternal', 'ms-settings:notifications')}>Notification settings</${Button}>` : null}
      </${SettingRow}>
      <${SettingRow} label="Answer automatically" description="Answers every incoming call on all accounts after the delay. Handy for intercom extensions.">
        <${Select} label="Answer automatically" value=${s.autoAnswerSeconds} onChange=${(seconds) => update({ autoAnswerSeconds: seconds })}
          options=${[{ value: 0, label: 'Off' }, ...[1, 2, 3, 5, 10, 15, 20, 30].map((n) => ({ value: n, label: `After ${n} s` }))]} />
      </${SettingRow}>
    </${Section}>

    <${Section} title="Calls">
      <${SwitchRow} label="Do Not Disturb" description="Rejects incoming calls as busy. Shortcut: Ctrl+Alt+D."
        checked=${s.doNotDisturb} onChange=${(on) => update({ doNotDisturb: on })} />
      <${SwitchRow} label="Mute the microphone when answering" checked=${s.muteMicrophoneOnAnswer}
        onChange=${(on) => update({ muteMicrophoneOnAnswer: on })} />
      <${SettingRow} label="Transport for new accounts">
        <${Select} label="Transport for new accounts" value=${s.defaultTransport} onChange=${(transport) => update({ defaultTransport: transport })}
          options=${TRANSPORTS.map((t) => ({ value: t, label: transportName(t) }))} />
      </${SettingRow}>
      ${onWindows() ? html`<${SettingRow} label="Phone links" description="Choose Sipper for sip: and tel: links. Sipper fills in the dialer and never dials a link by itself.">
        <${Button} icon="open" onClick=${() => service('openExternal', 'ms-settings:defaultapps?registeredAppUser=Sipper')}>Default apps</${Button}>
      </${SettingRow}>` : null}
    </${Section}>

    <${Section} title="Ringtone">
      <${SettingRow} label="Ringtone">
        <${Select} label="Ringtone" value=${s.ringtone} options=${RINGTONES.map((r) => ({ value: r.id, label: r.name }))}
          onChange=${(ringtone) => update({ ringtone })} />
      </${SettingRow}>
      <${SettingRow} label="Volume">
        <input type="range" class="slider" min="0" max="1" step="0.05" value=${s.ringVolume} aria-label="Ringtone volume"
          onChange=${(event) => update({ ringVolume: Number(event.currentTarget.value) })} />
        <${Button} disabled=${s.ringtone === 'silent'} onClick=${() => (ringing ? stopRinging() : previewRingtone(s.ringtone, s.ringVolume))}>
          ${ringing ? 'Stop' : 'Play'}
        </${Button}>
      </${SettingRow}>
    </${Section}>
  </div>`;
}

function AudioSettings() {
  const state = useAppState();
  const s = state.settings;
  const [microphone, setMicrophone] = useState(null);
  useEffect(() => {
    act('refreshAudioDevices');
    service('microphoneStatus').then(setMicrophone);
  }, []);

  const deviceOptions = (devices, current) => {
    const options = [{ value: null, label: `${systemName()} default` }, ...devices.map((d) => ({ value: d.name, label: d.name }))];
    if (current && !devices.some((d) => d.name === current)) options.push({ value: current, label: `${current} (not connected)` });
    return options;
  };
  const inputs = state.audioDevices.filter((d) => d.inputChannels > 0);
  const outputs = state.audioDevices.filter((d) => d.outputChannels > 0);
  const blocked = microphone === 'denied' || microphone === 'restricted';

  return html`<div class="settings">
    <${Section} title="Devices" footnote=${`The ringtone plays through the ${onWindows() ? 'Windows' : 'system'} default output device.`}>
      <${SettingRow} label="Microphone">
        <${Select} label="Microphone" value=${s.inputDeviceName} options=${deviceOptions(inputs, s.inputDeviceName)}
          onChange=${(name) => update({ inputDeviceName: name })} />
      </${SettingRow}>
      <${SettingRow} label="Speaker">
        <${Select} label="Speaker" value=${s.outputDeviceName} options=${deviceOptions(outputs, s.outputDeviceName)}
          onChange=${(name) => update({ outputDeviceName: name })} />
      </${SettingRow}>
      <${SettingRow} label=${state.engineStatus.running ? `${state.audioDevices.length} audio ${state.audioDevices.length === 1 ? 'device' : 'devices'} found` : 'The SIP engine is not running'}
        description="Plugged in a headset? Refresh to list it.">
        <${Button} icon="sync" disabled=${!state.engineStatus.running} onClick=${() => act('refreshAudioDevices')}>Refresh</${Button}>
      </${SettingRow}>
    </${Section}>

    <${Section} title="Echo cancellation">
      <${SettingRow} label="Echo cancellation" description="Stops the other person hearing themselves when you use speakers instead of a headset.">
        <${Select} label="Echo cancellation" value=${s.echoMode} options=${ECHO_MODES.map((m) => ({ value: m.id, label: m.name }))}
          onChange=${(mode) => update({ echoMode: mode })} />
      </${SettingRow}>
      ${s.echoMode === 'software' ? html`<${SettingRow} label="Tail length" description="Longer tails cope with bigger rooms and slower speakers.">
        <${Select} label="Tail length" value=${s.echoTailMilliseconds} onChange=${(ms) => update({ echoTailMilliseconds: ms })}
          options=${Array.from({ length: 16 }, (_, i) => (i + 1) * 50).map((ms) => ({ value: ms, label: `${ms} ms` }))} />
      </${SettingRow}>` : null}
    </${Section}>

    ${onWindows() ? html`<${Section} title="Microphone access">
      ${blocked ? html`<${InfoBar} severity="error" title="Windows is blocking the microphone."
        action=${html`<${Button} onClick=${() => service('openExternal', 'ms-settings:privacy-microphone')}>Open privacy settings</${Button}>`}>
        Turn on microphone access, including “Let desktop apps access your microphone”.
      </${InfoBar}>` : html`<${SettingRow} label="Windows privacy settings" description="Sipper uses the microphone only during calls.">
        <${Button} icon="open" onClick=${() => service('openExternal', 'ms-settings:privacy-microphone')}>Open</${Button}>
      </${SettingRow}>`}
    </${Section}>` : null}
  </div>`;
}

function NetworkSettings() {
  const state = useAppState();
  const s = state.settings;
  const [about, setAbout] = useState(null);
  const initial = () => ({
    stun: s.stunServer,
    udp: s.localUDPPort ? String(s.localUDPPort) : '',
    tcp: s.localTCPPort ? String(s.localTCPPort) : '',
    tls: s.localTLSPort ? String(s.localTLSPort) : '',
    userAgent: s.userAgent,
    verifyTLS: s.verifyTLSCertificates,
    logLevel: s.sipLogLevel,
  });
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    service('about').then(setAbout);
  }, []);

  const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }));
  const port = (text) => Number.parseInt(text.trim(), 10) || 0;
  const portInvalid = [draft.udp, draft.tcp, draft.tls].some((text) => text.trim() && !(/^\d+$/.test(text.trim()) && port(text) >= 1 && port(text) <= 65535));
  const changed = draft.stun.trim() !== s.stunServer || port(draft.udp) !== s.localUDPPort || port(draft.tcp) !== s.localTCPPort
    || port(draft.tls) !== s.localTLSPort || draft.userAgent.trim() !== s.userAgent || draft.verifyTLS !== s.verifyTLSCertificates
    || draft.logLevel !== s.sipLogLevel;

  const apply = () => update({
    stunServer: draft.stun.trim(),
    localUDPPort: port(draft.udp),
    localTCPPort: port(draft.tcp),
    localTLSPort: port(draft.tls),
    userAgent: draft.userAgent.trim(),
    verifyTLSCertificates: draft.verifyTLS,
    sipLogLevel: draft.logLevel,
  });

  const portRow = (label, key) => html`<${SettingRow} label=${label}>
    <${TextField} className="narrow" label=${label} placeholder="Automatic" inputmode="numeric" value=${draft[key]} onValue=${set(key)} />
  </${SettingRow}>`;

  return html`<div class="settings">
    <${Section} title="NAT and security">
      <${SettingRow} label="STUN server" description="Helps calls get through home routers. Leave it empty unless your provider gives you one.">
        <${TextField} className="wide" label="STUN server" placeholder="stun.example.com:3478" value=${draft.stun} onValue=${set('stun')} />
      </${SettingRow}>
      <${SwitchRow} label="Verify TLS certificates" description="Turn this off only for a PBX with a self-signed certificate."
        checked=${draft.verifyTLS} onChange=${set('verifyTLS')} />
    </${Section}>

    <${Section} title="Local SIP ports" footnote="Leave these empty to let Sipper pick free ports. Fixed ports help with firewall rules.">
      ${portRow('UDP port', 'udp')}
      ${portRow('TCP port', 'tcp')}
      ${portRow('TLS port', 'tls')}
    </${Section}>

    <${Section} title="Advanced">
      <${SettingRow} label="User agent">
        <${TextField} className="wide" label="User agent" placeholder=${about ? `Sipper/${about.version} (Windows)` : ''} value=${draft.userAgent} onValue=${set('userAgent')} />
      </${SettingRow}>
      <${SettingRow} label="SIP log level" description="The log is under Diagnostics.">
        <${Select} label="SIP log level" value=${draft.logLevel} onChange=${set('logLevel')} options=${[
          { value: 1, label: 'Errors only' }, { value: 2, label: 'Warnings' }, { value: 3, label: 'Normal' },
          { value: 4, label: 'Verbose, with SIP messages' }, { value: 5, label: 'Debug' },
        ]} />
      </${SettingRow}>
    </${Section}>

    <div class="settings-apply">
      ${portInvalid
        ? html`<span class="caption danger-text">Ports must be whole numbers from 1 to 65535.</span>`
        : html`<span class="caption">Applying restarts the SIP engine and re-registers every account${state.calls.length > 0 ? '. Calls in progress will end.' : '.'}</span>`}
      <${Button} disabled=${!changed} onClick=${() => setDraft(initial())}>Undo changes</${Button}>
      <${Button} kind="accent" disabled=${!changed || portInvalid} onClick=${apply}>Apply</${Button}>
    </div>
  </div>`;
}

function CodecSettings() {
  const state = useAppState();
  const codecs = state.settings.codecs;
  useEffect(() => {
    act('refreshCodecs');
  }, []);
  const save = (list) => update({ codecs: list });
  const move = (index, delta) => {
    const list = [...codecs];
    const [item] = list.splice(index, 1);
    list.splice(index + delta, 0, item);
    save(list);
  };

  if (codecs.length === 0) {
    return html`<${EmptyState} icon="codecs" title="No codecs yet"
      description=${state.engineStatus.running ? 'The SIP engine did not report any codecs.' : 'Codecs are listed once the SIP engine is running.'} />`;
  }
  return html`<div class="settings">
    <${Section} title="Codecs" footnote="Sipper offers the enabled codecs in this order. Opus and G.722 give wideband audio; PCMU and PCMA work with every PBX.">
      <div class="card rows-card" role="list">
        ${codecs.map((codec, index) => html`<div key=${codec.codecID} class="codec-row" role="listitem">
          <${Checkbox} checked=${codec.isEnabled} label=${codecDisplayName(codec.codecID)}
            onChange=${(on) => save(codecs.map((other, i) => (i === index ? { ...other, isEnabled: on } : other)))} />
          <span class="caption mono">${codec.codecID}</span>
          <span class="spacer"></span>
          <${IconButton} icon="chevronDown" className="flip" label=${`Move ${codecDisplayName(codec.codecID)} up`} disabled=${index === 0} onClick=${() => move(index, -1)} />
          <${IconButton} icon="chevronDown" label=${`Move ${codecDisplayName(codec.codecID)} down`} disabled=${index === codecs.length - 1} onClick=${() => move(index, 1)} />
        </div>`)}
      </div>
    </${Section}>
  </div>`;
}

const HELPER_STATUS = {
  installed: ['Installed', 'success-text'],
  elsewhere: ['Points to another copy', 'warning-text'],
  notInstalled: ['Not installed', 'secondary'],
  browserMissing: ['Browser not found', 'secondary'],
};

function BrowserSettings() {
  const [supported, setSupported] = useState(null);
  const [extensionID, setExtensionID] = useState(PINNED_EXTENSION_ID);
  const [entries, setEntries] = useState([]);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => service('browserHelperStatus', extensionID.trim()).then(setEntries).catch((error) => setMessage(cleanError(error)));
  useEffect(() => {
    service('browserHelperSupported').then((ok) => {
      setSupported(ok);
      if (ok) refresh();
    });
  }, []);

  const run = async (action) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(cleanError(error));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return html`<div class="settings">
    <${Section} title="Sipper browser extension">
      <div class="setting-row prose">
        <p>The extension reads the extension you are viewing in FusionPBX and adds it to Sipper. It works in Chrome, Edge, Brave and Vivaldi.</p>
        <ol>
          <li>Open the browser’s extensions page (chrome://extensions or edge://extensions), turn on Developer mode, choose Load unpacked and pick the extension folder from Sipper’s source.</li>
          <li>Open an extension in FusionPBX and click the Sipper button in the toolbar.</li>
        </ol>
      </div>
    </${Section}>

    <${Section} title="Browser helper"
      footnote="Optional. With the helper the extension hands accounts straight to Sipper instead of opening a sipper:// link, and can tell whether Sipper is installed.">
      ${supported === false ? html`<${InfoBar} severity="info">The browser helper is set up by Sipper for Windows.</${InfoBar}>` : html`
        <${SettingRow} label="Extension ID" description="Change it only for a differently signed build of the extension.">
          <${TextField} className="wide mono" label="Extension ID" value=${extensionID} onValue=${setExtensionID} />
        </${SettingRow}>
        ${entries.map((entry) => html`<${SettingRow} key=${entry.id} label=${entry.name}
          description=${entry.status === 'elsewhere' ? `Registered manifest: ${entry.detail}` : null}>
          <span class=${cx('caption', HELPER_STATUS[entry.status][1])}>${HELPER_STATUS[entry.status][0]}</span>
        </${SettingRow}>`)}
        <div class="settings-apply">
          <span class="caption" role="status">${message ?? ''}</span>
          <${Button} disabled=${busy} onClick=${() => run(async () => {
            await service('browserHelperUninstall');
            return 'Helper removed.';
          })}>Remove</${Button}>
          <${Button} kind="accent" disabled=${busy} onClick=${() => run(async () => {
            const written = await service('browserHelperInstall', extensionID.trim());
            return written.length > 0 ? `Installed for ${written.join(', ')}.` : 'No supported browser was found.';
          })}>Install helper</${Button}>
        </div>`}
    </${Section}>
  </div>`;
}

function RecordingSettings() {
  const state = useAppState();
  const s = state.settings;
  const [folder, setFolder] = useState('');
  useEffect(() => {
    service('recordingsDirectory').then(setFolder);
  }, [s.recordingsFolderPath]);

  const choose = async () => {
    const chosen = await service('chooseFolder', folder);
    if (chosen) update({ recordingsFolderPath: chosen });
  };

  return html`<div class="settings">
    <${Section} title="Call recording"
      footnote="You can also start or stop recording during a call with the Record button. Recordings mix both sides of the call. Check the recording laws where you are; many places require telling the other party.">
      <${SwitchRow} label="Record every call automatically" checked=${s.recordCalls} onChange=${(on) => update({ recordCalls: on })} />
    </${Section}>
    <${Section} title="Storage" footnote="Recordings are WAV files (16 kHz mono, about 2 MB per minute) named by date, the other party and the account. They stay on this PC.">
      <${SettingRow} label="Folder" description=${folder} className="wrap">
        <${Button} onClick=${choose}>Choose…</${Button}>
        <${Button} disabled=${!s.recordingsFolderPath} onClick=${() => update({ recordingsFolderPath: '' })}>Use default</${Button}>
        <${Button} icon="folder" onClick=${() => service('openRecordingsFolder')}>Open</${Button}>
      </${SettingRow}>
    </${Section}>
  </div>`;
}

function DiagnosticsSettings() {
  const state = useAppState();
  const [lines, setLines] = useState([]);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const view = useRef(null);

  useEffect(() => {
    let alive = true;
    const load = () => service('logSnapshot').then((snapshot) => alive && setLines(snapshot));
    load();
    const off = window.sipper.on('logChanged', load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (follow && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [lines, follow]);

  const registered = state.accounts.filter((a) => isRegistered(registrationOf(state, a.id))).length;
  return html`<div class="settings diagnostics">
    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">${state.engineStatus.running ? 'SIP engine running' : 'SIP engine stopped'}</span>
        <span class="setting-description">PJSIP ${state.engineStatus.pjsip || 'not loaded'} · ${registered} registered · ${state.calls.length} active ${state.calls.length === 1 ? 'call' : 'calls'}</span>
        ${state.engineStatus.error ? html`<span class="setting-description danger-text">${state.engineStatus.error}</span>` : null}
      </div>
      <div class="setting-control"><${Button} icon="sync" onClick=${() => act('restartEngine')}>Restart engine</${Button}></div>
    </div>
    <pre class="log-view" ref=${view} tabindex="0" aria-label="SIP log">${lines.join('\n')}</pre>
    <div class="settings-apply">
      <${Checkbox} checked=${follow} onChange=${setFollow} label="Follow new lines" />
      <span class="spacer"></span>
      <${Button} onClick=${() => service('logClear')}>Clear</${Button}>
      <${Button} icon="copy" onClick=${async () => {
        await service('copyText', lines.join('\n'));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}>${copied ? 'Copied' : 'Copy'}</${Button}>
      <${Button} icon="save" onClick=${() => service('saveLog')}>Save…</${Button}>
    </div>
  </div>`;
}

function AboutSettings() {
  const [about, setAbout] = useState(null);
  useEffect(() => {
    service('about').then(setAbout);
  }, []);
  if (!about) return null;
  return html`<div class="settings">
    <div class="about-header">
      <img src="../../resources/icon-256.png" alt="" width="64" height="64" />
      <div>
        <h2 class="detail-title">Sipper</h2>
        <p class="secondary">Version ${about.version}</p>
      </div>
    </div>
    <${Section} title="Details">
      <div class="card card-section">
        <dl class="details-grid">
          <dt>PJSIP</dt><dd class="selectable">${about.pjsip || 'not loaded'}</dd>
          <dt>Electron</dt><dd class="selectable">${about.electron} (Chromium ${about.chrome})</dd>
          <dt>System</dt><dd class="selectable">${about.system}</dd>
          <dt>Data folder</dt><dd class="selectable">${about.dataDirectory}</dd>
        </dl>
      </div>
    </${Section}>
    <${Section} title="Licence"
      footnote="Sipper is free software under the GNU General Public License, version 3 or later, and comes with no warranty. PJSIP is GPL-2.0-or-later; Opus, libsrtp, Speex and the other bundled libraries keep their own licences.">
      <div class="button-row">
        <${Button} icon="open" onClick=${() => service('openExternal', 'https://sipper.dev')}>sipper.dev</${Button}>
        <${Button} icon="open" onClick=${() => service('openExternal', 'https://github.com/hybes/sipper')}>Source code</${Button}>
        <${Button} icon="info" onClick=${() => service('openLicences')}>Licences</${Button}>
      </div>
    </${Section}>
  </div>`;
}

const PANELS = {
  general: GeneralSettings,
  audio: AudioSettings,
  network: NetworkSettings,
  codecs: CodecSettings,
  browser: BrowserSettings,
  recording: RecordingSettings,
  diagnostics: DiagnosticsSettings,
  about: AboutSettings,
};

export function SettingsPage() {
  const ui = useUI();
  const [tab, setTab] = useState(ui.selection.tab ?? 'general');
  const Panel = PANELS[tab];
  const onKeyDown = (event, index) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    setTab(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };
  return html`<div class="page">
    <${PageHeader} title="Settings" />
    <div class="settings-tabs">
      <div class="tablist" role="tablist" aria-label="Settings sections">
        ${TABS.map((item, index) => html`<button type="button" role="tab" id=${`settings-tab-${item.id}`} aria-selected=${String(tab === item.id)}
          aria-controls="settings-panel" tabindex=${tab === item.id ? 0 : -1} class=${cx('tab', tab === item.id && 'selected')}
          onClick=${() => setTab(item.id)} onKeyDown=${(event) => onKeyDown(event, index)}>${item.label}</button>`)}
      </div>
    </div>
    <div class="page-body scroll" role="tabpanel" id="settings-panel" aria-labelledby=${`settings-tab-${tab}`}>
      <${Panel} key=${tab} />
    </div>
  </div>`;
}
