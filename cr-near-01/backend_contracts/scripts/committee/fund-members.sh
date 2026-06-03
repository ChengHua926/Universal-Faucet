#!/usr/bin/env bash
#
# Fund the EVM gas accounts for each signing committee member, paying from the
# deployer key. Each member needs enough gas to call registerMember on the
# bootstrap contract (and a small buffer for retries).
#
# Idempotent: only sends if the member's current balance is below the target.
#
# Required environment:
#   COMMITTEE_MEMBER_PRIVATE_KEYS   comma-separated 0x-prefixed keys (one per member)
#   ASSET_RPC_URL                   EVM RPC for the chain hosting the committee bootstrap
#   DEPLOYER_PRIVATE_KEY            funder key, must be the deployer of the bootstrap contracts
#
# Optional environment:
#   MEMBER_FUNDING_TARGET_ETH       per-member target balance (default: 0.05)
#   CAST                            default: $HOME/.foundry/bin/cast

set -euo pipefail

CAST="${CAST:-$HOME/.foundry/bin/cast}"
KEYS="${COMMITTEE_MEMBER_PRIVATE_KEYS:?COMMITTEE_MEMBER_PRIVATE_KEYS must be set (see scripts/committee/generate-member-keys.sh)}"
RPC="${ASSET_RPC_URL:?ASSET_RPC_URL must be set}"
FUNDER="${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY must be set}"
TARGET_ETH="${MEMBER_FUNDING_TARGET_ETH:-0.05}"

if [[ ! -x "$CAST" ]] && ! command -v cast >/dev/null 2>&1; then
  echo "missing cast binary; set CAST or add foundry to PATH" >&2
  exit 1
fi

target_wei=$("$CAST" to-wei "$TARGET_ETH" ether)

IFS=',' read -r -a member_keys <<< "$KEYS"
i=0
for raw in "${member_keys[@]}"; do
  key="${raw// /}"
  if [[ -z "$key" ]]; then
    continue
  fi
  addr=$("$CAST" wallet address --private-key "$key")
  bal=$("$CAST" balance "$addr" --rpc-url "$RPC")
  delta=$(python3 -c "import sys; b=int(sys.argv[1]); t=int(sys.argv[2]); print(max(0, t-b))" "$bal" "$target_wei")
  if [[ "$delta" == "0" ]]; then
    echo "member[$i] $addr already at $bal wei (>= target $target_wei); skipping"
  else
    echo "member[$i] $addr funding +$delta wei (current $bal, target $target_wei)"
    "$CAST" send "$addr" --value "${delta}wei" --rpc-url "$RPC" --private-key "$FUNDER" --json \
      | python3 -c "import json,sys; r=json.load(sys.stdin); print('  tx:', r.get('transactionHash'), 'status:', r.get('status'))"
  fi
  i=$((i + 1))
done
