#!/usr/bin/env bash
# Real-committee Solana e2e against a local solana-test-validator.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_lib.sh
source "$ROOT_DIR/scripts/_lib.sh"

ANVIL_PORT="${ANVIL_PORT:-8545}"
ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-23293}"
ASSET_RPC_URL="${ASSET_RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
SOLANA_LEDGER_DIR="${SOLANA_LEDGER_DIR:-$ROOT_DIR/.solana-test-validator-real-committee}"
SOLANA_RPC_PORT="${SOLANA_RPC_PORT:-8899}"
SOLANA_FAUCET_PORT="${SOLANA_FAUCET_PORT:-9900}"
SOLANA_RPC_URL="${SOLANA_RPC_URL:-http://127.0.0.1:$SOLANA_RPC_PORT}"
MNEMONIC="${COMMITTEE_MNEMONIC:-$DEFAULT_MNEMONIC}"
SOLANA_TEST_VALIDATOR="${SOLANA_TEST_VALIDATOR:-solana-test-validator}"
DEPLOYMENT_PATH="${SIGNING_COMMITTEE_DEPLOYMENT_PATH:-$SIGNING_COMMITTEE_DIR/tmp/signing-committee-solana-devnet-deployment.json}"
SOLANA_LOG=/tmp/backend-contracts-solana-real-committee-validator.log

require_cmd "$ANVIL"
require_cmd "$FORGE"
require_cmd "$CAST"
require_cmd "$CARGO"
require_cmd "$SOLANA_TEST_VALIDATOR"
require_cmd npm
require_cmd curl

echo "building signing committee"
build_signing_committee

echo "starting anvil asset chain on $ASSET_RPC_URL"
start_anvil "$ANVIL_PORT" "$ANVIL_CHAIN_ID" "$MNEMONIC" \
  /tmp/backend-contracts-solana-real-committee-anvil.log

echo "deploying signing committee bootstrap contracts"
DEPLOYER_ADDRESS="$("$CAST" wallet address --mnemonic "$MNEMONIC")"
DEPLOYER_PRIVATE_KEY="$("$CAST" wallet private-key --mnemonic "$MNEMONIC")"
deploy_committee_bootstrap "$DEPLOYMENT_PATH" "$DEPLOYER_ADDRESS" "$DEPLOYER_PRIVATE_KEY" \
  "$ASSET_RPC_URL" /tmp/backend-contracts-solana-committee-deploy.log

echo "starting Solana local validator on $SOLANA_RPC_URL"
rm -rf "$SOLANA_LEDGER_DIR"
"$SOLANA_TEST_VALIDATOR" --ledger "$SOLANA_LEDGER_DIR" --reset \
  --rpc-port "$SOLANA_RPC_PORT" --faucet-port "$SOLANA_FAUCET_PORT" --quiet >"$SOLANA_LOG" 2>&1 &
PIDS+=("$!")
wait_for_solana_rpc "$SOLANA_RPC_URL" "$SOLANA_LOG"

echo "running Solana devnet e2e with real Ed25519 signing committee"
cd "$ROOT_DIR"
ASSET_RPC_URL="$ASSET_RPC_URL" \
SOLANA_RPC_URL="$SOLANA_RPC_URL" \
SOLANA_ALLOW_AIRDROP=1 \
SOLANA_DEPOSITOR_SECRET_KEY= \
SOLANA_SECRET_KEY= \
SIGNING_COMMITTEE_DEPLOYMENT_PATH="$DEPLOYMENT_PATH" \
SIGNING_COMMITTEE=real \
COMMITTEE_MNEMONIC="$MNEMONIC" \
  npx hardhat test test/solana-real-committee-devnet.ts --network dev
