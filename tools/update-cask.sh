#!/usr/bin/env bash
# Points the Homebrew cask in hybes/homebrew-tap at a published Mac release, so
# `brew upgrade --cask sipper` installs it. Run it once the DMG is attached to the GitHub release.
#
#   make cask                  the version in project.yml
#   make cask VERSION=0.2.0
#   VERSION=0.2.0 tools/update-cask.sh
#
# It downloads the DMG from the v<version> release, checks it against the release's .sha256 file,
# updates Casks/sipper.rb in a fresh clone of the tap, commits as this repository's git user and
# pushes. TAP_REMOTE overrides the tap's git URL (default: origin with sipper swapped for homebrew-tap).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }

version="${VERSION:-$(sed -n 's/^ *MARKETING_VERSION: *"\([^"]*\)".*/\1/p' project.yml | head -n 1)}"
[ -n "$version" ] || fail "set VERSION (no MARKETING_VERSION in project.yml)"

origin="$(git remote get-url origin)"
tap_remote="${TAP_REMOTE:-$(printf '%s' "$origin" | sed -E 's#/sipper(\.git)?$#/homebrew-tap.git#')}"
[ "$tap_remote" != "$origin" ] || fail "cannot work out the tap's URL from origin ($origin); set TAP_REMOTE"

name="$(git config user.name || true)"
email="$(git config user.email || true)"
[ -n "$name" ] && [ -n "$email" ] || fail "set git user.name and user.email for this repository"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

dmg="Sipper-$version.dmg"
release="https://github.com/hybes/sipper/releases/download/v$version"
log "Downloading $dmg from the v$version release"
curl -fsSL -o "$work/$dmg" "$release/$dmg" || fail "the v$version release has no $dmg; publish it first"
curl -fsSL -o "$work/$dmg.sha256" "$release/$dmg.sha256" || fail "the v$version release has no $dmg.sha256"
sha="$(shasum -a 256 "$work/$dmg" | awk '{print $1}')"
[ "$sha" = "$(awk '{print $1}' "$work/$dmg.sha256")" ] || fail "$dmg does not match $dmg.sha256 on the release"

log "Updating Casks/sipper.rb in $tap_remote"
git clone --quiet --depth 1 "$tap_remote" "$work/tap"
sed -i '' -E "s/^  version \".*\"$/  version \"$version\"/; s/^  sha256 \".*\"$/  sha256 \"$sha\"/" "$work/tap/Casks/sipper.rb"
if git -C "$work/tap" diff --quiet; then
  echo "The cask already installs Sipper $version."
  exit 0
fi
git -C "$work/tap" --no-pager diff
git -C "$work/tap" -c user.name="$name" -c user.email="$email" commit --quiet -am "Update Sipper to $version"
git -C "$work/tap" push --quiet origin HEAD
log "Done: brew upgrade --cask sipper now installs Sipper $version"
