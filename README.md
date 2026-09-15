# Sipper

A SIP softphone built on [PJSIP](https://www.pjsip.org): a native macOS app in
SwiftUI, a Windows app ([windows/](windows/README.md)), and a Chrome extension that
adds SIP accounts to either straight from a FusionPBX web UI.

Download it from [sipper.dev](https://sipper.dev), or on a Mac install it with
[Homebrew](https://brew.sh):

```bash
brew install --cask hybes/tap/sipper
```

## What it does

- **Accounts and profiles.** Any number of SIP accounts, grouped into profiles
  (for example one per PBX or customer). Disable a profile to unregister every
  account in it. UDP, TCP and TLS transports, SRTP, STUN and ICE per account.
- **Calls.** Dial pad, hold, mute, DTMF (RFC 2833 with SIP INFO fallback), blind
  and attended transfer, several concurrent calls with swap, local ringback,
  incoming-call floating panel, notifications with Answer/Decline, Do Not
  Disturb, keyboard shortcuts (⌘N new call, ⌘↩ answer/hang up, ⌘⇧M mute, ⌘⇧H hold).
- **History and contacts.** Call log with direction/outcome filters, search and
  call-back; contacts with favourites that name incoming calls; voicemail (MWI)
  badges and a one-click voicemail call.
- **Incoming calls.** A floating alert on every Space (Answer with ⌘↩), a macOS
  notification with Answer/Decline buttons, a ringtone, optional auto-answer, and
  Do Not Disturb.
- **Call recording.** Record every call or press Record during a call; files are
  saved locally (WAV, converted to M4A) in a folder you choose and linked from the
  call history.
- **Links.** Sipper registers for `sip:`, `sips:` and `tel:` links: clicking a
  number in a web page or another app opens the dialer with it filled in and the
  matching account selected (choose Sipper as the handler when macOS asks).
- **Menu bar item** with registration state and quick actions; launch at login.
- **Import from the browser.** The extension hands accounts over through a
  `sipper://` link or, optionally, a native messaging helper.
- **iCloud sync** (optional) for profiles, accounts, contacts and history, with
  passwords carried by iCloud Keychain.
- Passwords live in the macOS Keychain; everything else is JSON in
  `~/Library/Application Support/Sipper/`.

## Sipper for Windows

The Windows app in `windows/` has the same accounts, profiles, calls, history,
contacts, recording and browser import, without iCloud sync. It is an Electron
app whose calls run in `sipper-engine`, a C port of the Mac engine around PJSIP.
It runs and is tested on a Mac as well; the installer is built on GitHub Actions
(`.github/workflows/windows.yml`). See [windows/README.md](windows/README.md) for
how it differs from the Mac app, development and releasing.

## Requirements

- macOS 14 or newer on Apple Silicon (the vendored PJSIP is built for arm64).
- Xcode 16 or newer (developed with Xcode 27) and XcodeGen (`brew install xcodegen`).

## Building

```bash
make pjsip          # once: downloads and builds pjproject 2.15.1 and opus 1.6.1 into vendor/ (about 3 minutes)
make app            # release build, ad-hoc signed, into dist/Sipper.app
make run            # build and open it
make test           # unit tests (XCTest)
make extension      # zips the Chrome extension into extension/dist
```

`make project` regenerates `Sipper.xcodeproj` from `project.yml`; open the
project in Xcode if you prefer to build there.

### Signing (and the Keychain prompts)

An ad-hoc signed build gets a new code signature every time it is built. macOS
ties each Keychain item to the signature of the app that created it, so every
rebuild makes the system ask whether the "new" Sipper may read the stored SIP
passwords. Signing with a development certificate gives a stable signature and
the prompts stop:

```bash
security find-identity -v -p codesigning        # lists "Apple Development: … (XXXXXXXXXX)"
make app TEAM=<TeamID>
```

The Team ID is the `OU` of the certificate
(`security find-certificate -c "Apple Development: …" -p | openssl x509 -noout -subject`).
A free personal team is enough for this.

### iCloud sync

iCloud needs a container entitlement, which needs a paid team:

1. In Xcode, open the project, select the Sipper target › Signing & Capabilities,
   choose your team and add the iCloud capability with iCloud Documents and the
   container `iCloud.com.hybes.sipper` (this registers the container).
2. Build with `make app TEAM=<TeamID> ICLOUD=1`, which signs with
   `Sipper/Sipper-iCloud.entitlements`.
3. In Sipper › Settings › iCloud, turn on sync. Passwords are synced by iCloud
   Keychain, so enable Passwords & Keychain in System Settings › Apple Account ›
   iCloud on every Mac.

Sync keeps one JSON document per collection in the app's iCloud container and
merges by record: the newest edit wins, deletions are remembered for 90 days,
iCloud conflict versions are merged rather than picked. Per-device settings
(audio devices, ports) are not synced. This part of the app has not been run
against a real iCloud account yet; the merge logic is covered by unit tests.

## Releasing

Builds for other people are signed with a Developer ID certificate and notarised
by Apple, so they open without a Gatekeeper warning. This needs a paid Apple
Developer Program membership.

One-time setup:

1. In Xcode › Settings › Accounts, select the team, click **Manage Certificates**
   and add a **Developer ID Application** certificate (only the team's Account
   Holder can create one).
2. Create an app-specific password at [account.apple.com](https://account.apple.com)
   (Sign-In and Security › App-Specific Passwords) and store it for `notarytool`:

   ```bash
   xcrun notarytool store-credentials sipper-notary --apple-id <Apple ID> --team-id <TeamID>
   ```

For each release, bump `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in
`project.yml`, then run:

```bash
make release TEAM=<TeamID> NOTARY_PROFILE=sipper-notary
```

It builds a clean Release, checks the signature (hardened runtime, secure
timestamp, no debugging entitlement), notarises and staples the app, then packs
`dist/Sipper-<version>.dmg`, notarises and staples that too and writes its
SHA-256 next to it. Each notarisation usually takes a few minutes. Without
`NOTARY_PROFILE` nothing is notarised, which is only useful for checking the
packaging.

Attach the DMG and its `.sha256` file to a GitHub release tagged `v<version>`,
then update the Homebrew cask:

```bash
make cask
```

It downloads the DMG from that release, checks it against the `.sha256` file and
commits the new version and checksum to `Casks/sipper.rb` in
[hybes/homebrew-tap](https://github.com/hybes/homebrew-tap), so
`brew upgrade --cask sipper` installs it. `VERSION=<version>` picks a release
other than the version in `project.yml`.

Release builds leave out iCloud sync (a Developer ID build with the iCloud
entitlement needs a provisioning profile) and carry the licence texts of every
bundled library in `Sipper.app/Contents/Resources/Licenses`. Because the app
includes PJSIP under the GPL, publish the matching source with each release:
this repository at the release tag and a source archive containing the exact
pjproject and Opus versions, their bundled dependencies, and build configuration.

## The Chrome extension

The extension lives in `extension/` (Manifest V3, no build step).

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**
   and pick the `extension` folder. Its ID is pinned to
   `gdijljkcflnaikcbjeahedncdgbceehp` (see `extension/EXTENSION_ID`).
2. In FusionPBX open **Accounts › Extensions**, then an extension, and click the
   Sipper toolbar icon. The popup shows the extension number, password, domain
   and server read from the page; adjust the transport or port if your PBX uses
   something other than UDP 5060 and click **Add to Sipper**. On the extensions
   list page you can select several extensions and add them all at once.
3. Chrome asks once whether to open Sipper. To skip that and let the extension
   detect Sipper, install the native messaging helper from Sipper › Settings ›
   Browser (it writes a small manifest for Chrome, Edge, Brave, Vivaldi, Arc and Helium).

It only runs when you click it, reads the current tab only, and sends data to
the local Sipper app only. Providers are pluggable (`extension/providers/`);
FusionPBX is the only one so far, with a generic fallback that pre-fills the host.

## Testing without a PBX

`tools/sip-test-server.py` is a small registrar and proxy for local testing (see
`tools/sip-test-server.md`). The pjsua command line client built alongside PJSIP
(`vendor/pjsip/bin/pjsua`) makes a handy second phone:

```bash
python3 tools/sip-test-server.py --user 1001:secret --user 1002:secret --answer-special --mwi 1001:2/5 -v
sleep 600 | vendor/pjsip/bin/pjsua --null-audio --auto-answer 200 --id sip:1002@sipper.test \
  --registrar sip:127.0.0.1:5070 --proxy "sip:127.0.0.1:5070;lr" --realm sipper.test \
  --username 1002 --password secret --local-port 5082
```

Then add `1001` / `secret` with domain `sipper.test`, server `127.0.0.1`, port
`5070` in Sipper and dial `1002`. TLS is on port 5071 with a self-signed
certificate (turn off Settings › Network › Verify TLS certificates to use it).

## Incoming calls and notifications

Settings › General shows whether macOS allows Sipper to post notifications and
offers a test notification. If the status is "turned off", enable Sipper under
System Settings › Notifications; without it only the floating alert and the
ringtone announce a call. Auto-answer (off by default) answers every incoming call
after the chosen delay, which is handy for intercom-style extensions but answers
calls on all accounts.

## Call recording

Settings › Recording turns on recording for every call, picks the folder
(default `~/Documents/Sipper Recordings`) and chooses whether recordings are
converted to M4A after the call (the raw file is a 16 kHz mono WAV, about
2 MB per minute). During a call the Record button starts or stops recording by
hand regardless of the setting. Recorded calls show a waveform icon in History
with Play, Show in Finder and Delete Recording actions. Recordings stay on the
Mac that made them and are never synced. Recording laws differ by country and
often require telling the other party.

## Diagnostics

Settings › Diagnostics shows the live PJSIP log (level configurable under
Network) and can save it to a file. Running the binary with
`SIPPER_LOG_STDERR=1` mirrors the log to stderr.

## Website

`website/` is sipper.dev: plain HTML and CSS in `website/public` with no build
step, served by a small Cloudflare Worker (`website/src/worker.js`) that
redirects www to the apex domain, adds security headers and answers
`sipper.dev/download`.

```bash
make site           # local server on http://localhost:8787 (installs wrangler on first run)
make site-deploy    # deploy to your authenticated Cloudflare account
```

For each release, attach the DMG from `make release` and the installer from the
Windows workflow to a GitHub release, set `MAC_DOWNLOAD_URL` and
`WINDOWS_DOWNLOAD_URL` in `website/wrangler.jsonc` to their URLs and run
`make site-deploy`. sipper.dev/download then sends each visitor to the file for
their computer (sipper.dev/download/mac and /download/windows pick one directly),
and the home page shows only that platform's button, with an Other downloads link
to Get Sipper (visitors on any other system see both).
While a URL is empty, that platform's link goes to the Get Sipper section and the
pages say it is coming soon; while both are empty the pages keep their
pre-release wording. `npm --prefix website test` checks the platform detection.

## Project layout

```
Sipper/                 macOS app (SwiftUI)
  SIP/                  pjsua wrapper (SIPEngine), bridging header and C shim
  State/                AppState (the model every view observes), menu bar, notifications
  Models/, Store/       persisted types, JSON store, Keychain
  Import/               sipper:// payload parsing (docs/PROTOCOL.md)
  Sync/                 iCloud sync service and merge engine
  Chrome/               native messaging host and installer
  Views/                windows, sheets, settings
SipperTests/            XCTest suite
extension/              Chrome extension and its tests (`node --test "extension/tests/*.test.mjs"`)
scripts/build-pjsip.sh  PJSIP build (static library into vendor/pjsip)
tools/                  test SIP server, icon generator, packaging helpers
docs/PROTOCOL.md        the hand-off contract between extension and app
website/                sipper.dev: static site and its Cloudflare Worker
windows/                Sipper for Windows: Electron app, PJSIP engine, installer (windows/README.md)
.github/workflows/      Windows build, tests and installer
```

## Licences

Copyright © 2026 Ben Hybert. Sipper is free software, licensed under the
GNU General Public License version 3 or, at your option, any later version
(SPDX: GPL-3.0-or-later). See [LICENSE](LICENSE). It is provided without warranty.

PJSIP is GPL-2.0-or-later; Opus and the other bundled libraries retain their own
licences. Their notices ship in `Sipper.app/Contents/Resources/Licenses`.
The public build excludes iLBC and iCloud sync.
