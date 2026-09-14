#!/usr/bin/env bash
# Copies the licence texts of Sipper and of the libraries linked into it into the app bundle
# (Contents/Resources/Licenses). Runs as a build phase of the Sipper target (project.yml), so
# the files are in place before Xcode signs the app. Needs the vendored PJSIP build (make pjsip).
#
#   tools/copy-licences.sh [destination]    # destination defaults to the bundle being built
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${1:-${TARGET_BUILD_DIR:?}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}/Licenses}"
info="$root/vendor/pjsip/BUILD-INFO.txt"

fail() { echo "error: $*" >&2; exit 1; }

[ -f "$info" ] || fail "$info not found (run make pjsip)"
pjsip_version="$(awk 'NR == 1 { print $2 }' "$info")"
src="$root/vendor/pjproject-$pjsip_version"
[ -d "$src" ] || fail "PJSIP sources not found at $src (run make pjsip)"
opus_version="$(sed -n 's/^opus: //p' "$info")"

copy() {
  [ -f "$1" ] || fail "licence file missing: $1"
  cp "$1" "$dest/$2"
}

rm -rf "$dest"
mkdir -p "$dest"

copy "$root/LICENSE" Sipper.txt
copy "$src/COPYING" PJSIP.txt
copy "$src/third_party/srtp/LICENSE" libsrtp.txt
copy "$src/third_party/speex/COPYING" Speex.txt
copy "$src/third_party/gsm/COPYRIGHT" GSM.txt
copy "$src/third_party/resample/COPYING" libresample.txt
{ cat "$src/third_party/webrtc/LICENSE"; printf '\n\n'; cat "$src/third_party/webrtc/LICENSE_THIRD_PARTY"; } > "$dest/WebRTC.txt"

opus_line=""
if [ -n "$opus_version" ] && [ "$opus_version" != none ]; then
  copy "$root/vendor/opus/COPYING" Opus.txt
  opus_line="Opus $opus_version|BSD 3-clause, with royalty-free patent licences|Opus.txt"
fi

{
  echo "Sipper includes the software below. The full licence texts are in this folder."
  echo
  {
    echo "Component|Licence|File"
    echo "Sipper|GNU GPL version 3 or later|Sipper.txt"
    echo "PJSIP (pjproject $pjsip_version)|GNU GPL version 2 or later|PJSIP.txt"
    if [ -n "$opus_line" ]; then echo "$opus_line"; fi
    echo "libsrtp (Cisco Systems)|BSD 3-clause|libsrtp.txt"
    echo "Speex (Xiph.Org Foundation)|BSD 3-clause|Speex.txt"
    echo "WebRTC echo canceller|BSD 3-clause|WebRTC.txt"
    echo "libresample|GNU LGPL version 2.1|libresample.txt"
    echo "GSM 06.10 (TU Berlin)|notice-preserving permissive licence|GSM.txt"
  } | column -t -s '|'
  echo
  echo "PJSIP source: https://github.com/pjsip/pjproject/tree/$pjsip_version"
} > "$dest/README.txt"
