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

export function handleAppScheme(appRoot, registry = protocol, meetingPolicy = () => "default-src 'none'") {
  registry.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const relative = path.posix.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (url.host !== APP_HOST || relative.includes('..') || !(SERVED.some((prefix) => relative.startsWith(prefix)) || relative === 'node_modules/livekit-client/dist/livekit-client.umd.js')) {
      return new Response('Not found', { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(path.join(appRoot, relative)).href);
    if (relative !== 'src/renderer/meeting.html') return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', meetingPolicy(url.searchParams.get('room')));
    headers.set('Cache-Control', 'no-store');
    headers.set('Permissions-Policy', 'geolocation=(), payment=(), usb=()');
    return new Response(response.body, { status: response.status, headers });
  });
}

export const pageURL = (name) => `${RENDERER_BASE}${name}`;
