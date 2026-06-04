#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="${1:-}"
SIGNING_REQUIRED="${DRIP_MACOS_SIGNING_REQUIRED:-0}"
SIGN_IDENTITY="${DRIP_MACOS_CODESIGN_IDENTITY:-}"
INSTALLER_IDENTITY="${DRIP_MACOS_INSTALLER_IDENTITY:-}"
NOTARY_PROFILE="${DRIP_MACOS_NOTARY_KEYCHAIN_PROFILE:-}"
NOTARY_APPLE_ID="${DRIP_MACOS_NOTARY_APPLE_ID:-}"
NOTARY_TEAM_ID="${DRIP_MACOS_NOTARY_TEAM_ID:-}"
NOTARY_PASSWORD="${DRIP_MACOS_NOTARY_PASSWORD:-}"
BUNDLE_ID="${DRIP_MACOS_BUNDLE_ID:-com.universalfaucet.drip}"
PACKAGE_VERSION="${DRIP_MACOS_PACKAGE_VERSION:-0.1.0}"

if [[ -z "$ARCHIVE" ]]; then
  echo "usage: scripts/sign-notarize-macos.sh dist/drip-darwin-arm64.tar.gz" >&2
  exit 1
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "missing macOS drip archive: $ARCHIVE" >&2
  exit 1
fi

case "$(basename "$ARCHIVE")" in
  drip-darwin-arm64.tar.gz) PLATFORM="darwin-arm64" ;;
  drip-darwin-amd64.tar.gz) PLATFORM="darwin-amd64" ;;
  *)
    echo "expected drip-darwin-arm64.tar.gz or drip-darwin-amd64.tar.gz" >&2
    exit 1
    ;;
esac

if [[ -z "$SIGN_IDENTITY" ]]; then
  if [[ "$SIGNING_REQUIRED" == "1" ]]; then
    echo "DRIP_MACOS_CODESIGN_IDENTITY is required when DRIP_MACOS_SIGNING_REQUIRED=1" >&2
    exit 1
  fi

  echo "macOS signing skipped: DRIP_MACOS_CODESIGN_IDENTITY is not set"
  exit 0
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 1
  fi
}

require_command codesign
require_command ditto
require_command xcrun
require_command tar

archive_dir="$(cd "$(dirname "$ARCHIVE")" && pwd)"
archive_base="$(basename "$ARCHIVE")"
package_name="${archive_base%.tar.gz}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/drip-macos-sign.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

tar -xzf "$ARCHIVE" -C "$work_dir"
package_dir="$work_dir/$package_name"
drip_bin="$package_dir/drip"
xmrig_bin="$package_dir/third_party/xmrig/$PLATFORM/xmrig"

test -x "$drip_bin"
test -x "$xmrig_bin"

codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$xmrig_bin"
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$drip_bin"
codesign --verify --strict --verbose=2 "$xmrig_bin"
codesign --verify --strict --verbose=2 "$drip_bin"

tar -C "$work_dir" -czf "$ARCHIVE" "$package_name"

if command -v shasum >/dev/null 2>&1; then
  (cd "$archive_dir" && shasum -a 256 "$archive_base" > "$archive_base.sha256")
else
  (cd "$archive_dir" && sha256sum "$archive_base" > "$archive_base.sha256")
fi

zip_archive="$archive_dir/$package_name.zip"
ditto -c -k --keepParent "$package_dir" "$zip_archive"
if command -v shasum >/dev/null 2>&1; then
  (cd "$archive_dir" && shasum -a 256 "$package_name.zip" > "$package_name.zip.sha256")
else
  (cd "$archive_dir" && sha256sum "$package_name.zip" > "$package_name.zip.sha256")
fi

notary_args=()
if [[ -n "$NOTARY_PROFILE" ]]; then
  notary_args=(--keychain-profile "$NOTARY_PROFILE")
elif [[ -n "$NOTARY_APPLE_ID" && -n "$NOTARY_TEAM_ID" && -n "$NOTARY_PASSWORD" ]]; then
  notary_args=(--apple-id "$NOTARY_APPLE_ID" --team-id "$NOTARY_TEAM_ID" --password "$NOTARY_PASSWORD")
fi

if [[ "${#notary_args[@]}" -gt 0 ]]; then
  xcrun notarytool submit "$zip_archive" "${notary_args[@]}" --wait
  echo "notarized $zip_archive"
  echo "notary tickets for ZIP submissions are published online; ZIP archives cannot be stapled directly"
else
  echo "notarization skipped: set DRIP_MACOS_NOTARY_KEYCHAIN_PROFILE or Apple ID/team/password env vars"
fi

if [[ -n "$INSTALLER_IDENTITY" ]]; then
  require_command pkgbuild

  pkg_archive="$archive_dir/$package_name.pkg"
  pkgbuild \
    --root "$package_dir" \
    --install-location "/usr/local/drip" \
    --identifier "$BUNDLE_ID" \
    --version "$PACKAGE_VERSION" \
    --sign "$INSTALLER_IDENTITY" \
    "$pkg_archive"

  if [[ "${#notary_args[@]}" -gt 0 ]]; then
    xcrun notarytool submit "$pkg_archive" "${notary_args[@]}" --wait
    xcrun stapler staple "$pkg_archive"
    echo "notarized and stapled $pkg_archive"
  else
    echo "created signed pkg without notarization: $pkg_archive"
  fi

  if command -v shasum >/dev/null 2>&1; then
    (cd "$archive_dir" && shasum -a 256 "$package_name.pkg" > "$package_name.pkg.sha256")
  else
    (cd "$archive_dir" && sha256sum "$package_name.pkg" > "$package_name.pkg.sha256")
  fi
fi

echo "macOS signing pipeline finished for $archive_base"
