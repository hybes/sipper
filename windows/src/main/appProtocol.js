// Serves Sipper's pages from app://sipper/… instead of file://, as Electron's security guide
// recommends: pages get a real origin (so 'self' in the content security policy and ES module
// imports work) and only the renderer, shared core code and the UI library can be loaded.

import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_SCHEME = 'app';
export const APP_HOST = 'sipper';
export const RENDERER_BASE = `${APP_SCHEME}://${APP_HOST}/src/renderer/`;

const SERVED = ['src/renderer/', 'src/core/', 'node_modules/htm/', 'resources/'];

/** Must run before the app is ready. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function handleAppScheme(appRoot) {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const relative = path.posix.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (url.host !== APP_HOST || relative.includes('..') || !SERVED.some((prefix) => relative.startsWith(prefix))) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(path.join(appRoot, relative)).href);
  });
}

export const pageURL = (name) => `${RENDERER_BASE}${name}`;
