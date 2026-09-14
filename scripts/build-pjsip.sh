#!/usr/bin/env bash
# Builds PJSIP (pjproject) and the Opus codec from source for macOS and installs headers
# plus a single merged static library into vendor/pjsip. Re-run safely; sources are cached.
#
#   scripts/build-pjsip.sh            # build pjproject 2.15.1 with opus 1.6.1 (default)
#   PJSIP_VERSION=2.15.1 JOBS=8 scripts/build-pjsip.sh
#   OPUS_VERSION=… OPUS_SHA256=… scripts/build-pjsip.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PJSIP_VERSION="${PJSIP_VERSION:-2.15.1}"
VENDOR="$ROOT/vendor"
SRC="$VENDOR/pjproject-$PJSIP_VERSION"
PREFIX="$VENDOR/pjsip"
MIN_MACOS="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"
ARCH="$(uname -m)"

log() { printf '\n==> %s\n' "$*"; }

mkdir -p "$VENDOR"

if [ ! -d "$SRC" ]; then
  log "Downloading pjproject $PJSIP_VERSION"
  curl -L --fail --retry 3 -o "$VENDOR/pjproject-$PJSIP_VERSION.tar.gz" \
    "https://github.com/pjsip/pjproject/archive/refs/tags/$PJSIP_VERSION.tar.gz"
  tar -xzf "$VENDOR/pjproject-$PJSIP_VERSION.tar.gz" -C "$VENDOR"
  rm -f "$VENDOR/pjproject-$PJSIP_VERSION.tar.gz"
fi

# Opus codec, built as a static library with the same deployment target as everything else
# (a Homebrew bottle targets the build Mac's macOS version, which breaks older systems) and
# merged into libpjproject.a below.
OPUS_VERSION="${OPUS_VERSION:-1.6.1}"
OPUS_SHA256="${OPUS_SHA256:-6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1}"
OPUS_SRC="$VENDOR/opus-$OPUS_VERSION"
OPUS_PREFIX="$VENDOR/opus"

if [ ! -d "$OPUS_SRC" ]; then
  log "Downloading opus $OPUS_VERSION"
  OPUS_TARBALL="$VENDOR/opus-$OPUS_VERSION.tar.gz"
  # The OSU Open Source Lab mirror is where downloads.xiph.org usually redirects; the
  # redirector is tried second in case it points elsewhere. Every copy must match the
  # checksum, and stalled transfers are abandoned so a slow mirror falls through.
  for url in "https://ftp.osuosl.org/pub/xiph/releases/opus/opus-$OPUS_VERSION.tar.gz" \
             "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz"; do
    rm -f "$OPUS_TARBALL"
    if curl -L --fail --retry 2 --connect-timeout 20 --speed-limit 1024 --speed-time 30 -o "$OPUS_TARBALL" "$url" \
       && echo "$OPUS_SHA256  $OPUS_TARBALL" | shasum -a 256 -c - >/dev/null 2>&1; then
      break
    fi
    echo "warning: no verified copy from $url" >&2
    rm -f "$OPUS_TARBALL"
  done
  if [ ! -f "$OPUS_TARBALL" ]; then
    echo "error: could not download opus-$OPUS_VERSION.tar.gz matching OPUS_SHA256 (set it when changing OPUS_VERSION)." >&2
    exit 1
  fi
  tar -xzf "$OPUS_TARBALL" -C "$VENDOR"
  rm -f "$OPUS_TARBALL"
fi

log "Building opus $OPUS_VERSION ($ARCH, macOS >= $MIN_MACOS)"
(
  cd "$OPUS_SRC"
  if [ -f Makefile ]; then make distclean >/dev/null 2>&1 || true; fi
  ./configure --prefix="$OPUS_PREFIX" --enable-static --disable-shared --disable-doc --disable-extra-programs \
    CFLAGS="-O2 -mmacosx-version-min=$MIN_MACOS -arch $ARCH" LDFLAGS="-mmacosx-version-min=$MIN_MACOS -arch $ARCH"
  make -j"$JOBS"
  rm -rf "$OPUS_PREFIX"
  make install
)
cp "$OPUS_SRC/COPYING" "$OPUS_PREFIX/COPYING"

