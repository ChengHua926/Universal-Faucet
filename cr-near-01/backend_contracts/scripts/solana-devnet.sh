#!/usr/bin/env bash
set -euo pipefail

if ! command -v solana-test-validator >/dev/null 2>&1; then
  echo "solana-test-validator is not installed. Install Solana CLI, then rerun this script." >&2
  exit 1
fi

LEDGER_DIR="${SOLANA_LEDGER_DIR:-.solana-test-validator}"
RPC_PORT="${SOLANA_RPC_PORT:-8899}"
FAUCET_PORT="${SOLANA_FAUCET_PORT:-9900}"

exec solana-test-validator \
  --ledger "$LEDGER_DIR" \
  --reset \
  --rpc-port "$RPC_PORT" \
  --faucet-port "$FAUCET_PORT" \
  --quiet
