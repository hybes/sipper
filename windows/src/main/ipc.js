// IPC between the windows and the main process. Windows may only call the AppState actions and
// app services listed here, and only from Sipper's own pages.

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const STATE_ACTIONS = new Set([
  'addProfile', 'updateProfile', 'setProfileEnabled', 'deleteProfile', 'reorderProfiles',
  'addAccount', 'updateAccount', 'setAccountEnabled', 'deleteAccount', 'reorderAccounts', 'moveAccount',
  'setDialerAccount', 'reRegister', 'reRegisterAll', 'passwordFor',
  'call', 'callVoicemail', 'callBack', 'answer', 'decline', 'hangup', 'hangupActiveCall', 'answerOrHangUp',
  'toggleMute', 'toggleHold', 'swapToCall', 'selectCall', 'sendDTMF', 'transfer', 'attendedTransfer', 'toggleRecording',
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

export function registerIPC({ state, rendererBase, windows, notifications, browserHelper, about, actions }) {
  const fromSipper = (event) => event.senderFrame?.url?.startsWith(rendererBase);
  const guard = (handler) => (event, ...args) => {
    if (!fromSipper(event)) throw new Error('Refused a request from an unknown page.');
    return handler(event, ...args);
  };

  ipcMain.handle('state:get', guard(() => state.snapshot()));

  ipcMain.handle('state:invoke', guard((_event, method, args) => {
    if (!STATE_ACTIONS.has(method)) throw new Error(`Unknown action ${method}`);
    return state[method](...(Array.isArray(args) ? args : []));
  }));

  const services = {
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
    const service = services[action];
    if (!service) throw new Error(`Unknown service ${action}`);
    return service(BrowserWindow.fromWebContents(event.sender), ...(Array.isArray(args) ? args : []));
  }));
}
