#!/usr/bin/env bash
# Builds official PJSUA2 Java/JNI bindings without touching another platform's vendor tree.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="$root/android/vendor"
ndk="${ANDROID_NDK_ROOT:?Set ANDROID_NDK_ROOT to an installed NDK r28 or later}"
java_home="${JAVA_HOME:-}"
jobs="${JOBS:-8}"
api=26
case "$(uname -s)" in
  Darwin) toolchain="$ndk/toolchains/llvm/prebuilt/darwin-x86_64"; java_home="${java_home:-$(/usr/libexec/java_home -v 17)}" ;;
  Linux) toolchain="$ndk/toolchains/llvm/prebuilt/linux-x86_64" ;;
  *) echo 'Build Android libraries on macOS or Linux.' >&2; exit 2 ;;
esac
[ -x "$java_home/bin/javac" ] || { echo 'Set JAVA_HOME to a JDK 17 installation.' >&2; exit 2; }
command -v swig >/dev/null || { echo 'Install SWIG first.' >&2; exit 2; }
mkdir -p "$vendor/downloads"
download() {
  local url="$1" file="$2" checksum="$3"
  if ! [ -f "$file" ] || ! echo "$checksum  $file" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl --fail --location --retry 2 --connect-timeout 20 --max-time 240 "$url" --output "$file"
  fi
  echo "$checksum  $file" | shasum -a 256 -c -
}
download https://github.com/pjsip/pjproject/archive/refs/tags/2.15.1.tar.gz \
  "$vendor/downloads/pjproject-2.15.1.tar.gz" 8f3bd99caf003f96ed8038b8a36031eb9d8cd9eaea1eaff7e01c2eef6bd55706
download https://ftp.osuosl.org/pub/xiph/releases/opus/opus-1.6.1.tar.gz \
  "$vendor/downloads/opus-1.6.1.tar.gz" 6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
download https://github.com/openssl/openssl/releases/download/openssl-3.5.8/openssl-3.5.8.tar.gz \
  "$vendor/downloads/openssl-3.5.8.tar.gz" a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2
case "${1:-all}" in
  all) abis=(arm64-v8a x86_64) ;;
  arm64-v8a|x86_64) abis=("$1") ;;
  *) echo 'Usage: scripts/build-android-pjsip.sh [all|arm64-v8a|x86_64]' >&2; exit 2 ;;
esac
for abi in "${abis[@]}"; do
  case "$abi" in
    arm64-v8a) host=aarch64-linux-android; ssl_target=android-arm64 ;;
    x86_64) host=x86_64-linux-android; ssl_target=android-x86_64 ;;
  esac
  work="$vendor/build-$abi"
  prefix="$vendor/pjsip"
  # This directory contains only this builder's generated intermediate files.
  rm -rf "$work"
  mkdir -p "$work" "$prefix/java" "$prefix/jniLibs/$abi" "$prefix/assets/Licenses"
  for archive in pjproject-2.15.1 opus-1.6.1 openssl-3.5.8; do
    tar -xzf "$vendor/downloads/$archive.tar.gz" -C "$work"
  done
  (
    cd "$work/openssl-3.5.8"
    export ANDROID_NDK_ROOT="$ndk" PATH="$toolchain/bin:$PATH"
    ./Configure "$ssl_target" -D__ANDROID_API__="$api" no-shared no-tests no-module \
      --prefix="$work/openssl" --libdir=lib
    make -j"$jobs" build_libs
    make install_dev
  )
  (
    cd "$work/opus-1.6.1"
    CC="$toolchain/bin/${host}${api}-clang" AR="$toolchain/bin/llvm-ar" RANLIB="$toolchain/bin/llvm-ranlib" \
      CFLAGS='-O2 -fPIC' ./configure --host="$host" --prefix="$work/opus" \
      --enable-static --disable-shared --disable-doc --disable-extra-programs
    make -j"$jobs"
    make install
  )
  src="$work/pjproject-2.15.1"
  patch -d "$src" -p1 < "$root/android/patches/pjsip-clear-stun.patch"
  cat > "$src/pjlib/include/pj/config_site.h" <<'CONFIG'
#define PJ_CONFIG_ANDROID 1
#include <pj/config_site_sample.h>
#define PJ_HAS_IPV6 1
#define PJMEDIA_HAS_VIDEO 0
#undef PJMEDIA_HAS_ILBC_CODEC
#define PJMEDIA_HAS_ILBC_CODEC 0
#undef PJSUA_MAX_ACC
#define PJSUA_MAX_ACC 32
#undef PJSUA_MAX_CALLS
#define PJSUA_MAX_CALLS 32
CONFIG
  (
    cd "$src"
    ANDROID_NDK_ROOT="$ndk" APP_PLATFORM="android-$api" TARGET_ABI="$abi" \
      CFLAGS='-O2 -fPIC' LDFLAGS='-Wl,-z,max-page-size=16384' \
      ./configure-android --use-ndk-cflags --with-ssl="$work/openssl" --with-opus="$work/opus" \
      --disable-video --disable-sdl --disable-ffmpeg --disable-openh264 --disable-libyuv \
      --disable-vpx --disable-ilbc-codec --disable-g7221-codec --disable-opencore-amr --disable-silk \
      --disable-android-mediacodec
    make dep
    # The upstream object-directory rules can race under parallel Apple make.
    for directory in pjlib pjlib-util pjnath third_party pjmedia pjsip; do
      make -j"$jobs" -C "$directory/build" || make -C "$directory/build"
    done
    JAVA_HOME="$java_home" make -C pjsip-apps/src/swig/java
  )
  bindings="$src/pjsip-apps/src/swig/java/android/pjsua2/src/main"
  cp -R "$bindings/java/org" "$prefix/java/"
  cp "$bindings/jniLibs/$abi/"*.so "$prefix/jniLibs/$abi/"
  "$toolchain/bin/llvm-readelf" -l "$prefix/jniLibs/$abi/libpjsua2.so" | awk '/LOAD/ { if ($NF != "0x4000") exit 1; found=1 } END { if (!found) exit 1 }'
  licences="$prefix/assets/Licenses"
  chmod -R u+w "$licences"
  cp "$root/LICENSE" "$licences/Sipper.txt"
  cp "$src/COPYING" "$licences/PJSIP.txt"
  cp "$work/openssl-3.5.8/LICENSE.txt" "$licences/OpenSSL.txt"
  cp "$work/opus-1.6.1/COPYING" "$licences/Opus.txt"
  cp "$src/third_party/srtp/LICENSE" "$licences/libsrtp.txt"
  cp "$src/third_party/speex/COPYING" "$licences/Speex.txt"
  cp "$src/third_party/gsm/COPYRIGHT" "$licences/GSM.txt"
  cp "$src/third_party/resample/COPYING" "$licences/libresample.txt"
  cp "$src/third_party/webrtc/LICENSE" "$licences/WebRTC.txt"
  cp "$src/third_party/webrtc/LICENSE_THIRD_PARTY" "$licences/WebRTC-third-party.txt"
  printf 'PJSIP 2.15.1; Opus 1.6.1; OpenSSL 3.5.8; Android API %s; %s\n' "$api" "$abi" > "$prefix/BUILD-INFO-$abi.txt"
  shasum -a 256 "$root/android/patches/pjsip-clear-stun.patch" >> "$prefix/BUILD-INFO-$abi.txt"
done
