#!/usr/bin/env bash
#
# Generate fresh, independent secp256k1 keypairs for the signing committee
# members and append them to $CROSSROADS_ENV_FILE as COMMITTEE_MEMBER_PRIVATE_KEYS.
#
# Idempotent: if the variable is already present in the env file, the script
# exits without changes. Delete or rename it manually to force a rotation.
#
# In production each committee member generates their own key on their own
# machine; this script only exists so a single operator can stand up an end-to-
# end public-testnet test reproducibly.
#
# Required environment:
#   CROSSROADS_ENV_FILE   path to a gitignored env file (will be appended to)
#
# Optional environment:
#   SIGNING_COMMITTEE_SIZE  default: 3 (odd >= 3)
#   CAST                    default: $HOME/.foundry/bin/cast

set -euo pipefail

CAST="${CAST:-$HOME/.foundry/bin/cast}"
ENV_FILE="${CROSSROADS_ENV_FILE:?CROSSROADS_ENV_FILE must be set}"
SIZE="${SIGNING_COMMITTEE_SIZE:-3}"

if [[ ! -x "$CAST" ]] && ! command -v cast >/dev/null 2>&1; then
  echo "missing cast binary; set CAST or add foundry to PATH" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "env file $ENV_FILE does not exist; create it before running" >&2
  exit 1
fi

if grep -q '^export COMMITTEE_MEMBER_PRIVATE_KEYS=' "$ENV_FILE"; then
  echo "COMMITTEE_MEMBER_PRIVATE_KEYS already present in $ENV_FILE; not regenerating"
  exit 0
fi

keys=()
for _ in $(seq 1 "$SIZE"); do
  key=$("$CAST" wallet new --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['private_key'])")
  keys+=("$key")
done

joined=$(IFS=,; echo "${keys[*]}")

{
  printf '\n'
  printf '# Independent keypairs for committee members (one per member).\n'
  printf '# Each member key has no relationship to the others.\n'
  printf 'export COMMITTEE_MEMBER_PRIVATE_KEYS=%s\n' "$joined"
} >> "$ENV_FILE"

echo "appended COMMITTEE_MEMBER_PRIVATE_KEYS to $ENV_FILE ($SIZE keys)"
