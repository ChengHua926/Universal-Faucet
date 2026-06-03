# Shared helpers sourced by scripts/e2e-*.sh
# Provides: PIDS array, cleanup trap, require_cmd, wait_for_evm_rpc,
# wait_for_solana_rpc, start_anvil, deploy_committee_bootstrap, plus the
# common foundry/cargo binary paths.
#
# Conventions:
#   ROOT_DIR              backend_contracts/ (set by caller)
#   REPO_ROOT             repo root (set by caller)
#   SIGNING_COMMITTEE_DIR repo_root/signing_committee
#   EXTRA_CLEANUP         optional array of shell strings eval'd in cleanup()
# shellcheck shell=bash

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="${REPO_ROOT:-$(cd "$ROOT_DIR/.." && pwd)}"
SIGNING_COMMITTEE_DIR="${SIGNING_COMMITTEE_DIR:-$REPO_ROOT/signing_committee}"

ANVIL="${ANVIL:-$HOME/.foundry/bin/anvil}"
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"
CAST="${CAST:-$HOME/.foundry/bin/cast}"
CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"

DEFAULT_MNEMONIC="test test test test test test test test test test test junk"
PIDS=()
EXTRA_CLEANUP=()

cleanup() {
  local status=$?
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "${PIDS[@]:-}" 2>/dev/null || true
  for hook in "${EXTRA_CLEANUP[@]:-}"; do
    eval "$hook" || true
  done
  exit "$status"
}
trap cleanup EXIT

require_cmd() {
  if [[ ! -x "$1" ]] && ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

wait_for_evm_rpc() {
  local url="$1"
  for _ in $(seq 1 240); do
    if curl -fsS -m 2 -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  echo "EVM RPC did not become ready at $url" >&2
  exit 1
}

wait_for_solana_rpc() {
  local url="$1" log="${2:-}"
  for _ in $(seq 1 240); do
    if curl -fsS -m 2 -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  echo "Solana validator RPC did not become ready at $url" >&2
  [[ -n "$log" && -f "$log" ]] && cat "$log" >&2 || true
  exit 1
}

start_anvil() {
  local port="$1" chain_id="$2" mnemonic="$3" log="$4"
  "$ANVIL" --host 127.0.0.1 --port "$port" --chain-id "$chain_id" \
    --mnemonic "$mnemonic" --accounts 10 --silent >"$log" 2>&1 &
  PIDS+=("$!")
  wait_for_evm_rpc "http://127.0.0.1:$port"
}

deploy_committee_bootstrap() {
  local deployment_path="$1" deployer_addr="$2" deployer_key="$3" rpc_url="$4" log="$5"
  local threshold="${COMMITTEE_THRESHOLD:-2}"
  mkdir -p "$(dirname "$deployment_path")"
  (
    cd "$SIGNING_COMMITTEE_DIR"
    DEPLOYMENT_PATH="$deployment_path" \
    DEPLOYER_ADDRESS="$deployer_addr" \
    DEPLOYER_PRIVATE_KEY="$deployer_key" \
    COMMITTEE_THRESHOLD="$threshold" \
      "$FORGE" script script/E2EDeploy.s.sol \
        --rpc-url "$rpc_url" --broadcast --private-key "$deployer_key" >"$log" 2>&1
  )
}

build_signing_committee() {
  (cd "$SIGNING_COMMITTEE_DIR" && "$CARGO" build >/dev/null)
}
