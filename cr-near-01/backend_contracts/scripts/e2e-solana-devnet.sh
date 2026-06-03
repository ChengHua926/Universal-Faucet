#!/usr/bin/env bash
# Mock-committee Solana devnet integration tests against a local validator.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_lib.sh
source "$ROOT_DIR/scripts/_lib.sh"

LEDGER_DIR="${SOLANA_LEDGER_DIR:-$ROOT_DIR/.solana-test-validator}"
RPC_PORT="${SOLANA_RPC_PORT:-8899}"
FAUCET_PORT="${SOLANA_FAUCET_PORT:-9900}"
RPC_URL="${SOLANA_RPC_URL:-http://127.0.0.1:$RPC_PORT}"
VALIDATOR="${SOLANA_TEST_VALIDATOR:-solana-test-validator}"
LOG=/tmp/backend-contracts-solana-validator.log

require_cmd npm
require_cmd curl
require_cmd "$VALIDATOR"

echo "starting Solana local validator on $RPC_URL"
rm -rf "$LEDGER_DIR"
"$VALIDATOR" --ledger "$LEDGER_DIR" --reset \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" --quiet >"$LOG" 2>&1 &
PIDS+=("$!")
wait_for_solana_rpc "$RPC_URL" "$LOG"

echo "running Solana devnet integration tests"
cd "$ROOT_DIR"
SOLANA_RPC_URL="$RPC_URL" SOLANA_ALLOW_AIRDROP=1 \
  npx hardhat test test/solana-devnet.ts
