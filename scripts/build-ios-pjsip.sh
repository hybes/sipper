#!/usr/bin/env bash
# Isolated arm64 device/simulator builds. Never reconfigures the Mac's vendor tree.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="$root/ios/vendor"
jobs="${JOBS:-$(sysctl -n hw.ncpu)}"
minimum="${IPHONEOS_DEPLOYMENT_TARGET:-16.0}"
mkdir -p "$vendor/downloads"

download() {
  local url="$1" file="$2" checksum="$3"
  if ! [ -f "$file" ] || ! echo "$checksum  $file" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl --fail --location --retry 2 --connect-timeout 20 --max-time 180 "$url" --output "$file"
  fi
  echo "$checksum  $file" | shasum -a 256 -c -
}
download https://github.com/pjsip/pjproject/archive/refs/tags/2.15.1.tar.gz \
  "$vendor/downloads/pjproject-2.15.1.tar.gz" 8f3bd99caf003f96ed8038b8a36031eb9d8cd9eaea1eaff7e01c2eef6bd55706
download https://ftp.osuosl.org/pub/xiph/releases/opus/opus-1.6.1.tar.gz \
  "$vendor/downloads/opus-1.6.1.tar.gz" 6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1

case "${1:-all}" in
  all) sdks=(iphonesimulator iphoneos) ;;
  simulator) sdks=(iphonesimulator) ;;
  device) sdks=(iphoneos) ;;
  *) echo 'Usage: scripts/build-ios-pjsip.sh [all|simulator|device]' >&2; exit 2 ;;
esac

for sdk in "${sdks[@]}"; do
  sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"
  developer="$(xcrun --sdk "$sdk" --show-sdk-platform-path)/Developer"
  work="$vendor/build-$sdk"
  prefix="$vendor/pjsip/$sdk"
  if [ "$sdk" = iphoneos ]; then deployment="-miphoneos-version-min=$minimum"
  else deployment="-mios-simulator-version-min=$minimum"; fi
  flags="-O2 -arch arm64 -isysroot $sdk_path $deployment"
  # These are this script's generated outputs, never the desktop libraries or app data.
  rm -rf "$work" "$prefix"
  mkdir -p "$work" "$prefix"
  tar -xzf "$vendor/downloads/pjproject-2.15.1.tar.gz" -C "$work"
  tar -xzf "$vendor/downloads/opus-1.6.1.tar.gz" -C "$work"
  (
    cd "$work/opus-1.6.1"
    CC="$(xcrun --sdk "$sdk" -f clang)" CFLAGS="$flags" LDFLAGS="$flags" \
      ./configure --host=aarch64-apple-darwin --prefix="$work/opus" \
      --enable-static --disable-shared --disable-doc --disable-extra-programs
    make -j"$jobs"
    make install
  )
  src="$work/pjproject-2.15.1"
  patch -d "$src" -p1 --forward < "$root/scripts/patches/pjsip-apple-sha256.patch"
  cat > "$src/pjlib/include/pj/config_site.h" <<'CONFIG'
#define PJ_CONFIG_IPHONE 1
#include <pj/config_site_sample.h>
#define PJ_HAS_IPV6 1
#define PJMEDIA_HAS_VIDEO 0
#define PJ_HAS_SSL_SOCK 1
#define PJ_SSL_SOCK_IMP PJ_SSL_SOCK_IMP_APPLE
#undef PJSUA_MAX_ACC
#define PJSUA_MAX_ACC 32
#undef PJSUA_MAX_CALLS
#define PJSUA_MAX_CALLS 32
/* Override the sample's optional iLBC codec, matching the desktop distribution. */
#undef PJMEDIA_HAS_ILBC_CODEC
#define PJMEDIA_HAS_ILBC_CODEC 0
#define PJSIP_TCP_KEEP_ALIVE_INTERVAL 30
#define PJSIP_TLS_KEEP_ALIVE_INTERVAL 30
CONFIG
  (
    cd "$src"
    DEVPATH="$developer" IPHONESDK="$sdk_path" ARCH="-arch arm64" MIN_IOS="$deployment" \
      CFLAGS="-O2" LDFLAGS="-O2 -framework Network -framework Security" CPPFLAGS="-Wno-deprecated-declarations -Wno-uninitialized" \
      ./configure-iphone --prefix="$prefix" --with-opus="$work/opus" \
      --disable-video --disable-ffmpeg --disable-sdl --disable-openh264 --disable-libyuv \
      --disable-vpx --disable-v4l2 --disable-darwin-ssl --disable-opencore-amr --disable-silk \
      --disable-ilbc-codec --disable-g7221-codec
    make dep
    for directory in pjlib pjlib-util pjnath third_party pjmedia pjsip; do
      make -j"$jobs" -C "$directory/build" || make -C "$directory/build"
    done
    make install
  )
  xcrun libtool -static -o "$prefix/lib/libpjproject.a" "$prefix"/lib/lib*.a "$work/opus/lib/libopus.a"
  xcrun nm -gU "$prefix/lib/libpjproject.a" | grep ' T _pj_ssl_sock_create$' >/dev/null
  licences="$prefix/Licenses"
  mkdir -p "$licences"
  cp "$root/LICENSE" "$licences/Sipper.txt"
  cp "$src/COPYING" "$licences/PJSIP.txt"
  cp "$work/opus-1.6.1/COPYING" "$licences/Opus.txt"
  cp "$src/third_party/srtp/LICENSE" "$licences/libsrtp.txt"
  cp "$src/third_party/speex/COPYING" "$licences/Speex.txt"
  cp "$src/third_party/gsm/COPYRIGHT" "$licences/GSM.txt"
  cp "$src/third_party/resample/COPYING" "$licences/libresample.txt"
  cp "$src/third_party/webrtc/LICENSE" "$licences/WebRTC.txt"
  cp "$src/third_party/webrtc/LICENSE_THIRD_PARTY" "$licences/WebRTC-third-party.txt"
  cp "$root"/packages/SipperManaged/Sources/SipperManaged/Resources/Licenses/* "$licences/"
  printf 'PJSIP 2.15.1; Opus 1.6.1; arm64 %s; minimum iOS %s\n' "$sdk" "$minimum" > "$prefix/BUILD-INFO.txt"
  shasum -a 256 "$root/scripts/patches/pjsip-apple-sha256.patch" >> "$prefix/BUILD-INFO.txt"
done
