// The only bridge between Sipper's windows and the main process. Windows run sandboxed with
// context isolation; they read state snapshots and ask the main process to act.

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'state', 'navigate', 'prefillDialer', 'command', 'ring', 'ringStop', 'logChanged', 'theme',
]);

contextBridge.exposeInMainWorld('sipper', {
  platform: process.platform,

  /** Every state key, as a plain object. */
  getState: () => ipcRenderer.invoke('state:get'),

  /** Calls an AppState action (the main process keeps the allow-list). */
  invoke: (method, ...args) => ipcRenderer.invoke('state:invoke', method, args),

  /** App services that are not AppState actions: dialogs, menus, files, the browser helper. */
  app: (action, ...args) => ipcRenderer.invoke('app:action', action, args),

  on: (channel, listener) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
