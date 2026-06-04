#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XMRIG_VERSION="${XMRIG_VERSION:-v6.26.0}"
XMRIG_COMMIT="${XMRIG_COMMIT:-b2ca72480c58d197e18c885d9fc1a0c8d517e60a}"
BUILD_ROOT="${XMRIG_BUILD_ROOT:-${TMPDIR:-/tmp}/drip-xmrig-package}"
SOURCE_DIR="$BUILD_ROOT/xmrig-src"
BUILD_DIR="$SOURCE_DIR/build"

detect_platform() {
  local kernel machine
  kernel="$(uname -s)"
  machine="$(uname -m)"

  case "$kernel:$machine" in
    Darwin:arm64) echo "darwin-arm64" ;;
    Darwin:x86_64) echo "darwin-amd64" ;;
    Linux:x86_64) echo "linux-amd64" ;;
    MINGW64*:x86_64 | MSYS_NT*:x86_64 | CYGWIN_NT*:x86_64) echo "windows-amd64" ;;
    *) echo "unsupported-$kernel-$machine" ;;
  esac
}

write_buildinfo() {
  local binary_path="$1"
  local output_path="$2"

  {
    echo "component=xmrig"
    echo "source=https://github.com/xmrig/xmrig"
    echo "version=$XMRIG_VERSION"
    echo "commit=$actual_commit"
    echo "platform=$PLATFORM"
    echo "executable=$EXE_NAME"
    echo "donation_disabled=true"
    echo "donation_patch=cli/third_party/xmrig/patches/disable-donation.patch"
    echo "built_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "checksum_file=SHA256SUMS"
    echo
    echo "[runtime_dependencies]"

    case "$PLATFORM" in
      linux-*)
        if command -v ldd >/dev/null 2>&1; then
          ldd "$binary_path"
        else
          echo "ldd unavailable"
        fi
        ;;
      darwin-*)
        if command -v otool >/dev/null 2>&1; then
          otool -L "$binary_path"
        else
          echo "otool unavailable"
        fi
        ;;
      windows-*)
        echo "not captured by this script"
        ;;
    esac
  } > "$output_path"
}

PLATFORM="${DRIP_XMRIG_PLATFORM:-$(detect_platform)}"
case "$PLATFORM" in
  darwin-arm64 | darwin-amd64 | linux-amd64) EXE_NAME="xmrig" ;;
  windows-amd64) EXE_NAME="xmrig.exe" ;;
  *) echo "unsupported XMRig package platform: $PLATFORM" >&2; exit 1 ;;
esac

rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT"

git clone --branch "$XMRIG_VERSION" --depth 1 https://github.com/xmrig/xmrig.git "$SOURCE_DIR"
actual_commit="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
if [[ "$actual_commit" != "$XMRIG_COMMIT" ]]; then
  echo "unexpected XMRig commit: $actual_commit" >&2
  echo "expected: $XMRIG_COMMIT" >&2
  exit 1
fi

git -C "$SOURCE_DIR" apply "$ROOT_DIR/cli/third_party/xmrig/patches/disable-donation.patch"
grep -q "kDefaultDonateLevel = 0" "$SOURCE_DIR/src/donate.h"
grep -q "kMinimumDonateLevel = 0" "$SOURCE_DIR/src/donate.h"

mkdir -p "$BUILD_DIR"
cmake_args=(
  -S "$SOURCE_DIR"
  -B "$BUILD_DIR"
  -DCMAKE_BUILD_TYPE=Release
  -DWITH_HWLOC=OFF
  -DWITH_OPENCL=OFF
  -DWITH_CUDA=OFF
)

if [[ "$PLATFORM" == darwin-* ]]; then
  if command -v brew >/dev/null 2>&1; then
    cmake_args+=("-DOPENSSL_ROOT_DIR=$(brew --prefix openssl@3 2>/dev/null || brew --prefix openssl)")
  fi
fi

cmake "${cmake_args[@]}"
cmake --build "$BUILD_DIR" --config Release --parallel

candidate="$BUILD_DIR/$EXE_NAME"
if [[ "$PLATFORM" == "windows-amd64" && ! -f "$candidate" ]]; then
  candidate="$BUILD_DIR/Release/$EXE_NAME"
fi
if [[ ! -f "$candidate" ]]; then
  echo "built XMRig binary not found at $candidate" >&2
  exit 1
fi

target_dir="$ROOT_DIR/cli/third_party/xmrig/$PLATFORM"
mkdir -p "$target_dir"
install -m 755 "$candidate" "$target_dir/$EXE_NAME"

if command -v shasum >/dev/null 2>&1; then
  (cd "$target_dir" && shasum -a 256 "$EXE_NAME" > SHA256SUMS)
else
  (cd "$target_dir" && sha256sum "$EXE_NAME" > SHA256SUMS)
fi

write_buildinfo "$target_dir/$EXE_NAME" "$target_dir/BUILDINFO"

"$target_dir/$EXE_NAME" --version
cat "$target_dir/SHA256SUMS"
cat "$target_dir/BUILDINFO"
