// IPC between the windows and the main process. Windows may only call the AppState actions and
// app services listed here, and only from Sipper's own pages.

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const STATE_ACTIONS = new Set([
  'addProfile', 'updateProfile', 'setProfileEnabled', 'deleteProfile', 'reorderProfiles',
  'addAccount', 'updateAccount', 'setAccountEnabled', 'deleteAccount', 'reorderAccounts', 'moveAccount',
  'setDialerAccount', 'prepareNewCall', 'reRegister', 'reRegisterAll', 'passwordFor',
  'call', 'callVoicemail', 'callBack', 'answer', 'decline', 'hangup', 'hangupActiveCall', 'answerOrHangUp',
  'mergeConference', 'separateConference', 'endConference', 'toggleMute', 'toggleHold', 'swapToCall', 'selectCall', 'sendDTMF', 'transfer', 'attendedTransfer', 'toggleRecording',
  'markMissedCallsSeen', 'deleteHistory', 'clearHistory', 'deleteRecording',
  'addContact', 'updateContact', 'deleteContact', 'toggleFavorite',
  'commitImport', 'cancelImport', 'updateSettings', 'toggleDoNotDisturb',
  'refreshAudioDevices', 'refreshCodecs', 'restartEngine',
]);

/** Electron menu template items from plain descriptions; resolves with the chosen id. */
function popupMenu(win, items) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const build = (entries) => entries.map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      return {
        label: item.label,
        enabled: item.enabled !== false,
        type: item.checked === undefined ? 'normal' : 'checkbox',
        checked: item.checked,
        submenu: item.submenu ? build(item.submenu) : undefined,
        click: item.submenu ? undefined : () => finish(item.id),
      };
    });
    Menu.buildFromTemplate(build(items)).popup({ window: win, callback: () => setTimeout(() => finish(null), 0) });
  });
}

