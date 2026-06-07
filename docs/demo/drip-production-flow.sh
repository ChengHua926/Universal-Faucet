#!/usr/bin/env bash
set -euo pipefail

TYPE_DELAY="${TYPE_DELAY:-0.025}"
LINE_DELAY="${LINE_DELAY:-0.55}"
SECTION_DELAY="${SECTION_DELAY:-1.35}"

type_line() {
  local text="$1"
  local i
  for ((i = 0; i < ${#text}; i++)); do
    printf '%s' "${text:$i:1}"
    sleep "$TYPE_DELAY"
  done
  printf '\n'
}

print_block() {
  while IFS= read -r line; do
    printf '%s\n' "$line"
    sleep "$LINE_DELAY"
  done
}

run_step() {
  local title="$1"
  local command="$2"
  printf '\n'
  printf '# %s\n' "$title"
  sleep "$SECTION_DELAY"
  type_line "$ $command"
}

clear
printf 'drip production demo\n'
printf 'Universal proof-of-work faucet CLI\n'
sleep 1.5

run_step "install the packaged CLI" "tar -xzf drip-darwin-arm64.tar.gz -C ~/.local/opt"
run_step "put drip on PATH" "ln -sf ~/.local/opt/drip-darwin-arm64/drip ~/.local/bin/drip"
run_step "verify the binary" "drip --help"
print_block <<'OUT'
Run local proof-of-work for faucet credit

Commands:
  identity    Show or create the local Ethereum mining identity
  start       Start local proof-of-work and background voucher checkpoints
  status      Show local miner, pool, and voucher status
  checkpoint  Request and cache the latest cumulative voucher
  withdraw    Prepare withdrawal into a target chain/token/address
  stop        Stop local proof-of-work
OUT

run_step "create the local mining identity" "drip identity"
print_block <<'OUT'
Identity
  address: 0x5d3db8ed9c9d3a145650c2baba17a2e3f8ba8c35
  profile: ~/.config/drip/config.json
  status:  created
OUT

run_step "start mining with bundled XMRig" "drip start --threads 1"
print_block <<'OUT'
Mining started
  address:  0x5d3db8ed9c9d3a145650c2baba17a2e3f8ba8c35
  pid:      90340
  threads:  1
  pool:     stratum+ssl://p3333.m269.opf-mainnet-rofl-55.rofl.app:443
  voucher:  every 300s
  log:      ~/.config/drip/xmrig.log

Observe:
  drip status
OUT

run_step "watch the miner connect" "tail -n 12 ~/.config/drip/xmrig.log"
print_block <<'OUT'
POOL #1 stratum+ssl://p3333.m269.opf-mainnet-rofl-55.rofl.app:443 coin Monero
net  use pool p3333.m269.opf-mainnet-rofl-55.rofl.app:443 TLSv1.3
net  new job diff 20000 algo rx/0 height 3691255
cpu  READY threads 1/1
cpu  accepted (1/0) diff 20000
OUT

run_step "read live faucet accounting" "drip status"
print_block <<'OUT'
Local miner
  status: running

Pool
  upstream: connected
  hashrate: 38,720.32 H/s
  active miners: 5

Miner credit
  owed atomic xmr:   740
  voucher watermark: 0
  shares:            1
  work:              20,000
OUT

run_step "request a signed cumulative voucher" "drip checkpoint"
print_block <<'OUT'
Voucher checkpoint
  address:    0x5d3db8ed9c9d3a145650c2baba17a2e3f8ba8c35
  cumulative: 740
  signed_at:  1780854770
  cache:      updated
OUT

run_step "choose the token and recipient" "drip withdraw base-sepolia eth 0x1111111111111111111111111111111111111111"
print_block <<'OUT'
Withdraw preview
  owner:      0x5d3db8ed9c9d3a145650c2baba17a2e3f8ba8c35
  cumulative: 740
  target:     base-sepolia eth
  recipient:  0x1111111111111111111111111111111111111111

Relayer submission needs the final withdraw endpoint/config.
OUT

run_step "stop mining" "drip stop"
print_block <<'OUT'
Mining stopped
  miner pid: 90340
  voucher helper pid: 90341
OUT

printf '\nDemo status\n'
printf '  mining, status, checkpoint, restore: live verified\n'
printf '  final token delivery: waiting on withdraw endpoint\n'
sleep 4
