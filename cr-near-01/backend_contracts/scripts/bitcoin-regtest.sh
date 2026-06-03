#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CONTAINER="${BITCOIN_REGTEST_CONTAINER:-backend-contracts-bitcoin-regtest}"
IMAGE="${BITCOIN_IMAGE:-bitcoin/bitcoin:27.0}"
RPC_USER="${BITCOIN_RPC_USER:-crossroads}"
RPC_PASSWORD="${BITCOIN_RPC_PASSWORD:-crossroads}"
RPC_PORT="${BITCOIN_RPC_PORT:-18443}"
RPC_URL="http://$RPC_USER:$RPC_PASSWORD@127.0.0.1:$RPC_PORT"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_rpc() {
  for _ in $(seq 1 120); do
    if curl -fsS -m 2 \
      --user "$RPC_USER:$RPC_PASSWORD" \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"1.0","id":1,"method":"getblockchaininfo","params":[]}' \
      "http://127.0.0.1:$RPC_PORT" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done
  echo "Bitcoin regtest RPC did not become ready at $RPC_URL" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
}

cleanup
docker run -d --name "$CONTAINER" \
  -p "$RPC_PORT:18443" \
  "$IMAGE" \
  -regtest=1 \
  -server=1 \
  -rpcbind=0.0.0.0 \
  -rpcallowip=0.0.0.0/0 \
  -rpcuser="$RPC_USER" \
  -rpcpassword="$RPC_PASSWORD" \
  -fallbackfee=0.0001 \
  -txindex=1 >/dev/null

wait_for_rpc

cd "$ROOT_DIR"
BITCOIN_RPC_URL="$RPC_URL" npm run test:bitcoin
