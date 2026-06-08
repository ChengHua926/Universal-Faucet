#!/usr/bin/env bash
set -euo pipefail

TYPE_DELAY="${TYPE_DELAY:-0.014}"
LINE_DELAY="${LINE_DELAY:-0.18}"
STEP_DELAY="${STEP_DELAY:-0.38}"

type_command() {
  local command="$1"
  local i
  printf '$ '
  for ((i = 0; i < ${#command}; i++)); do
    printf '%s' "${command:$i:1}"
    sleep "$TYPE_DELAY"
  done
  printf '\n'
  sleep "$STEP_DELAY"
}

print_block() {
  while IFS= read -r line; do
    printf '%s\n' "$line"
    sleep "$LINE_DELAY"
  done
  printf '\n'
}

printf '\033[2J\033[H'
printf 'drip core flow\n'
printf 'proof-of-work faucet CLI\n\n'
sleep 0.35

type_command "drip identity"
print_block <<'OUT'
Identity
  address: 0x5d3db8ed9c9d3a145650c2baba17a2e3f8ba8c35
  status:  ready
OUT

type_command "drip start --threads 1"
print_block <<'OUT'
Mining started
  threads: 1
  pool:    stratum+ssl://p3333.m269.opf-mainnet-rofl-55.rofl.app:443
  log:     ~/.config/drip/xmrig.log
OUT

type_command "drip status"
print_block <<'OUT'
Local miner
  status: running

Pool
  upstream: connected
  shares:   1
  work:     20,000
  owed:     740 atomic xmr
OUT

type_command "drip checkpoint"
print_block <<'OUT'
Voucher checkpoint
  cumulative: 740
  cache:      updated
OUT

type_command "drip withdraw base-sepolia eth 0x1111111111111111111111111111111111111111"
print_block <<'OUT'
Withdraw preview
  target:    base-sepolia eth
  recipient: 0x1111111111111111111111111111111111111111
  status:    ready for relayer handoff
OUT

type_command "drip stop"
print_block <<'OUT'
Mining stopped
  local XMRig process stopped
  voucher helper stopped
OUT

sleep 0.8
