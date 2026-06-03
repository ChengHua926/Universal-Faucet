#!/usr/bin/env bash
# Reproducible signing-latency benchmark for one committee size, optionally
# sweeping inter-node simulated latencies.
#
# Boots an isolated anvil, deploys the bootstrap and mock asset contracts,
# registers a COMMITTEE_SIZE-member committee, runs the NEAR-MPC DKG once,
# then for each LATENCY value runs TRIALS timed signing requests per scheme.
#
# Inter-node latency is simulated with a per-node TCP delay proxy. Each
# committee node listens on its real port (NODE_PORT_BASE+i). The bootstrap
# endpoint URL points at the proxy port (BASE_PORT+i). Client signing
# requests bypass the proxy by going directly to the coordinator's real
# port, so the reported latency is purely the inter-node round-trip cost.
#
# RTT_MS values configure round-trip latency between peers. The proxy adds
# RTT_MS/2 of delay in each direction so that a peer round-trip incurs the
# full RTT. RTT_MS=0 leaves the proxy in pass-through mode.
#
# If any single sign request takes longer than SIGN_TIMEOUT seconds, the
# rest of that (size, rtt) cell is aborted and a .skipped marker is dropped
# into RESULTS_DIR; the sweep moves on to the next RTT.
#
# Per-trial latencies (seconds) land in:
#   $RESULTS_DIR/size-$COMMITTEE_SIZE-rtt<MS>-ecdsa.csv
#   $RESULTS_DIR/size-$COMMITTEE_SIZE-rtt<MS>-ed25519.csv
#
# Environment variables:
#   COMMITTEE_SIZE     odd integer >= 3 (default 3)
#   TRIALS             timed signs per scheme per RTT (default 10)
#   LATENCIES          space-separated round-trip latencies in ms
#                      (default "0 10 50 100 250 500 750 1000")
#   SIGN_TIMEOUT       per-sign-request wall-clock cap in seconds (default 22)
#   SCHEMES            schemes to benchmark (default "ecdsa ed25519")
#   BASE_PORT          first proxy port (default 18080)
#   NODE_PORT_BASE     first real node listen port (default 28080)
#   ANVIL_PORT         anvil JSON-RPC port (default 18545)
#   RESULTS_DIR        output dir for CSVs (default tmp/bench-sign-latency/results)
#   PROFILE            cargo build profile: debug or release (default release)
#   RUST_LOG           passed through; default warn

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
CARGO_BIN="${CARGO_BIN:-$HOME/.cargo/bin}"
FORGE="${FORGE:-$FOUNDRY_BIN/forge}"
CAST="${CAST:-$FOUNDRY_BIN/cast}"
ANVIL="${ANVIL:-$FOUNDRY_BIN/anvil}"
CARGO="${CARGO:-$CARGO_BIN/cargo}"
PROXY_PY="${PROXY_PY:-$ROOT_DIR/scripts/delay_proxy.py}"

COMMITTEE_SIZE="${COMMITTEE_SIZE:-3}"
TRIALS="${TRIALS:-10}"
LATENCIES="${LATENCIES:-0 10 50 100 250 500 750 1000}"
SIGN_TIMEOUT="${SIGN_TIMEOUT:-22}"
SCHEMES="${SCHEMES:-ecdsa ed25519}"
BASE_PORT="${BASE_PORT:-18080}"
NODE_PORT_BASE="${NODE_PORT_BASE:-28080}"
ANVIL_PORT="${ANVIL_PORT:-18545}"
CHAIN_ID="${CHAIN_ID:-31337}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
MNEMONIC="${MNEMONIC:-test test test test test test test test test test test junk}"
PROFILE="${PROFILE:-release}"
WORKDIR="${WORKDIR:-$ROOT_DIR/tmp/bench-sign-latency/size-$COMMITTEE_SIZE}"
RESULTS_DIR="${RESULTS_DIR:-$ROOT_DIR/tmp/bench-sign-latency/results}"
RUST_LOG="${RUST_LOG:-warn}"

NODE_PIDS=()
PROXY_PIDS=()
ANVIL_PID=""

kill_proxies() {
  for pid in "${PROXY_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "${PROXY_PIDS[@]:-}" 2>/dev/null || true
  PROXY_PIDS=()
}

cleanup() {
  local status=$?
  kill_proxies
  for pid in "${NODE_PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
  fi
  wait "${NODE_PIDS[@]:-}" "$ANVIL_PID" 2>/dev/null || true
  if [[ $status -ne 0 ]]; then
    echo "bench failed; logs in $WORKDIR" >&2
  fi
}
trap cleanup EXIT

