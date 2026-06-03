#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
CARGO_BIN="${CARGO_BIN:-$HOME/.cargo/bin}"
FORGE="${FORGE:-$FOUNDRY_BIN/forge}"
CAST="${CAST:-$FOUNDRY_BIN/cast}"
ANVIL="${ANVIL:-$FOUNDRY_BIN/anvil}"
CARGO="${CARGO:-$CARGO_BIN/cargo}"

COMMITTEE_SIZE="${COMMITTEE_SIZE:-3}"
BASE_PORT="${BASE_PORT:-18080}"
ANVIL_PORT="${ANVIL_PORT:-18545}"
CHAIN_ID="${CHAIN_ID:-31337}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
MNEMONIC="${MNEMONIC:-test test test test test test test test test test test junk}"
WORKDIR="${WORKDIR:-$ROOT_DIR/tmp/e2e-foundry-committee}"

PIDS=()

cleanup() {
  local status=$?
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "${PIDS[@]:-}" 2>/dev/null || true
  if [[ $status -ne 0 ]]; then
    echo "e2e failed; logs are under $WORKDIR" >&2
  fi
}
trap cleanup EXIT

require_cmd() {
  if [[ ! -x "$1" ]] && ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

lower() {
  tr '[:upper:]' '[:lower:]' <<<"$1"
}

hex32() {
  printf '0x%064x' "$1"
}

wait_for_rpc() {
  for _ in $(seq 1 120); do
    if "$CAST" chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  echo "anvil did not become ready at $RPC_URL" >&2
  exit 1
}

wait_for_http() {
  local url="$1"
  for _ in $(seq 1 240); do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  echo "service did not become ready at $url" >&2
  exit 1
}

http_json() {
  local method="$1"
  local url="$2"
  local payload="$3"
  local out="$4"
  local expected="$5"
  local status

  if [[ -n "$payload" ]]; then
    status="$(curl -sS -m 600 -o "$out" -w '%{http_code}' -X "$method" -H 'content-type: application/json' -d "$payload" "$url")"
  else
    status="$(curl -sS -m 600 -o "$out" -w '%{http_code}' -X "$method" "$url")"
  fi

  if [[ "$status" != "$expected" ]]; then
    echo "$method $url returned HTTP $status; expected $expected" >&2
    cat "$out" >&2 || true
    exit 1
  fi
}

sign_request() {
  local asset="$1"
  local enc="$2"
  local message="$3"
  local private_key="$4"
  local out="$5"
  local expected_status="$6"
  local asset_lc canonical user_sig payload

  asset_lc="$(lower "$asset")"
  canonical="$(jq -cn --arg asset "$asset_lc" --arg enc "$enc" --arg message "$message" \
    '{asset_contract:$asset,encumbered_account:$enc,message:$message}')"
  user_sig="$("$CAST" wallet sign --private-key "$private_key" "$canonical")"
  payload="$(jq -cn --arg asset "$asset_lc" --arg enc "$enc" --arg message "$message" --arg user_signature "$user_sig" \
    '{asset_contract:$asset,encumbered_account:$enc,message:$message,user_signature:$user_signature}')"
  http_json POST "http://127.0.0.1:$BASE_PORT/v1/sign" "$payload" "$out" "$expected_status"
}

if (( COMMITTEE_SIZE < 3 || COMMITTEE_SIZE % 2 == 0 )); then
  echo "COMMITTEE_SIZE must be an odd number >= 3 for the robust ECDSA committee shape" >&2
  exit 1
fi

require_cmd "$FORGE"
require_cmd "$CAST"
require_cmd "$ANVIL"
require_cmd "$CARGO"
require_cmd jq
require_cmd curl

THRESHOLD=$(((COMMITTEE_SIZE + 1) / 2))
SPENDER_INDEX="$COMMITTEE_SIZE"

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/deployments" "$WORKDIR/nodes"

echo "building Rust service and Solidity contracts"
(cd "$ROOT_DIR" && "$CARGO" build >/dev/null)
(cd "$ROOT_DIR" && "$FORGE" build >/dev/null)

echo "starting anvil on $RPC_URL"
"$ANVIL" --host 127.0.0.1 --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" \
  --mnemonic "$MNEMONIC" --accounts "$((COMMITTEE_SIZE + 2))" --silent \
  >"$WORKDIR/anvil.log" 2>&1 &
PIDS+=("$!")
wait_for_rpc

DEPLOYER_PK="$("$CAST" wallet private-key "$MNEMONIC" 0)"
DEPLOYER_ADDRESS="$("$CAST" wallet address --private-key "$DEPLOYER_PK")"
SPENDER_PK="$("$CAST" wallet private-key "$MNEMONIC" "$SPENDER_INDEX")"
SPENDER_ADDRESS="$("$CAST" wallet address --private-key "$SPENDER_PK")"
DEPLOY_JSON="$WORKDIR/deployments/latest.json"

echo "deploying bootstrap and account-scoped mock assets"
(
  cd "$ROOT_DIR"
  DEPLOYER_ADDRESS="$DEPLOYER_ADDRESS" \
  COMMITTEE_THRESHOLD="$THRESHOLD" \
  DEPLOYMENT_PATH="$DEPLOY_JSON" \
    "$FORGE" script script/E2EDeploy.s.sol:E2EDeploy \
      --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_PK" -q
)

BOOTSTRAP="$(jq -r '.bootstrap' "$DEPLOY_JSON")"
VERIFIER="$(jq -r '.verifier' "$DEPLOY_JSON")"
ECDSA_RECOVERY_HELPER="$(jq -r '.ecdsaRecoveryHelper' "$DEPLOY_JSON")"
ECDSA_ASSET="$(jq -r '.ecdsaAsset' "$DEPLOY_JSON")"
ED25519_ASSET="$(jq -r '.ed25519Asset' "$DEPLOY_JSON")"
HELLO_WORLD_HASH="$("$CAST" hash-message 'Hello world')"

echo "registering $COMMITTEE_SIZE committee members"
declare -a MEMBER_IDS ADMIN_PKS ADMIN_ADDRS ENDPOINTS
for i in $(seq 0 $((COMMITTEE_SIZE - 1))); do
  MEMBER_IDS[$i]="$(hex32 "$((i + 1))")"
  ADMIN_PKS[$i]="$("$CAST" wallet private-key "$MNEMONIC" "$i")"
  ADMIN_ADDRS[$i]="$("$CAST" wallet address --private-key "${ADMIN_PKS[$i]}")"
  ENDPOINTS[$i]="http://127.0.0.1:$((BASE_PORT + i))"
  bootstrap_pub="$(hex32 "$((0xB000 + i + 1))")"
  client_pub="$(hex32 "$((0xC000 + i + 1))")"
  digest="$("$CAST" call "$VERIFIER" \
    'attestationDigest(address,bytes32,address,string,bytes32,bytes32)(bytes32)' \
    "$BOOTSTRAP" "${MEMBER_IDS[$i]}" "${ADMIN_ADDRS[$i]}" "${ENDPOINTS[$i]}" "$bootstrap_pub" "$client_pub" \
    --rpc-url "$RPC_URL")"
  attestation="$("$CAST" wallet sign --private-key "${ADMIN_PKS[$i]}" --no-hash "$digest")"
  "$CAST" send "$BOOTSTRAP" \
    'registerMember(bytes32,string,bytes32,bytes32,bytes)' \
    "${MEMBER_IDS[$i]}" "${ENDPOINTS[$i]}" "$bootstrap_pub" "$client_pub" "$attestation" \
    --private-key "${ADMIN_PKS[$i]}" --rpc-url "$RPC_URL" >/dev/null
done

"$CAST" send "$BOOTSTRAP" 'closeRegistration()' --private-key "$DEPLOYER_PK" --rpc-url "$RPC_URL" >/dev/null
"$CAST" send "$BOOTSTRAP" 'completeBootstrap()' --private-key "$DEPLOYER_PK" --rpc-url "$RPC_URL" >/dev/null

echo "starting committee nodes"
BIN="$ROOT_DIR/target/debug/crossroads-near-mpc-committee"
for i in $(seq 0 $((COMMITTEE_SIZE - 1))); do
  node_dir="$WORKDIR/nodes/node-$((i + 1))"
  mkdir -p "$node_dir"
  COMMITTEE_LISTEN="127.0.0.1:$((BASE_PORT + i))" \
  COMMITTEE_SELF_MEMBER_ID="${MEMBER_IDS[$i]}" \
  EVM_RPC_URL="$RPC_URL" \
  BOOTSTRAP_CONTRACT="$BOOTSTRAP" \
  ECDSA_ROOT_SHARE_FILE="$node_dir/root-ecdsa.json" \
  ED25519_ROOT_SHARE_FILE="$node_dir/root-ed25519.json" \
  ADMIN_PRIVATE_KEY="${ADMIN_PKS[$i]}" \
  ECDSA_SIGNATURE_KIND="raw32" \
  RUST_LOG="${RUST_LOG:-info}" \
    "$BIN" >"$node_dir/service.log" 2>&1 &
  PIDS+=("$!")
done

for i in $(seq 0 $((COMMITTEE_SIZE - 1))); do
  wait_for_http "http://127.0.0.1:$((BASE_PORT + i))/healthz"
done

echo "bootstrapping ECDSA and Ed25519 roots across the live committee"
for i in $(seq 0 $((THRESHOLD - 1))); do
  http_json POST "http://127.0.0.1:$((BASE_PORT + i))/v1/bootstrap/init" '{}' "$WORKDIR/bootstrap-node$((i + 1)).json" 200
done
http_json GET "http://127.0.0.1:$BASE_PORT/v1/bootstrap/status" '' "$WORKDIR/bootstrap-status.json" 200
jq -e '.schemes | all(.initialized == true and .root_record_active == true)' "$WORKDIR/bootstrap-status.json" >/dev/null

ENC_A="$(hex32 0xA11CE)"
ENC_B="$(hex32 0xB0B)"
ECDSA_MESSAGE="$HELLO_WORLD_HASH"
ED25519_MESSAGE="0x68656c6c6f2d65643235353139"

echo "configuring asset-specific account access"
"$CAST" send "$ECDSA_ASSET" 'setAllowed(address,bytes32,bool)' "$SPENDER_ADDRESS" "$ENC_A" true \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC_URL" >/dev/null
"$CAST" send "$ED25519_ASSET" 'setAllowed(address,bytes32,bool)' "$SPENDER_ADDRESS" "$ENC_B" true \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC_URL" >/dev/null

derived_body_a="$(jq -cn --arg asset "$(lower "$ECDSA_ASSET")" --arg enc "$ENC_A" '{asset_contract:$asset,encumbered_account:$enc}')"
derived_body_b="$(jq -cn --arg asset "$(lower "$ECDSA_ASSET")" --arg enc "$ENC_B" '{asset_contract:$asset,encumbered_account:$enc}')"
http_json POST "http://127.0.0.1:$BASE_PORT/v1/derived-key" "$derived_body_a" "$WORKDIR/derived-ecdsa-a.json" 200
http_json POST "http://127.0.0.1:$BASE_PORT/v1/derived-key" "$derived_body_b" "$WORKDIR/derived-ecdsa-b.json" 200
if [[ "$(jq -r '.public_key' "$WORKDIR/derived-ecdsa-a.json")" == "$(jq -r '.public_key' "$WORKDIR/derived-ecdsa-b.json")" ]]; then
  echo "derived ECDSA keys did not differ between encumbered accounts" >&2
  exit 1
fi

echo "verifying allowed ECDSA signing request"
sign_request "$ECDSA_ASSET" "$ENC_A" "$ECDSA_MESSAGE" "$SPENDER_PK" "$WORKDIR/sign-ecdsa-allowed.json" 200
jq -e --arg spender "$(lower "$SPENDER_ADDRESS")" '.scheme == "ecdsa-secp256k1" and (.spender | ascii_downcase) == $spender and .signature_kind == "raw32"' \
  "$WORKDIR/sign-ecdsa-allowed.json" >/dev/null
ecdsa_raw_sig="$(jq -r '.signature' "$WORKDIR/sign-ecdsa-allowed.json")"
echo "ECDSA public key: $(jq -r '.public_key' "$WORKDIR/sign-ecdsa-allowed.json")"
echo "ECDSA signature: $ecdsa_raw_sig"

echo "verifying ECDSA denial for the account owned by the Ed25519 asset"
sign_request "$ECDSA_ASSET" "$ENC_B" "$ECDSA_MESSAGE" "$SPENDER_PK" "$WORKDIR/sign-ecdsa-denied.json" 403
jq -e '.error | contains("canSign returned false")' "$WORKDIR/sign-ecdsa-denied.json" >/dev/null

echo "verifying allowed Ed25519 signing request"
sign_request "$ED25519_ASSET" "$ENC_B" "$ED25519_MESSAGE" "$SPENDER_PK" "$WORKDIR/sign-ed25519-allowed.json" 200
jq -e --arg spender "$(lower "$SPENDER_ADDRESS")" '.scheme == "ed25519" and (.spender | ascii_downcase) == $spender and .signature_kind == "ed25519-rfc8032-raw"' \
  "$WORKDIR/sign-ed25519-allowed.json" >/dev/null
(
  cd "$ROOT_DIR"
  "$CARGO" run --quiet --example verify_ed25519 -- \
    "$(jq -r '.public_key' "$WORKDIR/sign-ed25519-allowed.json")" \
    "$(jq -r '.signature' "$WORKDIR/sign-ed25519-allowed.json")" \
    "$ED25519_MESSAGE"
)

echo "verifying Ed25519 denial for the account owned by the ECDSA asset"
sign_request "$ED25519_ASSET" "$ENC_A" "$ED25519_MESSAGE" "$SPENDER_PK" "$WORKDIR/sign-ed25519-denied.json" 403
jq -e '.error | contains("canSign returned false")' "$WORKDIR/sign-ed25519-denied.json" >/dev/null

echo "e2e foundry committee test passed"
