import { BrowserWindow, desktopCapturer, dialog } from 'electron';
import { randomUUID } from 'node:crypto';

export function installMeetingMediaPermissions(session, meetings) {
  const mediaWindow = contents => contents && BrowserWindow.fromWebContents(contents);
  session.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'display-capture'
    && details.isMainFrame && meetings.canCapture(mediaWindow(contents)));
  session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const win = mediaWindow(contents), entry = meetings.entry, version = entry?.epoch, captureVersion = entry?.captureEpoch;
    const current = () => entry === meetings.entry && entry?.epoch === version && entry?.captureEpoch === captureVersion
      && meetings.canCapture(win) && details.isMainFrame && details.requestingUrl === contents.getURL();
    if (!current()) { callback(false); return; }
    if (permission === 'display-capture') { callback(true); return; } // Source selection is still required below.
    const kinds = details.mediaTypes;
    if (permission !== 'media' || !kinds?.length || kinds.some(kind => !['audio', 'video'].includes(kind))) { callback(false); return; }
    try {
      const label = kinds.includes('audio') && kinds.includes('video') ? 'microphone and camera' : kinds.includes('audio') ? 'microphone' : 'camera';
      const choice = await dialog.showMessageBox(win, { type: 'question', title: 'Sipper', message: `Allow your ${label} for this meeting?`,
        detail: 'Capture stops when you turn it off or close the meeting window.', buttons: ['Cancel', 'Allow'], defaultId: 0, cancelId: 0, noLink: true });
      callback(current() && choice.response === 1);
    } catch { callback(false); }
  });
  session.setDisplayMediaRequestHandler(async (request, callback) => {
    const entry = meetings.entry, win = entry?.win;
    const current = () => entry === meetings.entry && meetings.canCapture(win) && request.frame === win.webContents.mainFrame;
    const refuse = () => { try { callback({}); } catch { /* Closed requesting frame. */ } };
    if (!request.userGesture || !request.videoRequested || !current()) { refuse(); return; }
    meetings.cancelScreen(entry);
    const pending = { id: randomUUID(), callback, sources: [], audio: process.platform === 'win32' && request.audioRequested };
    entry.screen = pending;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 150 } });
      if (!current() || entry.screen !== pending) { if (entry.screen === pending) meetings.cancelScreen(entry); return; }
      pending.sources = sources;
      win.webContents.send('meetingShareSources', { id: pending.id, audio: pending.audio,
        sources: sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })) });
    } catch { if (entry.screen === pending) meetings.cancelScreen(entry); }
  });
}