require_cmd() {
  if [[ ! -x "$1" ]] && ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
hex32() { printf '0x%064x' "$1"; }

wait_for_rpc() {
  for _ in $(seq 1 120); do
    "$CAST" chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && return
    sleep 0.25
  done
  echo "anvil did not become ready at $RPC_URL" >&2; exit 1
}

wait_for_http() {
  local url="$1"
  for _ in $(seq 1 240); do
    curl -fsS -m 2 "$url" >/dev/null 2>&1 && return
    sleep 0.25
  done
  echo "service did not become ready at $url" >&2; exit 1
}

wait_for_port() {
  local port="$1"
  for _ in $(seq 1 80); do
    if (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
      return
    fi
    sleep 0.05
  done
  echo "port $port did not open" >&2; exit 1
}

http_json() {
  local method="$1" url="$2" payload="$3" out="$4" expected="$5" status
  if [[ -n "$payload" ]]; then
    status="$(curl -sS -m 600 -o "$out" -w '%{http_code}' -X "$method" \
      -H 'content-type: application/json' -d "$payload" "$url")"
  else
    status="$(curl -sS -m 600 -o "$out" -w '%{http_code}' -X "$method" "$url")"
  fi
  if [[ "$status" != "$expected" ]]; then
    echo "$method $url -> HTTP $status (expected $expected)" >&2
    cat "$out" >&2 || true; exit 1
  fi
}

timed_post() {
  local url="$1" payload="$2" out="$3" max_time="${4:-600}" result status time rc
  result="$(curl -sS -f -m "$max_time" -o "$out" \
    -w '%{http_code} %{time_total}' \
    -H 'content-type: application/json' -d "$payload" "$url" 2>/dev/null)" \
    || return 1
  status="${result%% *}"; time="${result##* }"
  [[ "$status" == "200" ]] || return 1
  printf '%s\n' "$time"
}

start_proxies() {
  local per_dir_ms="$1"
  PROXY_PIDS=()
  for i in $(seq 0 $((COMMITTEE_SIZE - 1))); do
    python3 "$PROXY_PY" "$((BASE_PORT + i))" "$((NODE_PORT_BASE + i))" "$per_dir_ms" \
      >"$WORKDIR/proxy-$i.log" 2>&1 &
    PROXY_PIDS+=("$!")
  done
  for i in $(seq 0 $((COMMITTEE_SIZE - 1))); do
    wait_for_port "$((BASE_PORT + i))"
  done
}

if (( COMMITTEE_SIZE < 3 || COMMITTEE_SIZE % 2 == 0 )); then
  echo "COMMITTEE_SIZE must be an odd number >= 3" >&2; exit 1
fi

require_cmd "$FORGE"; require_cmd "$CAST"; require_cmd "$ANVIL"
require_cmd "$CARGO"; require_cmd jq; require_cmd curl; require_cmd python3

THRESHOLD=$(((COMMITTEE_SIZE + 1) / 2))
SPENDER_INDEX="$COMMITTEE_SIZE"

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/deployments" "$WORKDIR/nodes" "$RESULTS_DIR"

echo "[size=$COMMITTEE_SIZE] building ($PROFILE) and forge build"
if [[ "$PROFILE" == "release" ]]; then
  (cd "$ROOT_DIR" && "$CARGO" build --release >/dev/null)
  BIN="$ROOT_DIR/target/release/crossroads-near-mpc-committee"
else
  (cd "$ROOT_DIR" && "$CARGO" build >/dev/null)
  BIN="$ROOT_DIR/target/debug/crossroads-near-mpc-committee"
fi
(cd "$ROOT_DIR" && "$FORGE" build >/dev/null)

echo "[size=$COMMITTEE_SIZE] starting anvil"
"$ANVIL" --host 127.0.0.1 --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" \
  --mnemonic "$MNEMONIC" --accounts "$((COMMITTEE_SIZE + 2))" --silent \
  >"$WORKDIR/anvil.log" 2>&1 &
ANVIL_PID="$!"
wait_for_rpc

DEPLOYER_PK="$("$CAST" wallet private-key "$MNEMONIC" 0)"
DEPLOYER_ADDRESS="$("$CAST" wallet address --private-key "$DEPLOYER_PK")"
SPENDER_PK="$("$CAST" wallet private-key "$MNEMONIC" "$SPENDER_INDEX")"
SPENDER_ADDRESS="$("$CAST" wallet address --private-key "$SPENDER_PK")"
DEPLOY_JSON="$WORKDIR/deployments/latest.json"

echo "[size=$COMMITTEE_SIZE] deploying bootstrap and mock assets"
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
ECDSA_ASSET="$(jq -r '.ecdsaAsset' "$DEPLOY_JSON")"
ED25519_ASSET="$(jq -r '.ed25519Asset' "$DEPLOY_JSON")"

echo "[size=$COMMITTEE_SIZE] registering $COMMITTEE_SIZE members"
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
    "$BOOTSTRAP" "${MEMBER_IDS[$i]}" "${ADMIN_ADDRS[$i]}" "${ENDPOINTS[$i]}" \
    "$bootstrap_pub" "$client_pub" --rpc-url "$RPC_URL")"
  attestation="$("$CAST" wallet sign --private-key "${ADMIN_PKS[$i]}" --no-hash "$digest")"
  "$CAST" send "$BOOTSTRAP" \
    'registerMember(bytes32,string,bytes32,bytes32,bytes)' \
    "${MEMBER_IDS[$i]}" "${ENDPOINTS[$i]}" "$bootstrap_pub" "$client_pub" "$attestation" \
    --private-key "${ADMIN_PKS[$i]}" --rpc-url "$RPC_URL" >/dev/null
done

"$CAST" send "$BOOTSTRAP" 'closeRegistration()' --private-key "$DEPLOYER_PK" --rpc-url "$RPC_URL" >/dev/null
"$CAST" send "$BOOTSTRAP" 'completeBootstrap()' --private-key "$DEPLOYER_PK" --rpc-url "$RPC_URL" >/dev/null

echo "[size=$COMMITTEE_SIZE] starting $COMMITTEE_SIZE committee nodes (real ports)"
for i in $(seq 0 $((COMMITTEE_SIZE - 1))); do
  node_dir="$WORKDIR/nodes/node-$((i + 1))"
  mkdir -p "$node_dir"
  COMMITTEE_LISTEN="127.0.0.1:$((NODE_PORT_BASE + i))" \
  COMMITTEE_SELF_MEMBER_ID="${MEMBER_IDS[$i]}" \
  EVM_RPC_URL="$RPC_URL" \
  BOOTSTRAP_CONTRACT="$BOOTSTRAP" \
  ECDSA_ROOT_SHARE_FILE="$node_dir/root-ecdsa.json" \
  ED25519_ROOT_SHARE_FILE="$node_dir/root-ed25519.json" \
  ADMIN_PRIVATE_KEY="${ADMIN_PKS[$i]}" \
  ECDSA_SIGNATURE_KIND="raw32" \
  RUST_LOG="$RUST_LOG" \
    "$BIN" >"$node_dir/service.log" 2>&1 &
  NODE_PIDS+=("$!")
done
for i in $(seq 0 $((COMMITTEE_SIZE - 1))); do
  wait_for_http "http://127.0.0.1:$((NODE_PORT_BASE + i))/healthz"
done

echo "[size=$COMMITTEE_SIZE] starting per-node proxies (delay=0 for DKG)"
start_proxies 0

echo "[size=$COMMITTEE_SIZE] running DKG (ECDSA + Ed25519 roots)"
for i in $(seq 0 $((THRESHOLD - 1))); do
  http_json POST "http://127.0.0.1:$((NODE_PORT_BASE + i))/v1/bootstrap/init" '{}' \
    "$WORKDIR/bootstrap-$((i + 1)).json" 200
done
http_json GET "http://127.0.0.1:$NODE_PORT_BASE/v1/bootstrap/status" '' "$WORKDIR/status.json" 200
jq -e '.schemes | all(.initialized == true and .root_record_active == true)' \
  "$WORKDIR/status.json" >/dev/null

ENC_A="$(hex32 0xA11CE)"
ENC_B="$(hex32 0xB0B)"
ECDSA_MESSAGE="$("$CAST" hash-message 'Hello world')"
ED25519_MESSAGE="0x68656c6c6f2d65643235353139"

"$CAST" send "$ECDSA_ASSET" 'setAllowed(address,bytes32,bool)' "$SPENDER_ADDRESS" "$ENC_A" true \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC_URL" >/dev/null
"$CAST" send "$ED25519_ASSET" 'setAllowed(address,bytes32,bool)' "$SPENDER_ADDRESS" "$ENC_B" true \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC_URL" >/dev/null

build_payload() {
  local asset="$1" enc="$2" message="$3" asset_lc canonical user_sig
  asset_lc="$(lower "$asset")"
  canonical="$(jq -cn --arg asset "$asset_lc" --arg enc "$enc" --arg message "$message" \
    '{asset_contract:$asset,encumbered_account:$enc,message:$message}')"
  user_sig="$("$CAST" wallet sign --private-key "$SPENDER_PK" "$canonical")"
  jq -cn --arg asset "$asset_lc" --arg enc "$enc" --arg message "$message" --arg user_signature "$user_sig" \
    '{asset_contract:$asset,encumbered_account:$enc,message:$message,user_signature:$user_signature}'
}

ECDSA_PAYLOAD="$(build_payload "$ECDSA_ASSET" "$ENC_A" "$ECDSA_MESSAGE")"
ED25519_PAYLOAD="$(build_payload "$ED25519_ASSET" "$ENC_B" "$ED25519_MESSAGE")"

# Client always targets node 0's real port, bypassing the proxy delay.
CLIENT_URL="http://127.0.0.1:$NODE_PORT_BASE/v1/sign"

run_trials() {
  # $1 scheme tag (ecdsa|ed25519); $2 payload; $3 csv path; $4 rtt_ms
  local scheme="$1" payload="$2" csv="$3" rtt="$4" t elapsed
  for t in $(seq 1 "$TRIALS"); do
    if elapsed="$(timed_post "$CLIENT_URL" "$payload" \
        "$WORKDIR/sign-${scheme}-${rtt}-$t.json" "$SIGN_TIMEOUT")"; then
      printf '%s\n' "$elapsed" >>"$csv"
    else
      echo "[size=$COMMITTEE_SIZE,rtt=${rtt}ms] $scheme trial $t exceeded ${SIGN_TIMEOUT}s; skipping rest of this cell" >&2
      return 1
    fi
  done
}

for rtt_ms in $LATENCIES; do
  per_dir_ms="$(awk -v r="$rtt_ms" 'BEGIN { printf "%g", r/2 }')"
  echo "[size=$COMMITTEE_SIZE,rtt=${rtt_ms}ms] restarting proxies (per-direction ${per_dir_ms}ms)"
  kill_proxies
  start_proxies "$per_dir_ms"

  SKIP_MARKER="$RESULTS_DIR/size-${COMMITTEE_SIZE}-rtt${rtt_ms}.skipped"
  rm -f "$SKIP_MARKER"

  declare -A SCHEME_PAYLOAD=(
    [ecdsa]="$ECDSA_PAYLOAD"
    [ed25519]="$ED25519_PAYLOAD"
  )

  skipped=0
  csvs=()
  for scheme in $SCHEMES; do
    csv="$RESULTS_DIR/size-${COMMITTEE_SIZE}-rtt${rtt_ms}-${scheme}.csv"
    rm -f "$csv"; : >"$csv"
    csvs+=("$csv")
  done

  # Warm-up at this delay per scheme (also subject to SIGN_TIMEOUT).
  if (( skipped == 0 )); then
    for scheme in $SCHEMES; do
      if ! timed_post "$CLIENT_URL" "${SCHEME_PAYLOAD[$scheme]}" \
          "$WORKDIR/warmup-${scheme}-${rtt_ms}.json" "$SIGN_TIMEOUT" >/dev/null; then
        echo "[size=$COMMITTEE_SIZE,rtt=${rtt_ms}ms] $scheme warm-up exceeded ${SIGN_TIMEOUT}s; skipping cell" >&2
        skipped=1; break
      fi
    done
  fi

  if (( skipped == 0 )); then
    idx=0
    for scheme in $SCHEMES; do
      echo "[size=$COMMITTEE_SIZE,rtt=${rtt_ms}ms] timing $TRIALS $scheme sign requests"
      run_trials "$scheme" "${SCHEME_PAYLOAD[$scheme]}" "${csvs[$idx]}" "$rtt_ms" \
        || { skipped=1; break; }
      idx=$((idx + 1))
    done
  fi

  if (( skipped == 1 )); then
    for csv in "${csvs[@]}"; do rm -f "$csv"; done
    touch "$SKIP_MARKER"
  fi
done

echo "[size=$COMMITTEE_SIZE] done; CSVs in $RESULTS_DIR"
