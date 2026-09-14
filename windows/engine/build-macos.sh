#!/usr/bin/env bash
# Builds sipper-engine and sipper-browser-host for macOS against the vendored PJSIP (make pjsip at
# the repository root), so the Windows app can be developed and tested on a Mac. Writes
# windows/engine/build/.
#
#   windows/engine/build-macos.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
pjsip="$root/vendor/pjsip"
out="$here/build"

[ -f "$pjsip/lib/libpjproject.a" ] || { echo "error: $pjsip/lib/libpjproject.a not found (run make pjsip in $root)" >&2; exit 1; }
mkdir -p "$out"

version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$here/../package.json")"
printf '#define SIPPER_VERSION "%s"\n' "$version" > "$out/sipper_version.h"

cflags=(-O2 -Wall -Wextra -Wno-unused-parameter -Wno-sign-compare -Wno-missing-field-initializers
        -I"$here/third_party/cjson" -I"$out" -mmacosx-version-min=14.0)
libs=(-L"$pjsip/lib" -lpjproject -lc++
      -framework CoreAudio -framework CoreServices -framework AudioUnit -framework AudioToolbox
      -framework Foundation -framework AppKit -framework Security -framework AVFoundation)

cc "${cflags[@]}" -DPJ_AUTOCONF=1 -I"$pjsip/include" "$here/src/engine.c" "$here/third_party/cjson/cJSON.c" "${libs[@]}" -o "$out/sipper-engine"
cc "${cflags[@]}" "$here/src/native_host.c" "$here/third_party/cjson/cJSON.c" -o "$out/sipper-browser-host"
echo "Built $out/sipper-engine and $out/sipper-browser-host"