export function registerIPC({ state, managed, meetings, rendererBase, windows, notifications, browserHelper, about, actions }) {
  const fromSipper = (event) => event.senderFrame?.url?.startsWith(rendererBase);
  const guard = (handler) => (event, ...args) => {
    if (!fromSipper(event)) throw new Error('Refused a request from an unknown page.');
    return handler(event, ...args);
  };

  const meetingSender = event => meetings?.owns(BrowserWindow.fromWebContents(event.sender));
  ipcMain.handle('state:get', guard(event => {
    if (meetingSender(event)) throw new Error('The meeting page cannot read app state.');
    return state.snapshot();
  }));

  ipcMain.handle('state:invoke', guard((event, method, args) => {
    if (meetingSender(event)) throw new Error('The meeting page cannot control phone accounts.');
    if (!STATE_ACTIONS.has(method)) throw new Error(`Unknown action ${method}`);
    return state[method](...(Array.isArray(args) ? args : []));
  }));

  // Message operations preserve safe error codes across Electron's error serialisation.
  const messageResult = async operation => {
    try { return { value: await operation() }; }
    catch (error) {
      return { error: error.name === 'ZodError' ? { code: 'invalid_message_input', message: 'Check the message, people and history cursor.' }
        : { code: error.code ?? 'unavailable', message: error.code ? error.message : 'Messages are temporarily unavailable.' } };
    }
  };
  const meetingResult = async operation => {
    try { return { value: await operation() }; }
    catch (error) { return { error: { code: error.name === 'ZodError' ? 'invalid_meeting_input' : error.code ?? 'unavailable',
      message: error.name === 'ZodError' ? 'Refresh the meeting and try again.' : error.code ? error.message : 'Meetings are temporarily unavailable.' } }; }
  };
  const mediaServices = {
    meetingInitial: win => meetingResult(() => meetings.initial(win)),
    meetingDetails: win => meetingResult(() => meetings.details(win)),
    meetingRetry: win => meetingResult(() => meetings.retry(win)),
    meetingMediaState: (win, connected) => meetingResult(() => meetings.mediaState(win, connected)),
    meetingRetire: win => meetingResult(() => meetings.retire(win)),
    meetingClose: win => meetingResult(() => meetings.close(win)),
    meetingEnd: win => meetingResult(() => meetings.end(win)),
    meetingRemove: (win, userId) => meetingResult(() => meetings.remove(win, userId)),
    meetingChooseScreen: (win, id, source, audio) => meetingResult(() => meetings.chooseScreen(win, id, source, audio)),
  };

  const services = {
    managedSignIn: () => managed.client.signIn(),
    managedCancelSignIn: () => managed.client.cancelSignIn(),
    managedRefresh: () => managed.refresh(),
    managedAvailability: (_win, organisationId, value) => managed.setAvailability(organisationId, value),
    managedDoNotDisturb: (_win, organisationId, enabled) => managed.setDoNotDisturb(organisationId, enabled),
    managedConnect: (_win, organisationId) => managed.connect(organisationId),
    managedConnectSetupLink: (_win, value) => managed.connectSetupLink(value),
    managedDisconnect: (_win, deviceId) => managed.client.disconnect(deviceId),
    managedSignOut: () => managed.client.signOut(),
    managedDirectory: (_win, deviceId) => managed.client.directorySnapshot(deviceId),
    managedDirectoryRefresh: (_win, deviceId) => managed.client.refreshDirectory(deviceId),
    managedDirectoryStatus: (_win, deviceId, contactIds) => managed.client.directoryStatus(deviceId, contactIds),
    managedDirectoryCall: (_win, deviceId, contactId, number, accountId) => managed.callDirectory(deviceId, contactId, number, accountId),
    managedMessagePeople: (_win, deviceId, query) => messageResult(() => managed.client.messagePeople(deviceId, query)),
    managedConversations: (_win, deviceId, query) => messageResult(() => managed.client.conversations(deviceId, query)),
    managedCreateConversation: (_win, deviceId, input) => messageResult(() => managed.client.createConversation(deviceId, input)),
    managedConversationMessages: (_win, deviceId, id, query) => messageResult(() => managed.client.conversationMessages(deviceId, id, query)),
    managedSendMessage: (_win, deviceId, id, input) => messageResult(() => managed.client.sendMessage(deviceId, id, input)),
    managedMarkConversationRead: (_win, deviceId, id, sequence) => messageResult(() => managed.client.markConversationRead(deviceId, id, sequence)),
    managedUpdateMessageGroup: (_win, deviceId, id, input) => messageResult(() => managed.client.updateMessageGroup(deviceId, id, input)),
    managedLeaveMessageGroup: (_win, deviceId, id) => messageResult(() => managed.client.leaveMessageGroup(deviceId, id)),
    managedCurrentMeeting: (_win, deviceId, id) => meetingResult(() => managed.client.currentMeeting(deviceId, id)),
    managedStartMeeting: (_win, deviceId, id, nonce) => meetingResult(() => managed.client.startMeeting(deviceId, id, nonce)),
    managedOpenMeeting: (win, deviceId, id) => meetingResult(() => {
      if (win !== windows().mainWindow) throw new Error('Only the main window can open a meeting.');
      return meetings.open(deviceId, id);
    }),
    confirm: (win, options) => dialog.showMessageBox(win, {
      type: options.type ?? 'question',
      title: 'Sipper',
      message: options.message,
      detail: options.detail,
      buttons: options.buttons ?? ['OK', 'Cancel'],
      defaultId: options.defaultId ?? 0,
      cancelId: options.cancelId ?? (options.buttons ?? ['OK', 'Cancel']).length - 1,
      noLink: true,
    }).then((result) => result.response),
    contextMenu: (win, items) => popupMenu(win, items),
    chooseFolder: async (win, defaultPath) => {
      const result = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use folder' });
      return result.canceled ? null : result.filePaths[0];
    },
    saveLog: async (win) => {
      const result = await dialog.showSaveDialog(win, { defaultPath: 'sipper-log.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
      if (result.canceled || !result.filePath) return false;
      fs.writeFileSync(result.filePath, state.log.export());
      return true;
    },
    copyText: (_win, text) => clipboard.writeText(String(text)),
    logSnapshot: () => state.log.snapshot(),
    logClear: () => state.log.clear(),
    openRecording: (_win, recordID) => {
      const file = state.recordingPath(recordID);
      return file ? shell.openPath(file) : 'The recording file no longer exists.';
    },
    showRecording: (_win, recordID) => {
      const file = state.recordingPath(recordID);
      if (file) shell.showItemInFolder(file);
    },
    openRecordingsFolder: () => {
      fs.mkdirSync(state.recordingsDirectory, { recursive: true });
      return shell.openPath(state.recordingsDirectory);
    },
    recordingsDirectory: () => state.recordingsDirectory,
    openExternal: (_win, url) => {
      if (!/^(https:\/\/|ms-settings:)/i.test(String(url))) throw new Error('Only web and Settings links can be opened.');
      return shell.openExternal(url);
    },
    browserHelperStatus: (_win, extensionID) => browserHelper.status(extensionID),
    browserHelperInstall: (_win, extensionID) => browserHelper.install(extensionID),
    browserHelperUninstall: () => browserHelper.uninstall(),
    browserHelperSupported: () => browserHelper.supported,
    notificationsSupported: () => notifications.supported,
    testNotification: () => notifications.showTest(),
    microphoneStatus: () => {
      try {
        return systemPreferences.getMediaAccessStatus('microphone');
      } catch {
        return 'unknown';
      }
    },
    accentColor: () => {
      try {
        return systemPreferences.getAccentColor?.() ?? null;
      } catch {
        return null;
      }
    },
    about: () => about(),
    openLicences: () => {
      const folder = app.isPackaged ? path.join(process.resourcesPath, 'Licenses') : path.resolve(app.getAppPath(), '..', 'LICENSE');
      return shell.openPath(folder);
    },
    incomingFit: (_win, height) => windows().incoming?.fit(Number(height)),
    showMainWindow: () => actions.showMainWindow(),
    quit: () => actions.quit(),
  };

  ipcMain.handle('app:action', guard((event, action, args) => {
    if (meetingSender(event)) {
      const service = mediaServices[action];
      if (!service) throw new Error('The meeting page can only control its own meeting.');
      return service(BrowserWindow.fromWebContents(event.sender), ...(Array.isArray(args) ? args : []));
    }
    if (mediaServices[action]) throw new Error('This operation belongs to a meeting window.');
    const service = services[action];
    if (!service) throw new Error(`Unknown service ${action}`);
    return service(BrowserWindow.fromWebContents(event.sender), ...(Array.isArray(args) ? args : []));
  }));
}
