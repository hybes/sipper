import { Button, Checkbox, cleanError, Dialog, InfoBar, PageHeader, Select } from './components.js';
import { html, render, useEffect, useRef, useState } from './lib.js';
import { changeMeetingCapture, changeMeetingDevice, stopMeetingCapture } from './meetingCapture.js';

const { Room, RoomEvent, Track, ConnectionState, DisconnectReason, setLogLevel } = globalThis.LivekitClient;
setLogLevel('silent');
async function request(name, ...args) {
  const result = await window.sipper.app(name, ...args);
  if (result.error) throw Object.assign(Error(result.error.message), { code: result.error.code });
  return result.value;
}
const liveTrack = (person, source) => {
  const publication = person.getTrackPublication(source);
  return publication && (person.isLocal || !publication.isMuted) && publication.track?.mediaStreamTrack.readyState === 'live' ? publication.track : null;
};
const deviceKinds = [['audioinput', 'Microphone'], ['audiooutput', 'Speaker'], ['videoinput', 'Camera']];
function Media({ track, local = false }) {
  const element = useRef(null);
  useEffect(() => { const own = element.current; track.attach(own); return () => track.detach(own); }, [track]);
  return track.kind === 'video' ? html`<video ref=${element} autoplay playsinline muted=${local} class="meeting-video" />`
    : html`<audio ref=${element} autoplay />`;
}
function Meeting() {
  const [details, setDetails] = useState(null), [state, setState] = useState(ConnectionState.Disconnected), [joining, setJoining] = useState(true);
  const [people, setPeople] = useState([]), [error, setError] = useState(null), [notice, setNotice] = useState('');
  const [audioReady, setAudioReady] = useState(false), [mediaBusy, setMediaBusy] = useState(false), [actionBusy, setActionBusy] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const [devices, setDevices] = useState([]), [deviceError, setDeviceError] = useState(null), [selectedDevices, setSelectedDevices] = useState({});
  const [confirmation, setConfirmation] = useState(null), [share, setShare] = useState(null), [screenAudio, setScreenAudio] = useState(false);
  const [returnPhone, setReturnPhone] = useState(false);
  const room = useRef(null), epoch = useRef(0), alive = useRef(true), detailsRef = useRef(null), polling = useRef(false), captures = useRef(false);
  const connectedRoom = useRef(null);
  detailsRef.current = details;
  const refreshDevices = async () => {
    try {
      // The SDK defaults to requesting capture permission. Enumeration must not.
      const values = await Room.getLocalDevices(undefined, false);
      if (alive.current) { setDevices(values); setDeviceError(null); }
    } catch { if (alive.current) setDeviceError('Could not list devices. Check your device connection and refresh.'); }
  };
  const update = r => {
    if (room.current !== r || !alive.current) return;
    setState(r.state); setAudioReady(r.canPlaybackAudio);
    setSelectedDevices(Object.fromEntries(deviceKinds.map(([kind]) => [kind, r.getActiveDevice(kind) ?? ''])));
    if (r.state === ConnectionState.Connected) connectedRoom.current = r;
    setPeople((connectedRoom.current === r ? [r.localParticipant, ...r.remoteParticipants.values()] : []).map(person => ({ identity: person.identity, name: person.name || (person.isLocal ? 'You' : 'Participant'), local: person.isLocal,
      userId: person.isLocal ? detailsRef.current?.userId : detailsRef.current?.sessions.find(s => `sipper:${s.id}` === person.identity)?.userId,
      camera: liveTrack(person, Track.Source.Camera), screen: liveTrack(person, Track.Source.ScreenShare),
      audio: person.isLocal ? null : liveTrack(person, Track.Source.Microphone), screenAudio: person.isLocal ? null : liveTrack(person, Track.Source.ScreenShareAudio),
      microphone: Boolean(liveTrack(person, Track.Source.Microphone)), cameraOn: Boolean(liveTrack(person, Track.Source.Camera)), speaking: person.isSpeaking })));
  };
  const disconnect = async (retire = true) => {
    epoch.current++; const r = room.current; room.current = null; captures.current = false;
    if (r) { stopMeetingCapture(r); await r.disconnect(true).catch(() => {}); }
    if (alive.current) { setPeople([]); setState(ConnectionState.Disconnected); setJoining(false); setMediaBusy(false); setShare(null); }
    if (retire) await request('meetingRetire').catch(() => {});
  };
  const refresh = async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const value = await request('meetingDetails');
      if (!alive.current) return;
      detailsRef.current = value; setDetails(value); setDetailsError(null);
      if (!value.canJoin && room.current) { setNotice(value.meeting.endedAt ? 'Meeting end requested.' : 'Your meeting access has changed.'); await disconnect(); }
      else if (room.current) update(room.current);
    } catch (problem) { if (alive.current) setDetailsError(cleanError(problem)); }
    finally { polling.current = false; }
  };
  useEffect(() => {
    const version = ++epoch.current;
    const current = () => alive.current && epoch.current === version;
    request('meetingInitial').then(async initial => {
      if (!current()) return;
      detailsRef.current = initial.details; setDetails(initial.details);
      setReturnPhone(Boolean(initial.returnPhone));
      if (initial.pending) return;
      if (initial.error) { setError(initial.error.message); setJoining(false); return; }
      if (!initial.grant) { setJoining(false); return; }
      const r = new Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true, disconnectOnPageLeave: true });
      let connectedOnce = false;
      room.current = r;
      for (const event of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
        RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
        RoomEvent.ActiveSpeakersChanged, RoomEvent.AudioPlaybackStatusChanged, RoomEvent.ActiveDeviceChanged]) r.on(event, () => update(r));
      r.on(RoomEvent.ConnectionStateChanged, () => { if (room.current === r) { connectedOnce ||= r.state === ConnectionState.Connected; update(r); void request('meetingMediaState', r.state === ConnectionState.Connected).catch(() => {}); } });
      r.on(RoomEvent.Disconnected, reason => {
        if (room.current !== r) return;
        setNotice(reason === DisconnectReason.PARTICIPANT_REMOVED ? 'You were removed from this meeting.' : reason === DisconnectReason.ROOM_DELETED ? 'This meeting has ended.' : connectedOnce ? 'You have disconnected from the meeting.' : 'Could not connect to the meeting. Check your connection and retry.');
        void disconnect(); void refresh();
      });
      try {
        // Receiving audio never captures a device. All capture uses the explicit controls below.
        await r.startAudio().catch(() => {});
        if (!current()) return;
        await r.connect(initial.grant.url, initial.grant.token);
        if (!current()) { stopMeetingCapture(r); await r.disconnect(true); return; }
        update(r); setJoining(false); void refresh(); void refreshDevices();
      } catch (problem) {
        if (current()) { setError('Could not connect to the meeting. Check your connection and retry.'); await disconnect(); }
      }
    }).catch(problem => { if (current()) { setError(cleanError(problem)); setJoining(false); } });
    const timer = setInterval(refresh, 15_000);
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    void refreshDevices();
    const unsubscribe = window.sipper.on('meetingShareSources', value => {
      if (!alive.current || !room.current) return;
      setScreenAudio(false); setShare(value);
    });
    const closing = () => { alive.current = false; epoch.current++; if (room.current) stopMeetingCapture(room.current); };
    window.addEventListener('beforeunload', closing);
    return () => { closing(); clearInterval(timer); unsubscribe(); navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices); window.removeEventListener('beforeunload', closing); if (room.current) void room.current.disconnect(true); };
  }, []);
  const connected = state === ConnectionState.Connected, self = people.find(p => p.local), active = Boolean(room.current) || joining;
  const ended = details?.meeting.controlConfirmedAt ? 'Ended' : details?.meeting.endedAt ? 'End requested' : details && Date.parse(details.meeting.expiresAt) <= Date.now() ? 'Expired' : null;
  const host = details?.meeting.createdBy && details.meeting.createdBy === details.userId;
  const capture = async source => {
    const r = room.current, version = epoch.current;
    if (!r || captures.current) return;
    const enabled = !liveTrack(r.localParticipant, source);
    const current = () => room.current === r && epoch.current === version && (!enabled || (r.state === ConnectionState.Connected && detailsRef.current?.canJoin && !ended));
    if (!current()) return;
    captures.current = true; setMediaBusy(true); setError(null);
    try { await changeMeetingCapture(r, source, enabled, current); }
    catch (problem) { if (current()) setError(problem.name === 'NotAllowedError' ? 'Capture was not allowed. Check permissions or choose another source.' : 'Could not update capture. Check the selected device and try again.'); }
    finally { if (room.current === r && epoch.current === version) { captures.current = false; setMediaBusy(false); update(r); setShare(null); void refreshDevices(); } }
  };
  const chooseDevice = async (kind, deviceId) => {
    const r = room.current, version = epoch.current;
    const current = () => alive.current && room.current === r && epoch.current === version && r?.state === ConnectionState.Connected && detailsRef.current?.canJoin && !ended;
    if (!current() || captures.current) return;
    captures.current = true; setMediaBusy(true); setError(null);
    try { await changeMeetingDevice(r, kind, deviceId, current); }
    catch (problem) { if (current()) setError(problem.name === 'NotAllowedError' ? 'Device access was not allowed. Check permissions and try again.' : 'Could not select this device. Choose another device or the system default.'); }
    finally { if (room.current === r && epoch.current === version) { captures.current = false; setMediaBusy(false); update(r); void refreshDevices(); } }
  };
  const leave = async () => { await disconnect(); await request('meetingClose').catch(() => {}); };
  const retry = async () => { setJoining(true); setError(null); await disconnect(false); setJoining(true); try { await request('meetingRetry'); } catch (problem) { if (alive.current) { setError(cleanError(problem)); setJoining(false); } } };
  const moderate = async () => {
    if (!confirmation || actionBusy) return;
    setActionBusy(true); setError(null);
    try {
      if (confirmation.end) { await request('meetingEnd'); setConfirmation(null); setNotice('Meeting end requested.'); await disconnect(); }
      else { await request('meetingRemove', confirmation.userId); setNotice(`Removal requested for ${confirmation.name}.`); setConfirmation(null); }
      await refresh();
    } catch (problem) { setError(cleanError(problem)); }
    finally { setActionBusy(false); }
  };
  const chooseScreen = async source => {
    try { await request('meetingChooseScreen', share.id, source, screenAudio); setShare(null); }
    catch (problem) { setShare(null); setError(cleanError(problem)); }
  };
  useEffect(() => { document.title = `${details?.title ?? 'Meeting'} · Sipper`; }, [details?.title]);
  return html`<div class="page meeting-page"><${PageHeader} title=${details?.title ?? 'Meeting'} />
    <div class="page-body meeting-body">
      <div class="meeting-summary"><p class="secondary">${details?.organisation.name ?? 'Customer meeting'}${details?.hostName ? ` · Hosted by ${details.hostName}` : ''}</p>
        <span class="meeting-status">${ended ?? (connected ? 'Connected' : joining ? 'Connecting' : active ? 'Reconnecting' : 'Disconnected')}</span></div>
      ${error ? html`<${InfoBar} severity="error" title="Meeting action not confirmed">${error}</${InfoBar}>` : null}
      ${detailsError ? html`<${InfoBar} severity="error" title="Meeting details unavailable">${detailsError}<${Button} onClick=${refresh}>Refresh details</${Button}></${InfoBar}>` : null}
      ${notice ? html`<p class="caption" role="status">${notice}</p>` : null}
      <div class="meeting-controls">
        ${active ? html`
          <${Button} disabled=${mediaBusy || (!connected && !self?.microphone)} aria-pressed=${Boolean(self?.microphone)} onClick=${() => capture(Track.Source.Microphone)}>${self?.microphone ? 'Turn microphone off' : 'Turn microphone on'}</${Button}>
          <${Button} disabled=${mediaBusy || (!connected && !self?.cameraOn)} aria-pressed=${Boolean(self?.cameraOn)} onClick=${() => capture(Track.Source.Camera)}>${self?.cameraOn ? 'Turn camera off' : 'Turn camera on'}</${Button}>
          <${Button} disabled=${mediaBusy || (!connected && !self?.screen)} aria-pressed=${Boolean(self?.screen)} onClick=${() => capture(Track.Source.ScreenShare)}>${self?.screen ? 'Stop sharing' : 'Share screen'}</${Button}>
          ${connected && !audioReady ? html`<${Button} onClick=${async () => { const r = room.current; if (!r) return; try { await r.startAudio(); update(r); } catch { if (room.current === r) setError('Audio playback could not start.'); } }}>Enable audio</${Button}>` : null}
          <${Button} kind="danger" onClick=${leave}>${joining ? 'Cancel joining' : 'Leave meeting'}</${Button}>`
          : html`<${Button} kind="accent" disabled=${Boolean(ended) || (details && !details.canJoin)} onClick=${retry}>Retry joining</${Button}><${Button} onClick=${leave}>Close meeting</${Button}>`}
        ${host && !ended ? html`<${Button} disabled=${actionBusy} onClick=${() => { setError(null); setConfirmation({ end: true }); }}>End for everyone</${Button}>` : null}
      </div>
      <p class="caption">${ended ? 'This meeting is closed to new joins.' : !active ? 'Joining starts with your microphone and camera off.' : 'Capture starts only when you turn it on. Closing this window leaves the meeting.'}</p>
      ${returnPhone && active ? html`<p class="caption">Leaving returns to your phone call if it is still available.</p>` : null}
      <div class="meeting-devices">
        ${deviceKinds.map(([kind, label]) => {
          const choices = devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'default');
          const selected = selectedDevices[kind] === 'default' ? '' : selectedDevices[kind] ?? '';
          const options = [{ value: '', label: 'System default' }, ...choices.map((device, index) => ({ value: device.deviceId, label: device.label || `${label} ${index + 1}` }))];
          if (selected && !options.some(option => option.value === selected)) options.push({ value: selected, label: 'Unavailable device', disabled: true });
          return html`<label class="meeting-device" key=${kind}><span>${label}</span><${Select} label=${label} value=${selected} options=${options} disabled=${!connected || mediaBusy || (kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype))} onChange=${value => chooseDevice(kind, value)} /></label>`;
        })}
        <${Button} onClick=${refreshDevices}>Refresh devices</${Button}>
      </div>
      ${deviceError ? html`<p class="caption" role="alert">${deviceError}</p>` : null}
      <p class="caption">Device names appear after permission is granted. Selecting a device does not turn capture on.</p>
      <div class="meeting-media">
        ${people.map(person => html`<div class="meeting-person-media" key=${person.identity}>
          ${person.screen ? html`<figure class="meeting-screen"><${Media} track=${person.screen} local=${person.local} /><figcaption>${person.local ? 'Your screen' : `${person.name}'s screen`}</figcaption></figure>` : null}
          ${person.camera ? html`<figure><${Media} track=${person.camera} local=${person.local} /><figcaption>${person.local ? 'You' : person.userId === details?.userId ? 'You (another device)' : person.name}</figcaption></figure>` : null}
          ${person.audio ? html`<${Media} track=${person.audio} />` : null}${person.screenAudio ? html`<${Media} track=${person.screenAudio} />` : null}
        </div>`)}
      </div>
      <h2 class="detail-title">People</h2><div class="meeting-table-scroll" tabindex="0" aria-label="Meeting people table"><table class="meeting-table"><caption class="sr-only">People currently connected to this meeting</caption>
        <thead><tr><th scope="col">Person</th><th scope="col">Microphone</th><th scope="col">Camera</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${people.map(person => html`<tr key=${person.identity}><td>${person.local ? 'You' : person.userId === details?.userId ? 'You (another device)' : person.name}${person.speaking ? html`<span class="caption"> · Speaking</span>` : null}</td>
          <td>${person.microphone ? 'On' : 'Off'}</td><td>${person.cameraOn ? 'On' : 'Off'}</td><td>${host && !person.local && person.userId && person.userId !== details?.userId && !ended ? html`<${Button} disabled=${actionBusy} onClick=${() => { setError(null); setConfirmation({ userId: person.userId, name: person.name }); }}>Remove</${Button}>` : null}</td></tr>`)}</tbody>
      </table></div>${!people.length ? html`<p class="caption" role="status">${joining ? 'Connecting to the meeting…' : ended ? 'The meeting is closed.' : 'No connected people to show.'}</p>` : null}
    </div>
    ${confirmation ? html`<${Dialog} title=${confirmation.end ? 'End meeting for everyone?' : `Remove ${confirmation.name}?`} onClose=${() => !actionBusy && setConfirmation(null)}
      footer=${html`<${Button} disabled=${actionBusy} onClick=${() => setConfirmation(null)}>Cancel</${Button}><${Button} kind="danger" disabled=${actionBusy} onClick=${moderate}>${actionBusy ? 'Requesting…' : confirmation.end ? 'End meeting' : 'Remove person'}</${Button}>`}>
      <p>${confirmation.end ? 'Everyone will be disconnected. This meeting cannot be joined again.' : 'This person will be removed on all their devices and cannot rejoin this meeting.'}</p>
      <p class="caption">Sipper will retry until the meeting server confirms the request.</p>${error ? html`<${InfoBar} severity="error" title="Request not confirmed">${error}</${InfoBar}>` : null}
    </${Dialog}>` : null}
    ${share ? html`<${Dialog} title="Choose what to share" onClose=${() => chooseScreen(null)} footer=${html`<${Button} onClick=${() => chooseScreen(null)}>Cancel</${Button}>`}>
      <p>Only the screen or window you select will be shared.</p>${share.audio ? html`<${Checkbox} checked=${screenAudio} onChange=${setScreenAudio} label="Also share computer audio" /><p class="caption">This includes audio from other apps. Leave this off to share video only.</p>` : null}
      <div class="meeting-sources">${share.sources.map(source => html`<button type="button" key=${source.id} class="meeting-source" onClick=${() => chooseScreen(source.id)}><img src=${source.thumbnail} alt="" /><span>${source.name}</span></button>`)}</div>
      ${!share.sources.length ? html`<p>No screen or window is available. Check screen recording permissions.</p>` : null}
    </${Dialog}>` : null}
  </div>`;
}
document.body.classList.add(`platform-${window.sipper.platform}`);
render(html`<${Meeting} />`, document.getElementById('root'));
