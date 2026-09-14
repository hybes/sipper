// Electron main process of Sipper for Windows. Starts the SIP engine and the app model, and owns
// the windows, the notification-area icon, notifications, launch at login and link handling.

import { app, dialog, Menu, safeStorage, systemPreferences } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleAppScheme, pageURL, registerAppScheme, RENDERER_BASE } from './appProtocol.js';
import { AppState } from './appState.js';
import { BrowserHelper } from './browserHelper.js';
import { EngineClient } from './engineClient.js';
import { registerIPC } from './ipc.js';
import { findLink, LinkTokens } from './links.js';
import { CallNotifications } from './notifications.js';
import { MemoryPasswordStore, SafeStoragePasswordStore } from './passwords.js';
import { JSONStore } from './store.js';
import { SipperTray } from './tray.js';
import { createMainWindow, IncomingCallWindow } from './windows.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = 'com.hybes.sipper';
const isWindows = process.platform === 'win32';
const exe = (name) => (isWindows ? `${name}.exe` : name);

// SIPPER_DATA_DIR keeps a separate profile (tests, screenshots, a second copy for support).
if (process.env.SIPPER_DATA_DIR) app.setPath('userData', path.resolve(process.env.SIPPER_DATA_DIR));

const appRoot = app.getAppPath();
const engineDirectory = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(appRoot, 'engine', 'build');
const enginePath = (!app.isPackaged && process.env.SIPPER_ENGINE) || path.join(engineDirectory, exe('sipper-engine'));
const appIcon = path.join(appRoot, 'resources', 'icon-256.png');
const trayIcon = path.join(appRoot, 'resources', 'tray.png');

registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  app.setAppUserModelId(APP_ID);
  if (isWindows) Menu.setApplicationMenu(null);

  const tokens = new LinkTokens();
  const queuedLinks = [];
  const initialLink = findLink(process.argv);
  if (initialLink) queuedLinks.push(initialLink);

  let state = null;
  let mainWindow = null;
  let incoming = null;
  let tray = null;
  let notifications = null;
  let quitting = false;
  let shutdownComplete = false;

  const quit = () => {
    quitting = true;
    app.quit();
  };

  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  const sendToMain = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const openLink = (link) => {
    if (!state) {
      queuedLinks.push(link);
      return;
    }
    if (tokens.isToastLink(link)) {
      const toast = tokens.parseToastAction(link);
      if (!toast) return; // From an earlier run or not from Sipper: ignore.
      if (toast.action === 'answer') state.answer(toast.callId);
      else if (toast.action === 'decline') state.decline(toast.callId);
      else showMainWindow();
      return;
    }
    state.handleURL(link);
  };

  app.on('second-instance', (_event, argv) => {
    const link = findLink(argv);
    if (link) openLink(link);
    else showMainWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    openLink(url);
  });

  app.on('before-quit', (event) => {
    quitting = true;
    if (shutdownComplete || !state) return;
    event.preventDefault();
    tray?.destroy();
    incoming?.destroy();
    state.shutdown().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    // Sipper keeps running for incoming calls; quitting goes through the tray or the window.
  });

  app.whenReady().then(() => {
    handleAppScheme(appRoot);
    const dataDir = app.getPath('userData');
    const store = new JSONStore(dataDir, { log: (line) => state?.log.append(line) });
    const passwords = !app.isPackaged && process.env.SIPPER_TEST_PASSWORDS === 'memory'
      ? new MemoryPasswordStore()
      : new SafeStoragePasswordStore(dataDir, safeStorage);

    state = new AppState({
      store,
      passwords,
      engine: new EngineClient({ executable: enginePath }),
      version: app.getVersion(),
      platform: {
        nullAudio: process.env.SIPPER_NULL_AUDIO === '1',
        recordingsDirectory: () => path.join(app.getPath('documents'), 'Sipper Recordings'),
        microphoneStatus: () => {
          try {
            return systemPreferences.getMediaAccessStatus('microphone');
          } catch {
            return 'unknown';
          }
        },
      },
    });
    state.load();
    state.log.append(`Sipper: version ${app.getVersion()} on ${os.type()} ${os.release()} (${process.arch})`);

    const preload = path.join(here, '..', 'preload', 'preload.cjs');
    mainWindow = createMainWindow({
      preload,
      page: pageURL('index.html'),
      iconPath: appIcon,
      boundsFile: path.join(dataDir, 'window.json'),
    });
    incoming = new IncomingCallWindow({ preload, page: pageURL('incoming.html') });

    const startHidden = process.argv.includes('--hidden') || state.settings.startHidden;
    mainWindow.once('ready-to-show', () => {
      if (!startHidden) mainWindow.show();
    });
    mainWindow.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      // With the notification-area icon Sipper stays reachable (and keeps ringing) when closed.
      if (tray?.isVisible || !isWindows) mainWindow.hide();
      else quit();
    });
    mainWindow.on('session-end', () => {
      quitting = true;
      state.flush();
    });
    mainWindow.on('focus', () => mainWindow.flashFrame(false));

    notifications = new CallNotifications({
      tokens,
      onAnswer: (id) => state.answer(id),
      onDecline: (id) => state.decline(id),
      onOpenCall: () => showMainWindow(),
      onOpenHistory: () => {
        showMainWindow();
        sendToMain('navigate', { kind: 'history' });
      },
    });

    tray = new SipperTray({
      state,
      iconPath: trayIcon,
      actions: {
        showMainWindow,
        quit,
        showAccount: (id) => {
          showMainWindow();
          sendToMain('navigate', { kind: 'account', id });
        },
        newCall: () => {
          showMainWindow();
          sendToMain('command', 'newCall');
        },
      },
    });
    tray.setVisible(state.settings.showTrayIcon);

    const browserHelper = new BrowserHelper({ dataDir, hostPath: path.join(engineDirectory, exe('sipper-browser-host')) });

    registerIPC({
      state,
      rendererBase: RENDERER_BASE,
      windows: () => ({ mainWindow, incoming }),
      notifications,
      browserHelper,
      about: () => ({
        version: app.getVersion(),
        pjsip: state.engineStatus.pjsip,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        system: `${os.type()} ${os.release()} (${process.arch})`,
        dataDirectory: dataDir,
      }),
      actions: { showMainWindow, quit },
    });

    // State → windows.
    state.on('change', (keys) => {
      const snapshot = state.snapshot(keys);
      sendToMain('state', snapshot);
      incoming.webContents?.send('state', snapshot);
    });
    state.log.onChange(() => sendToMain('logChanged'));
    state.on('alert', ({ title, message }) => {
      const parent = mainWindow.isVisible() ? mainWindow : undefined;
      dialog.showMessageBox(parent, { type: 'warning', title: 'Sipper', message: title, detail: message, buttons: ['OK'], noLink: true });
    });
    state.on('showWindow', showMainWindow);
    state.on('navigate', (target) => sendToMain('navigate', target));
    state.on('prefillDialer', (payload) => sendToMain('prefillDialer', payload));
    state.on('accountDeleted', (id) => sendToMain('navigate', { kind: 'removed', id }));
    state.on('profileDeleted', (id) => sendToMain('navigate', { kind: 'removed', id }));
    state.on('incomingCall', ({ call, accountLabel, ring, showAlert, notify }) => {
      if (showAlert) incoming.present();
      if (ring) sendToMain('ring', ring);
      if (notify) notifications.showIncoming(call, accountLabel);
      if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
    });
    state.on('ringingEnded', ({ callId, anyStillRinging }) => {
      notifications.removeIncoming(callId);
      if (!anyStillRinging) {
        sendToMain('ringStop');
        incoming.hide();
        mainWindow.flashFrame(false);
      }
    });
    state.on('missedCall', (record) => notifications.showMissed(record));
    state.on('trayVisibilityChanged', (visible) => tray.setVisible(visible));
    state.on('launchAtLoginChanged', (enabled) => {
      // Only an installed Windows copy registers itself; a development run must not.
      if (isWindows && app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    });
    if (isWindows && app.isPackaged) {
      const login = app.getLoginItemSettings({ args: ['--hidden'] });
      if (login.executableWillLaunchAtLogin !== state.settings.launchAtLogin) {
        state.updateSettings({ launchAtLogin: Boolean(login.executableWillLaunchAtLogin) });
      }
    }
    systemPreferences.on?.('accent-color-changed', () => sendToMain('theme', { accent: systemPreferences.getAccentColor?.() }));

    state.startEngine().then(() => {
      for (const link of queuedLinks.splice(0)) openLink(link);
    });
  });
}
