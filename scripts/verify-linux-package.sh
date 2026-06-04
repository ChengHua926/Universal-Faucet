#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="${1:-$ROOT_DIR/dist/drip-linux-amd64.tar.gz}"
IMAGE="${DRIP_LINUX_VERIFY_IMAGE:-ubuntu:24.04}"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "missing Linux drip archive: $ARCHIVE" >&2
  exit 1
fi

case "$(basename "$ARCHIVE")" in
  drip-linux-amd64.tar.gz) ;;
  *)
    echo "expected drip-linux-amd64.tar.gz, got: $(basename "$ARCHIVE")" >&2
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for clean Linux package validation" >&2
  exit 1
fi

archive_dir="$(cd "$(dirname "$ARCHIVE")" && pwd)"
archive_base="$(basename "$ARCHIVE")"

docker run --rm \
  --platform linux/amd64 \
  -e DRIP_ARCHIVE_BASENAME="$archive_base" \
  -v "$archive_dir:/dist:ro" \
  "$IMAGE" \
  bash -lc '
set -euo pipefail

archive="/dist/$DRIP_ARCHIVE_BASENAME"
package_name="${DRIP_ARCHIVE_BASENAME%.tar.gz}"
work_dir="$(mktemp -d)"
trap "rm -rf \"$work_dir\"" EXIT

tar -xzf "$archive" -C "$work_dir"
package_dir="$work_dir/$package_name"
drip_bin="$package_dir/drip"
xmrig_dir="$package_dir/third_party/xmrig/linux-amd64"
xmrig_bin="$xmrig_dir/xmrig"

test -x "$drip_bin"
test -x "$xmrig_bin"
test -f "$xmrig_dir/SHA256SUMS"
test -f "$xmrig_dir/BUILDINFO"

(cd "$xmrig_dir" && sha256sum -c SHA256SUMS)

"$drip_bin" --help > /tmp/drip-help.txt
"$xmrig_bin" --version > /tmp/xmrig-version.txt

grep -q "Universal proof-of-work faucet CLI" /tmp/drip-help.txt
grep -q "XMRig 6.26.0" /tmp/xmrig-version.txt
grep -q "donation_disabled=true" "$xmrig_dir/BUILDINFO"

ldd "$drip_bin" > /tmp/drip-ldd.txt
ldd "$xmrig_bin" > /tmp/xmrig-ldd.txt

if grep -R "not found" /tmp/drip-ldd.txt /tmp/xmrig-ldd.txt; then
  echo "missing runtime dependencies in clean Linux image" >&2
  exit 1
fi

echo "[drip ldd]"
cat /tmp/drip-ldd.txt
echo "[xmrig ldd]"
cat /tmp/xmrig-ldd.txt
echo "clean Linux package validation passed: $DRIP_ARCHIVE_BASENAME on '"$IMAGE"'"
'
