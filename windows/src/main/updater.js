// In-app updates for the installed Windows app. Releases on GitHub carry latest.yml, the
// installer and its blockmap; electron-updater checks them, downloads in the background and
// installs on restart. Development copies never update themselves.

const CHECK_EVERY = 6 * 60 * 60 * 1000;
const FIRST_CHECK_AFTER = 30 * 1000;

export class Updater {
  constructor({ app, state, send, quit, loadUpdater = async () => (await import('electron-updater')).default.autoUpdater }) {
    this.app = app;
    this.state = state;
    this.send = send;
    this.quit = quit;
    this.installRequested = false;
    this.loadUpdater = loadUpdater;
    this.supported = app.isPackaged && process.platform === 'win32' && process.env.SIPPER_DISABLE_UPDATES !== '1';
    this.status = { supported: this.supported, state: 'idle', version: null, percent: null, error: null, checkedAt: null };
    this.updater = null;
    this.checking = null;
  }

  snapshot() { return { ...this.status, currentVersion: this.app.getVersion() }; }

  #set(patch) {
    this.status = { ...this.status, ...patch };
    this.send(this.snapshot());
  }

  async start() {
    if (!this.supported) return;
    this.updater = await this.loadUpdater();
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.logger = { info: (m) => this.#log(m), warn: (m) => this.#log(m), error: (m) => this.#log(m), debug: () => {} };
    this.updater.on('checking-for-update', () => this.#set({ state: 'checking', error: null }));
    this.updater.on('update-not-available', () => this.#set({ state: 'upToDate', checkedAt: new Date().toISOString() }));
    this.updater.on('update-available', (info) => this.#set({ state: 'downloading', version: info.version, percent: 0, checkedAt: new Date().toISOString() }));
    this.updater.on('download-progress', (progress) => this.#set({ state: 'downloading', percent: Math.round(progress.percent) }));
    this.updater.on('update-downloaded', (info) => this.#set({ state: 'ready', version: info.version, percent: 100 }));
    this.updater.on('error', (error) => this.#set({ state: 'error', error: friendly(error) }));
    this.firstTimer = setTimeout(() => this.automaticCheck(), FIRST_CHECK_AFTER);
    this.timer = setInterval(() => this.automaticCheck(), CHECK_EVERY);
    this.firstTimer.unref?.();
    this.timer.unref?.();
  }

  automaticCheck() {
    if (this.state.settings.checkForUpdates && this.status.state !== 'ready') this.check().catch(() => {});
  }

  async check() {
    if (!this.updater) throw new Error('Updates are only available in the installed app.');
    if (this.status.state === 'ready') return this.snapshot();
    this.checking ??= this.updater.checkForUpdates()
      .then((result) => {
        // The download runs separately; its failure is reported through the error event.
        result?.downloadPromise?.catch(() => {});
        return result;
      })
      .finally(() => { this.checking = null; });
    await this.checking;
    return this.snapshot();
  }

  /**
   * Restarts into the downloaded version. Refused during a call so nobody is cut off. Sipper
   * quits normally first (engine, meetings, saved state); main.js then calls finishInstall().
   */
  install() {
    if (this.status.state !== 'ready') throw new Error('No update has been downloaded yet.');
    if (this.state.calls.length > 0) throw new Error('Finish your call first. The update installs when you restart Sipper.');
    this.installRequested = true;
    this.quit();
  }

  /** Called once shutdown has finished; returns false when there is nothing to install. */
  finishInstall() {
    if (!this.installRequested || !this.updater) return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  #log(message) { this.state.log.append(`Updates: ${String(message).split('\n')[0]}`); }
}

function friendly(error) {
  const text = String(error?.message ?? error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::/i.test(text)) return 'Could not reach the update server. Check your connection.';
  if (/404/.test(text)) return 'No update information was found for this version.';
  return 'The update check failed. Try again later.';
}
