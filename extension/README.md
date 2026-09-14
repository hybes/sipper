# Sipper Chrome extension

Adds SIP accounts from a PBX web interface to the Sipper macOS app. Open an
extension in FusionPBX, click the Sipper toolbar button, check the details and
press **Add to Sipper**. On the extensions list you can pick several and add them
in one go. On any other page you can type an account in by hand.

Plain ES modules, no build step, no runtime dependencies.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension` folder.
4. Pin the Sipper button from the extensions menu if you want it always visible.

The manifest carries a fixed public key, so the extension ID is the same on every
machine that loads this folder:

    gdijljkcflnaikcbjeahedncdgbceehp

It is also stored in `EXTENSION_ID`. Sipper's native-messaging host manifest
allows exactly this origin (`chrome-extension://gdijljkcflnaikcbjeahedncdgbceehp/`), and Chrome remembers
the "always allow" choice for `sipper://` links against it, so keep the key.

Packaged builds: `tools/package-extension.sh` writes
`extension/dist/sipper-extension-<version>.zip` (version from `manifest.json`).

## Supported pages

| Page | What happens |
|---|---|
| FusionPBX **Accounts → Extensions → an extension** (`/app/extensions/extension_edit.php?id=…`) | Form pre-filled with the extension, password, caller ID name, domain and description. Edit anything, then add. |
| FusionPBX **Accounts → Extensions** list (`/app/extensions/extensions.php`) | Checklist of the extensions on the page. Each selected extension's edit page is fetched (with your FusionPBX session, same origin only) to read its password; up to 50 at a time. Rows that fail are listed. |
| Any other FusionPBX page | Tells you where to go. Manual entry is available. |
| Anything else | Manual entry, with the site's host name suggested as server and domain. |

FusionPBX versions: the markup of master/5.5 and 4.4.1 is covered by the tests
(domain select, hidden `domain_uuid` with the header domain selector, extension
shown as text when the user lacks `extension_extension`, textarea description,
`show=all` Domain column). Your FusionPBX user needs the `extension_password`
permission to see passwords; without it the form asks you to type one.

How the fields map:

* **Username / extension** – the extension number (also the SIP auth user).
* **Domain** – the FusionPBX domain: the Domain select on the page, else the domain
  shown in the header, else a host-name-like User Context, else the web host.
* **Server** – the FusionPBX web host by default; change it if SIP goes elsewhere.
* **Port / Transport** – UDP 5060 by default; remembered per host after you change them.
* **Profile** – the group the accounts go into in Sipper (the domain by default).

## Privacy

* The extension has no background process and no host permissions. It runs only
  when you click its button, and only reads the tab that is open at that moment
  (`activeTab`).
* On the extensions list it fetches other pages of the same site, with the same
  session Chrome already has, only for the extensions you tick.
* Data goes to the local Sipper app and nowhere else. Nothing is sent to any server
  and nothing is logged. Passwords are handed to Sipper, which stores them in the
  macOS Keychain.
* `chrome.storage.local` keeps only the last port/transport/server you chose per
  PBX host. No passwords are stored by the extension.

## How the hand-off works

The popup builds the document described in `docs/PROTOCOL.md` (`version: 1`,
`source`, `profile`, `accounts[]`). Then:

1. If Sipper's native-messaging host (`com.hybes.sipper`, installed from Sipper →
   Settings → Browser extension) answers a `ping`, the document is sent to it as
   `{ "type": "add-accounts", "payload": … }` and the popup shows Sipper's reply.
2. Otherwise the document is base64url-encoded into
   `sipper://add-accounts?payload=…` and opened in the current tab with
   `chrome.tabs.update`. Chrome asks whether to open Sipper the first time; the
   page you were on stays where it is and nothing is added to history. If Sipper
   is not installed, nothing happens.

The footer of the popup tells you which of the two will be used. **Copy as JSON**
puts the same document on the clipboard for debugging.

## Development

    cd extension
    npm install          # jsdom for the tests only
    npm test             # node --test "tests/*.test.mjs"

`page.js` holds the only code that runs inside the web page (two self-contained
functions injected with `chrome.scripting.executeScript`). Everything else runs
in the popup: `providers/` detect and scrape a parsed document, `payload.js`
builds and encodes the hand-off. To support another PBX, add a provider module
with `detect`, `scrapeEditPage` and `scrapeListPage` and list it in
`providers/index.js`.
