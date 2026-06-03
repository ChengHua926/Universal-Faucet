#!/usr/bin/env bash
# Real-committee Bitcoin e2e against a Docker-launched bitcoind regtest.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_lib.sh
source "$ROOT_DIR/scripts/_lib.sh"

ANVIL_PORT="${ANVIL_PORT:-8545}"
ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-23293}"
ASSET_RPC_URL="${ASSET_RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
BITCOIN_CONTAINER="${BITCOIN_REGTEST_CONTAINER:-backend-contracts-bitcoin-regtest}"
BITCOIN_IMAGE="${BITCOIN_IMAGE:-bitcoin/bitcoin:27.0}"
BITCOIN_RPC_USER="${BITCOIN_RPC_USER:-crossroads}"
BITCOIN_RPC_PASSWORD="${BITCOIN_RPC_PASSWORD:-crossroads}"
BITCOIN_RPC_PORT="${BITCOIN_RPC_PORT:-18443}"
BITCOIN_RPC_URL="http://$BITCOIN_RPC_USER:$BITCOIN_RPC_PASSWORD@127.0.0.1:$BITCOIN_RPC_PORT"
MNEMONIC="${COMMITTEE_MNEMONIC:-$DEFAULT_MNEMONIC}"
DEPLOYMENT_PATH="${SIGNING_COMMITTEE_DEPLOYMENT_PATH:-$SIGNING_COMMITTEE_DIR/tmp/signing-committee-bitcoin-regtest-deployment.json}"

EXTRA_CLEANUP+=('docker rm -f "$BITCOIN_CONTAINER" >/dev/null 2>&1')

require_cmd "$ANVIL"
require_cmd "$FORGE"
require_cmd "$CAST"
require_cmd "$CARGO"
require_cmd npm
require_cmd curl
require_cmd docker

wait_for_bitcoin_rpc() {
  for _ in $(seq 1 120); do
    if curl -fsS -m 2 --user "$BITCOIN_RPC_USER:$BITCOIN_RPC_PASSWORD" \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"1.0","id":1,"method":"getblockchaininfo","params":[]}' \
      "http://127.0.0.1:$BITCOIN_RPC_PORT" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done
  echo "Bitcoin regtest RPC did not become ready at $BITCOIN_RPC_URL" >&2
  docker logs "$BITCOIN_CONTAINER" >&2 || true
  exit 1
}

echo "building signing committee"
build_signing_committee

echo "starting anvil asset chain on $ASSET_RPC_URL"
start_anvil "$ANVIL_PORT" "$ANVIL_CHAIN_ID" "$MNEMONIC" /tmp/backend-contracts-bitcoin-anvil.log

echo "deploying signing committee bootstrap contracts"
DEPLOYER_ADDRESS="$("$CAST" wallet address --mnemonic "$MNEMONIC")"
DEPLOYER_PRIVATE_KEY="$("$CAST" wallet private-key --mnemonic "$MNEMONIC")"
deploy_committee_bootstrap "$DEPLOYMENT_PATH" "$DEPLOYER_ADDRESS" "$DEPLOYER_PRIVATE_KEY" \
  "$ASSET_RPC_URL" /tmp/backend-contracts-bitcoin-committee-deploy.log

echo "starting Bitcoin Core regtest on $BITCOIN_RPC_URL"
docker rm -f "$BITCOIN_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$BITCOIN_CONTAINER" \
  -p "$BITCOIN_RPC_PORT:18443" \
  "$BITCOIN_IMAGE" \
  -regtest=1 -server=1 -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
  -rpcuser="$BITCOIN_RPC_USER" -rpcpassword="$BITCOIN_RPC_PASSWORD" \
  -fallbackfee=0.0001 -txindex=1 >/dev/null
wait_for_bitcoin_rpc

echo "running Bitcoin tests with real signing committee"
cd "$ROOT_DIR"
ASSET_RPC_URL="$ASSET_RPC_URL" \
BITCOIN_RPC_URL="$BITCOIN_RPC_URL" \
SIGNING_COMMITTEE_DEPLOYMENT_PATH="$DEPLOYMENT_PATH" \
SIGNING_COMMITTEE=real \
COMMITTEE_MNEMONIC="$MNEMONIC" \
ECDSA_SIGNATURE_KIND=btc-sha256 \
  npx hardhat test test/bitcoin.ts --network dev
