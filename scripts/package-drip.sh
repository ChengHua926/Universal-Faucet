#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_ROOT="${DRIP_DIST_ROOT:-$ROOT_DIR/dist}"

detect_platform() {
  local kernel machine
  kernel="$(uname -s)"
  machine="$(uname -m)"

  case "$kernel:$machine" in
    Darwin:arm64) echo "darwin-arm64" ;;
    Darwin:x86_64) echo "darwin-amd64" ;;
    Linux:x86_64) echo "linux-amd64" ;;
    *) echo "unsupported-$kernel-$machine" ;;
  esac
}

PLATFORM="${DRIP_XMRIG_PLATFORM:-$(detect_platform)}"
case "$PLATFORM" in
  darwin-arm64 | darwin-amd64 | linux-amd64) XMRIG_EXE="xmrig" ;;
  *) echo "unsupported drip package platform: $PLATFORM" >&2; exit 1 ;;
esac

DRIP_EXE="drip"
DRIP_BIN="$ROOT_DIR/target/release/$DRIP_EXE"
XMRIG_DIR="$ROOT_DIR/cli/third_party/xmrig/$PLATFORM"
XMRIG_BIN="$XMRIG_DIR/$XMRIG_EXE"
PACKAGE_NAME="drip-$PLATFORM"
PACKAGE_DIR="$DIST_ROOT/$PACKAGE_NAME"
ARCHIVE="$DIST_ROOT/$PACKAGE_NAME.tar.gz"

if [[ ! -x "$XMRIG_BIN" ]]; then
  echo "missing packaged XMRig binary: $XMRIG_BIN" >&2
  echo "run DRIP_XMRIG_PLATFORM=$PLATFORM scripts/package-xmrig.sh first" >&2
  exit 1
fi

cargo build --release -p xpool-cli --bin drip

rm -rf "$PACKAGE_DIR" "$ARCHIVE" "$ARCHIVE.sha256"
mkdir -p "$PACKAGE_DIR/third_party/xmrig/$PLATFORM"

install -m 755 "$DRIP_BIN" "$PACKAGE_DIR/$DRIP_EXE"
install -m 755 "$XMRIG_BIN" "$PACKAGE_DIR/third_party/xmrig/$PLATFORM/$XMRIG_EXE"
install -m 644 "$XMRIG_DIR/SHA256SUMS" "$PACKAGE_DIR/third_party/xmrig/$PLATFORM/SHA256SUMS"

cat > "$PACKAGE_DIR/README.txt" <<EOF
drip universal proof-of-work faucet CLI

Run:
  ./drip enroll --name <name>
  ./drip <chain> <token> <recipient-address>
  ./drip start --threads 1
  ./drip status
  ./drip stop

This archive bundles source-patched XMRig for $PLATFORM at:
  third_party/xmrig/$PLATFORM/$XMRIG_EXE

Users should not install or run XMRig manually.
EOF

tar -C "$DIST_ROOT" -czf "$ARCHIVE" "$PACKAGE_NAME"

if command -v shasum >/dev/null 2>&1; then
  (cd "$DIST_ROOT" && shasum -a 256 "$PACKAGE_NAME.tar.gz" > "$PACKAGE_NAME.tar.gz.sha256")
else
  (cd "$DIST_ROOT" && sha256sum "$PACKAGE_NAME.tar.gz" > "$PACKAGE_NAME.tar.gz.sha256")
fi

cat "$ARCHIVE.sha256"
