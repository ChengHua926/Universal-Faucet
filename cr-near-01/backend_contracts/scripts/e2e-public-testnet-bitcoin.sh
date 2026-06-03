#!/usr/bin/env bash
# Real-committee Bitcoin testnet4 e2e against the Hoodi public testnet stack.
# See README "Public testnet roundtrip" for required env vars.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_lib.sh
source "$ROOT_DIR/scripts/_lib.sh"

if [[ -n "${CROSSROADS_ENV_FILE:-}" && -r "$CROSSROADS_ENV_FILE" ]]; then
  echo "sourcing $CROSSROADS_ENV_FILE"
  # shellcheck disable=SC1090
  source "$CROSSROADS_ENV_FILE"
fi

ASSET_HARDHAT_NETWORK="${ASSET_HARDHAT_NETWORK:-hoodi}"
ASSET_RPC_URL="${ASSET_RPC_URL:-${HOODI_RPC_URL:-}}"
DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-${HOODI_PRIVATE_KEY:-}}"

[[ -n "$ASSET_RPC_URL" ]]        || { echo "ASSET_RPC_URL (or HOODI_RPC_URL) must be set" >&2; exit 1; }
[[ -n "$DEPLOYER_PRIVATE_KEY" ]] || { echo "DEPLOYER_PRIVATE_KEY (or HOODI_PRIVATE_KEY) must be set" >&2; exit 1; }

if [[ -z "${BITCOIN_RPC_URL:-}" ]]; then
  [[ -n "${BITCOIN_TESTNET_RPC_URL:-}" ]] \
    || { echo "BITCOIN_RPC_URL or BITCOIN_TESTNET_RPC_URL must be set" >&2; exit 1; }
  if [[ -n "${BITCOIN_TESTNET_RPC_USER:-}" || -n "${BITCOIN_TESTNET_RPC_PASSWORD:-}" ]]; then
    scheme="${BITCOIN_TESTNET_RPC_URL%%://*}"; rest="${BITCOIN_TESTNET_RPC_URL#*://}"
    BITCOIN_RPC_URL="${scheme}://${BITCOIN_TESTNET_RPC_USER}:${BITCOIN_TESTNET_RPC_PASSWORD}@${rest}"
  else
    BITCOIN_RPC_URL="$BITCOIN_TESTNET_RPC_URL"
  fi
fi
export ASSET_RPC_URL BITCOIN_RPC_URL DEPLOYER_PRIVATE_KEY
export HOODI_RPC_URL="${HOODI_RPC_URL:-$ASSET_RPC_URL}"
export HOODI_PRIVATE_KEY="${HOODI_PRIVATE_KEY:-$DEPLOYER_PRIVATE_KEY}"
export SIGNING_COMMITTEE_SIZE="${SIGNING_COMMITTEE_SIZE:-3}"
export CAST

BOOTSTRAP_PATH="${SIGNING_COMMITTEE_DEPLOYMENT_PATH:-$SIGNING_COMMITTEE_DIR/tmp/signing-committee-public-${ASSET_HARDHAT_NETWORK}.json}"
export PUBLIC_TESTNET_DEPLOYMENT_PATH="${PUBLIC_TESTNET_DEPLOYMENT_PATH:-$ROOT_DIR/tmp/public-testnet-deployment.json}"

require_cmd "$FORGE"
require_cmd "$CAST"
require_cmd "$CARGO"
require_cmd npm
require_cmd curl

echo "[1/6] building signing committee binary"
build_signing_committee

mkdir -p "$(dirname "$BOOTSTRAP_PATH")" "$(dirname "$PUBLIC_TESTNET_DEPLOYMENT_PATH")"

echo "[2/6] generating committee member keys if missing"
if [[ -z "${CROSSROADS_ENV_FILE:-}" ]]; then
  [[ -n "${COMMITTEE_MEMBER_PRIVATE_KEYS:-}" ]] || {
    echo "  CROSSROADS_ENV_FILE not set and COMMITTEE_MEMBER_PRIVATE_KEYS empty; cannot proceed" >&2
    exit 1
  }
  echo "  using COMMITTEE_MEMBER_PRIVATE_KEYS from environment"
else
  "$ROOT_DIR/scripts/committee/generate-member-keys.sh"
  # shellcheck disable=SC1090
  source "$CROSSROADS_ENV_FILE"
fi
export COMMITTEE_MEMBER_PRIVATE_KEYS

echo "[3/6] funding committee member gas accounts"
"$ROOT_DIR/scripts/committee/fund-members.sh"

DEPLOYER_ADDRESS="$("$CAST" wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"

echo "[4/6] deploying signing committee bootstrap contracts to $ASSET_RPC_URL"
if [[ "${SKIP_BOOTSTRAP_DEPLOY:-0}" == "1" && -f "$BOOTSTRAP_PATH" ]]; then
  echo "  reusing existing bootstrap at $BOOTSTRAP_PATH"
else
  deploy_committee_bootstrap "$BOOTSTRAP_PATH" "$DEPLOYER_ADDRESS" "$DEPLOYER_PRIVATE_KEY" \
    "$ASSET_RPC_URL" /tmp/backend-contracts-public-testnet-committee-deploy.log
fi

echo "[5/6] deploying public testnet stack on hardhat network $ASSET_HARDHAT_NETWORK"
if [[ "${SKIP_PUBLIC_TESTNET_DEPLOY:-0}" == "1" && -f "$PUBLIC_TESTNET_DEPLOYMENT_PATH" ]]; then
  echo "  reusing existing public testnet deployment at $PUBLIC_TESTNET_DEPLOYMENT_PATH"
else
  cd "$ROOT_DIR"
  npx hardhat test test/public-testnet/deployment.ts --network "$ASSET_HARDHAT_NETWORK"
fi

echo "[6/6] running public-testnet Bitcoin e2e against $BITCOIN_RPC_URL"
cd "$ROOT_DIR"
SIGNING_COMMITTEE_DEPLOYMENT_PATH="$BOOTSTRAP_PATH" \
SIGNING_COMMITTEE=real \
ECDSA_SIGNATURE_KIND=btc-sha256 \
  npx hardhat test test/public-testnet/bitcoin-testnet4.ts --network "$ASSET_HARDHAT_NETWORK"