log "Writing config_site.h"
cat > "$SRC/pjlib/include/pj/config_site.h" <<'CFG'
/* Sipper: PJSIP build configuration for a desktop softphone. */
#define PJ_HAS_IPV6 1
#define PJMEDIA_HAS_VIDEO 0
#define PJSUA_MAX_ACC 32
#define PJSUA_MAX_CALLS 32
#define PJMEDIA_AUDIO_DEV_HAS_COREAUDIO 1
#define PJMEDIA_AUDIO_DEV_HAS_PORTAUDIO 0
#define PJSIP_TCP_KEEP_ALIVE_INTERVAL 30
#define PJSIP_TLS_KEEP_ALIVE_INTERVAL 30
CFG

cd "$SRC"
export CFLAGS="-O2 -mmacosx-version-min=$MIN_MACOS -arch $ARCH"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-mmacosx-version-min=$MIN_MACOS -arch $ARCH"
# The configure probe for the Darwin (SecureTransport) TLS backend compiles a
# deprecated call with -Werror and would otherwise fail on current SDKs.
export CPPFLAGS="-Wno-deprecated-declarations -Wno-uninitialized"

if [ -f build.mak ]; then
  log "Cleaning previous build"
  make distclean >/dev/null 2>&1 || true
fi

CONFIGURE_ARGS=(
  --prefix="$PREFIX"
  --disable-video --disable-ffmpeg --disable-sdl --disable-openh264
  --disable-libyuv --disable-vpx --disable-v4l2 --disable-darwin-video
  --disable-opencore-amr --disable-silk --disable-ilbc-codec --disable-g7221-codec
)
if [ -n "$OPUS_PREFIX" ]; then
  CONFIGURE_ARGS+=(--with-opus="$OPUS_PREFIX")
fi

log "Configuring ($ARCH, macOS >= $MIN_MACOS)"
./configure "${CONFIGURE_ARGS[@]}"

if ! grep -q 'define PJ_SSL_SOCK_IMP PJ_SSL_SOCK_IMP_DARWIN' pjlib/include/pj/compat/os_auto.h; then
  echo "error: configure did not enable the Darwin TLS backend; SIP over TLS would be unavailable." >&2
  exit 1
fi

log "Building dependencies"
make dep

log "Building libraries with $JOBS jobs"
for d in pjlib pjlib-util pjnath third_party pjmedia pjsip; do
  # A parallel build can race on output sub-directories; a sequential pass finishes it.
  make -j"$JOBS" -C "$d/build" || make -C "$d/build"
done

log "Installing into $PREFIX"
rm -rf "$PREFIX"
make install

log "Building pjsua CLI (used as a local test peer; failure is non-fatal)"
if make -j"$JOBS" -C pjsip-apps/build pjsua; then
  mkdir -p "$PREFIX/bin"
  cp -f pjsip-apps/bin/pjsua-* "$PREFIX/bin/pjsua" 2>/dev/null || true
fi

log "Merging static libraries into libpjproject.a"
MERGE=()
for f in "$PREFIX"/lib/lib*.a; do
  case "$f" in *libpjproject.a) ;; *) MERGE+=("$f") ;; esac
done
if [ -n "$OPUS_PREFIX" ] && [ -f "$OPUS_PREFIX/lib/libopus.a" ]; then
  MERGE+=("$OPUS_PREFIX/lib/libopus.a")
fi
libtool -static -o "$PREFIX/lib/libpjproject.a" "${MERGE[@]}" 2>&1 | grep -v 'same member name' || true

{
  echo "pjproject $PJSIP_VERSION for $ARCH, macOS >= $MIN_MACOS"
  echo "opus: $OPUS_VERSION"
  echo
  echo "--- libpjproject.pc ---"
  cat "$PREFIX/lib/pkgconfig/libpjproject.pc"
} > "$PREFIX/BUILD-INFO.txt"

log "Done. Library: $PREFIX/lib/libpjproject.a"
cat "$PREFIX/BUILD-INFO.txt"
