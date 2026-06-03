#!/usr/bin/env bash
# Real-committee EVM e2e against a Kurtosis-launched ethereum-package enclave.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_lib.sh
source "$ROOT_DIR/scripts/_lib.sh"

ENCLAVE="${KURTOSIS_ENCLAVE:-crossroads-pub-devnet}"
ASSET_RPC_URL="${ASSET_RPC_URL:-http://127.0.0.1:8545}"
PUBLIC_RPC_URL="${PUBLIC_RPC_URL:-http://127.0.0.1:32003}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-23293}"
MNEMONIC="${COMMITTEE_MNEMONIC:-$DEFAULT_MNEMONIC}"
DEPLOYMENT_PATH="${SIGNING_COMMITTEE_DEPLOYMENT_PATH:-$SIGNING_COMMITTEE_DIR/tmp/signing-committee-deployment.json}"

KURTOSIS_CMD=(kurtosis)
EXTRA_CLEANUP+=(
  '"${KURTOSIS_CMD[@]}" enclave stop "$ENCLAVE" >/tmp/backend-contracts-kurtosis-stop.log 2>&1'
  '"${KURTOSIS_CMD[@]}" enclave rm "$ENCLAVE" >/tmp/backend-contracts-kurtosis-rm.log 2>&1'
)

require_cmd "$ANVIL"
require_cmd "$FORGE"
require_cmd "$CAST"
require_cmd "$CARGO"
require_cmd npm
require_cmd curl
if ! "${KURTOSIS_CMD[@]}" enclave ls >/dev/null 2>&1; then
  KURTOSIS_CMD=(sudo kurtosis)
fi

echo "building signing committee"
build_signing_committee

echo "starting anvil asset chain on $ASSET_RPC_URL"
start_anvil "$ANVIL_PORT" "$ANVIL_CHAIN_ID" "$MNEMONIC" /tmp/backend-contracts-anvil.log

echo "deploying signing committee bootstrap contracts"
DEPLOYER_ADDRESS="$("$CAST" wallet address --mnemonic "$MNEMONIC")"
DEPLOYER_PRIVATE_KEY="$("$CAST" wallet private-key --mnemonic "$MNEMONIC")"
deploy_committee_bootstrap "$DEPLOYMENT_PATH" "$DEPLOYER_ADDRESS" "$DEPLOYER_PRIVATE_KEY" \
  "$ASSET_RPC_URL" /tmp/backend-contracts-signing-committee-deploy.log

echo "starting Kurtosis proof-source chain in enclave $ENCLAVE"
"${KURTOSIS_CMD[@]}" run github.com/ethpandaops/ethereum-package \
  --args-file "$ROOT_DIR/devnet/network_params.yaml" \
  --image-download always --enclave "$ENCLAVE"
wait_for_evm_rpc "$PUBLIC_RPC_URL"

echo "running backend e2e with real signing committee"
cd "$ROOT_DIR"
ASSET_RPC_URL="$ASSET_RPC_URL" \
PUBLIC_RPC_URL="$PUBLIC_RPC_URL" \
SIGNING_COMMITTEE_DEPLOYMENT_PATH="$DEPLOYMENT_PATH" \
SIGNING_COMMITTEE=real \
COMMITTEE_MNEMONIC="$MNEMONIC" \
  npx hardhat test test/evm.ts --network dev
