#!/usr/bin/env bash
# Packages the Chrome extension into extension/dist/sipper-extension-<version>.zip.
# The version is read from extension/manifest.json. Tests, dev tooling and previous
# builds are left out; README.md and EXTENSION_ID are included.
#
#   tools/package-extension.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ext="$root/extension"
manifest="$ext/manifest.json"

[ -f "$manifest" ] || { echo "error: $manifest not found" >&2; exit 1; }
command -v zip >/dev/null || { echo "error: zip is not installed" >&2; exit 1; }

if command -v node >/dev/null; then
  version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$manifest")"
else
  version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
fi
[ -n "$version" ] || { echo "error: could not read \"version\" from $manifest" >&2; exit 1; }

out_dir="$ext/dist"
out="$out_dir/sipper-extension-$version.zip"
mkdir -p "$out_dir"
rm -f "$out"

(
  cd "$ext"
  zip -r -X -q "$out" . \
    -x 'dist/*' 'tests/*' 'node_modules/*' \
       'package.json' 'package-lock.json' \
       '*.zip' '*.DS_Store' '.*'
)

echo "Wrote $out"
unzip -Z1 "$out" | sed 's/^/  /'
