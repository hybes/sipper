// The main window and the incoming-call alert window.

import { BrowserWindow, nativeTheme, screen, shell } from 'electron';
import fs from 'node:fs';

import { RENDERER_BASE } from './appProtocol.js';

const isWindows = process.platform === 'win32';

export const TITLE_BAR_HEIGHT = 40;

export function themeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    background: dark ? '#202020' : '#f3f3f3',
    symbol: dark ? '#ffffff' : '#1a1a1a',
  };
}

function secureWebPreferences(preload) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false,
    backgroundThrottling: false,
    autoplayPolicy: 'no-user-gesture-required',
  };
}

/** Keeps windows on Sipper's own pages; web links open in the default browser. */
function lockNavigation(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(RENDERER_BASE)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// MARK: Window position memory

function readBounds(file) {
  try {
    const bounds = JSON.parse(fs.readFileSync(file, 'utf8'));
    const visible = screen.getAllDisplays().some(({ workArea }) =>
      bounds.x < workArea.x + workArea.width - 80 && bounds.x + bounds.width > workArea.x + 80
      && bounds.y < workArea.y + workArea.height - 40 && bounds.y + 40 > workArea.y);
    return visible && bounds.width >= 820 && bounds.height >= 540 ? bounds : null;
  } catch {
    return null;
  }
}

export function createMainWindow({ preload, page, iconPath, boundsFile }) {
  const colors = themeColors();
  const saved = readBounds(boundsFile);
  const win = new BrowserWindow({
    width: saved?.width ?? 1060,
    height: saved?.height ?? 720,
    x: saved?.x,
    y: saved?.y,
    minWidth: 820,
    minHeight: 540,
    show: false,
    title: 'Sipper',
    icon: iconPath,
    backgroundColor: colors.background,
    titleBarStyle: 'hidden',
    ...(isWindows
      ? { titleBarOverlay: { color: colors.background, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT } }
      : { trafficLightPosition: { x: 14, y: 13 } }),
    webPreferences: secureWebPreferences(preload),
  });
  lockNavigation(win);
  win.loadURL(page);

  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
      try {
        fs.writeFileSync(boundsFile, JSON.stringify(win.getBounds()));
      } catch {
        // Not worth interrupting anyone over.
      }
    }, 500);
  };
  win.on('resize', remember);
  win.on('move', remember);

  const applyTheme = () => {
    if (win.isDestroyed()) return;
    const next = themeColors();
    win.setBackgroundColor(next.background);
    if (isWindows) win.setTitleBarOverlay({ color: next.background, symbolColor: next.symbol, height: TITLE_BAR_HEIGHT });
  };
  nativeTheme.on('updated', applyTheme);
  win.on('closed', () => nativeTheme.removeListener('updated', applyTheme));
  return win;
}

/**
 * A small always-on-top window in the corner above the taskbar that shows ringing calls even
 * when Sipper is hidden. It appears without taking focus, so typing elsewhere cannot answer a call.
 */
export class IncomingCallWindow {
  static WIDTH = 380;

  constructor({ preload, page }) {
    this.preload = preload;
    this.page = page;
    this.win = null;
    this.height = 164;
    this.ready = null;
  }

  #create() {
    const win = new BrowserWindow({
      width: IncomingCallWindow.WIDTH,
      height: this.height,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Incoming call',
      backgroundColor: themeColors().background,
      webPreferences: secureWebPreferences(this.preload),
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    if (!isWindows) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    lockNavigation(win);
    this.ready = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.loadURL(this.page);
    win.on('closed', () => {
      this.win = null;
    });
    this.win = win;
  }

  get webContents() {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  async present() {
    if (!this.win) this.#create();
    await this.ready;
    if (!this.win) return;
    if (!this.win.isVisible()) this.#place();
    this.win.showInactive();
  }

  /** Called by the page with its content height so the window fits its cards. */
  fit(height) {
    if (!this.win) return;
    const clamped = Math.max(120, Math.min(640, Math.ceil(height)));
    if (clamped === this.height) return;
    this.height = clamped;
    const bounds = this.win.getBounds();
    const bottom = bounds.y + bounds.height;
    this.win.setBounds({ x: bounds.x, y: bottom - clamped, width: IncomingCallWindow.WIDTH, height: clamped });
  }

  #place() {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.win.setBounds({
      x: workArea.x + workArea.width - IncomingCallWindow.WIDTH - 16,
      y: isWindows ? workArea.y + workArea.height - this.height - 16 : workArea.y + 12,
      width: IncomingCallWindow.WIDTH,
      height: this.height,
    });
  }

  hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
