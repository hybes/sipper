#!/usr/bin/env bash
# Builds Sipper for distribution outside the Mac App Store: a Release build signed with a
# Developer ID certificate, notarised by Apple and stapled, packed into a DMG that is signed,
# notarised and stapled as well. Output: dist/Sipper-<version>.dmg plus its SHA-256.
#
#   make release TEAM=ABCDE12345 NOTARY_PROFILE=sipper-notary
#   TEAM=ABCDE12345 NOTARY_PROFILE=sipper-notary tools/release.sh
#
# One-time setup (README › Releasing):
#   1. Create a "Developer ID Application" certificate: Xcode › Settings › Accounts › your team ›
#      Manage Certificates › + › Developer ID Application.
#   2. Store notarisation credentials in the Keychain (asks for an app-specific password):
#        xcrun notarytool store-credentials sipper-notary --apple-id <Apple ID> --team-id <TeamID>
#
# Without NOTARY_PROFILE the DMG is signed but not notarised. That only checks the packaging:
# Gatekeeper blocks un-notarised apps on other Macs. SIGN_IDENTITY picks a different certificate
# (default "Developer ID Application"); a full certificate name is needed when several match.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

team="${TEAM:-}"
profile="${NOTARY_PROFILE:-}"
identity_query="${SIGN_IDENTITY:-Developer ID Application}"
derived="$root/build/ReleaseDerivedData"
work="$root/build/release"
out="$root/dist"

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }

[ -n "$team" ] || fail "set TEAM to your Team ID (see the Makefile header for how to find it)"
[ -d Sipper.xcodeproj ] || fail "Sipper.xcodeproj is missing (run make project)"

# Resolve the full certificate name, preferring the one issued to $team.
identities="$(security find-identity -v -p codesigning \
  | sed -n 's/^ *[0-9]*) [0-9A-F]\{40\} "\(.*\)"$/\1/p' | grep -F "$identity_query" || true)"
identity="$(printf '%s\n' "$identities" | grep -F "($team)" | head -n 1 || true)"
if [ -z "$identity" ]; then
  count="$(printf '%s' "$identities" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    fail "no \"$identity_query\" certificate in the Keychain. Create one in Xcode › Settings › Accounts › Manage Certificates."
  elif [ "$count" -gt 1 ]; then
    printf '%s\n' "$identities" | sed 's/^/  /' >&2
    fail "several certificates match \"$identity_query\"; set SIGN_IDENTITY to one of the names above"
  fi
  identity="$identities"
fi

if [ -n "$profile" ]; then
  log "Checking notarisation credentials (Keychain profile \"$profile\")"
  xcrun notarytool history --keychain-profile "$profile" >/dev/null \
    || fail "notarytool cannot use the Keychain profile \"$profile\" (see the setup steps at the top of this script)"
else
  echo "warning: NOTARY_PROFILE is not set, so nothing will be notarised and Gatekeeper will block the app on other Macs." >&2
fi

log "Building Release, signed with \"$identity\""
# No injected base entitlements: they add get-task-allow, which notarisation rejects.
xcodebuild -project Sipper.xcodeproj -scheme Sipper -configuration Release -derivedDataPath "$derived" \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$team" CODE_SIGN_IDENTITY="$identity" PROVISIONING_PROFILE_SPECIFIER= \
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO OTHER_CODE_SIGN_FLAGS=--timestamp \
  clean build | tools/xcpretty-lite.sh

rm -rf "$work"
mkdir -p "$work" "$out"
app="$work/Sipper.app"
ditto "$derived/Build/Products/Release/Sipper.app" "$app"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
build_number="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")"

log "Checking Sipper $version ($build_number)"
codesign --verify --deep --strict --verbose=2 "$app"
details="$(codesign -dvv "$app" 2>&1)"
grep -q '^Timestamp=' <<<"$details" || fail "the signature has no secure timestamp, which notarisation rejects"
grep -q 'flags=.*runtime' <<<"$details" || fail "the hardened runtime is off, which notarisation rejects"
if codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q 'get-task-allow'; then
  fail "the app carries the get-task-allow entitlement, which notarisation rejects"
fi
[ -f "$app/Contents/Resources/Licenses/README.txt" ] || fail "the licence texts are missing from the bundle"

notarise() {
  local file="$1" result id status
  log "Notarising $(basename "$file") (usually a few minutes)"
  result="$(xcrun notarytool submit "$file" --keychain-profile "$profile" --wait --output-format json)" || true
  id="$(plutil -extract id raw -o - - <<<"$result" 2>/dev/null || true)"
  status="$(plutil -extract status raw -o - - <<<"$result" 2>/dev/null || true)"
  if [ "$status" != "Accepted" ]; then
    printf '%s\n' "$result" >&2
    if [ -n "$id" ]; then xcrun notarytool log "$id" --keychain-profile "$profile" >&2 || true; fi
    fail "notarisation of $(basename "$file") ended with status \"${status:-unknown}\""
  fi
  echo "Accepted (submission $id)"
}

if [ -n "$profile" ]; then
  ditto -c -k --keepParent "$app" "$work/Sipper.zip"
  notarise "$work/Sipper.zip"
  xcrun stapler staple "$app"
fi

dmg="$out/Sipper-$version.dmg"
log "Creating $(basename "$dmg")"
stage="$work/dmg"
mkdir -p "$stage"
ditto "$app" "$stage/Sipper.app"
ln -s /Applications "$stage/Applications"
rm -f "$dmg" "$dmg.sha256"
hdiutil create -quiet -volname "Sipper" -srcfolder "$stage" -format UDZO -ov "$dmg"
codesign --sign "$identity" --timestamp "$dmg"

if [ -n "$profile" ]; then
  notarise "$dmg"
  xcrun stapler staple "$dmg"
  log "Gatekeeper assessment"
  spctl --assess --type execute --verbose=2 "$app"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
fi

(cd "$out" && shasum -a 256 "$(basename "$dmg")" | tee "$(basename "$dmg").sha256")
log "Done: $dmg"
[ -n "$profile" ] || echo "Not notarised: fine for checking the DMG, not for publishing it."
