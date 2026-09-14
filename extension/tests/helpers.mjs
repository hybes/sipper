import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

export const EXT_ROOT = new URL('../', import.meta.url);

export function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

// Full jsdom document, the way a live page would be.
export function load(name, url) {
  const dom = new JSDOM(fixture(name), { url });
  return { doc: dom.window.document, url: new URL(url), window: dom.window };
}

// DOMParser document, the way the popup parses captured HTML.
export function parse(html, url) {
  const dom = new JSDOM('');
  const doc = new dom.window.DOMParser().parseFromString(html, 'text/html');
  return { doc, url: new URL(url), window: dom.window };
}

export const UUID1 = '3f6c2a1e-5b7d-4c8e-9a0b-1c2d3e4f5a6b';
export const UUID2 = '4a7d3b2f-6c8e-4d9f-8b1c-2d3e4f5a6b7c';
export const UUID3 = '5b8e4c3a-7d9f-4e0a-9c2d-3e4f5a6b7c8d';
export const HOST = 'https://pbx.example.com';
export const editURL = (uuid, extra = '') => `${HOST}/app/extensions/extension_edit.php?id=${uuid}${extra}`;
export const listURL = (extra = '') => `${HOST}/app/extensions/extensions.php${extra}`;
