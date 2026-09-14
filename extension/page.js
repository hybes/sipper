// Functions that run inside the current tab through chrome.scripting.executeScript({ func }).
//
// Chrome serialises the function source and re-evaluates it in the page's isolated world,
// so each function here must be self-contained: no imports, no references to anything
// else in this module. They return plain JSON only. All parsing happens in the popup
// (see popup.js and providers/), which keeps the DOM logic testable under Node.

// Snapshot of the current page. Live form values are copied onto a clone so the
// serialised HTML reflects what the user sees, without touching the real page.
export function capturePage() {
  const root = document.documentElement;
  if (!root) return { url: location.href, title: document.title, html: '' };
  const clone = root.cloneNode(true);
  const live = root.querySelectorAll('input, select, textarea');
  const copies = clone.querySelectorAll('input, select, textarea');
  if (live.length === copies.length) {
    for (let i = 0; i < live.length; i += 1) {
      const src = live[i];
      const dst = copies[i];
      const tag = src.tagName;
      if (tag === 'SELECT') {
        for (let j = 0; j < src.options.length; j += 1) {
          if (src.options[j].selected) dst.options[j].setAttribute('selected', 'selected');
          else dst.options[j].removeAttribute('selected');
        }
      } else if (tag === 'TEXTAREA') {
        dst.textContent = src.value;
      } else if (src.type === 'checkbox' || src.type === 'radio') {
        if (src.checked) dst.setAttribute('checked', 'checked');
        else dst.removeAttribute('checked');
      } else if (src.type !== 'file') {
        dst.setAttribute('value', src.value);
      }
    }
  }
  return {
    url: location.href,
    title: document.title,
    html: clone.outerHTML,
    readyState: document.readyState,
  };
}

// Same-origin fetch with the page's cookies. Runs in the page so the PBX session applies;
// cross-origin targets are refused rather than leaking the request elsewhere.
export async function fetchSameOrigin(url) {
  try {
    const target = new URL(url, location.href);
    if (target.origin !== location.origin) {
      return { ok: false, status: 0, url: target.href, error: 'Not on this site' };
    }
    const response = await fetch(target.href, { credentials: 'same-origin', redirect: 'follow', cache: 'no-store' });
    const html = await response.text();
    return { ok: response.ok, status: response.status, url: response.url || target.href, html };
  } catch (error) {
    return { ok: false, status: 0, url: String(url), error: String((error && error.message) || error) };
  }
}
