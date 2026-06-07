# Drip CLI

`drip` is the miner client for Universal Faucet.

Users install one CLI. They do not clone this repo, install XMRig, run Tor, or
configure pool endpoints.

```text
drip
  -> local EVM identity
  -> bundled XMRig
  -> ROFL RandomX pool
  -> faucet HTTP API
  -> local voucher cache
  -> withdraw handoff
```

This repo is CLI-only. Backend accounting, contracts, Crossroads routing,
relayer submission, and token delivery live outside this repo.

## Install

Give users the release archive:

```text
drip-darwin-arm64.tar.gz
```

Install:

```bash
mkdir -p ~/.local/opt ~/.local/bin
tar -xzf drip-darwin-arm64.tar.gz -C ~/.local/opt
ln -sf ~/.local/opt/drip-darwin-arm64/drip ~/.local/bin/drip
export PATH="$HOME/.local/bin:$PATH"
drip --help
```

If macOS blocks the unsigned binary:

```bash
xattr -dr com.apple.quarantine ~/.local/opt/drip-darwin-arm64
```

## Use

```bash
drip identity
drip start --threads 1
drip status
drip checkpoint
drip withdraw base-sepolia eth 0x1111111111111111111111111111111111111111
drip stop
```

For a disposable demo profile:

```bash
export DRIP_HOME=/private/tmp/drip-demo
```

Watch XMRig logs:

```bash
tail -f /private/tmp/drip-demo/xmrig.log
```

Production endpoints are built in:

```text
API  = https://p8080.m269.opf-mainnet-rofl-55.rofl.app
Pool = stratum+ssl://p3333.m269.opf-mainnet-rofl-55.rofl.app:443
```

## What Works

Verified live on 2026-06-07:

```text
drip starts bundled XMRig
XMRig connects to the ROFL pool over TLS/SNI
XMRig receives RandomX rx/0 jobs
accepted shares are credited by the faucet backend
drip status reads live pool/miner accounting
drip checkpoint caches a signed cumulative voucher
drip restore replays the cached voucher successfully
```

Current limit:

```text
drip withdraw captures chain/token/recipient intent, but final Crossroads or
relayer submission is not wired yet.
```

## Local State

Default profile location:

```text
~/.config/drip/
```

Files:

```text
config.json        local EVM private key + API/pool config
voucher.json       latest cumulative voucher
xmrig-config.json  generated XMRig config
xmrig.pid          local XMRig PID
xmrig.log          XMRig stdout/stderr
voucher-loop.pid   background checkpoint helper PID
voucher-loop.log   checkpoint helper log
```

The local EVM address is the Stratum username, voucher owner, and withdraw owner.

## Build

Build a macOS arm64 package:

```bash
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-drip.sh
```

Output:

```text
dist/drip-darwin-arm64.tar.gz
dist/drip-darwin-arm64.tar.gz.sha256
```

The archive bundles:

```text
drip
third_party/xmrig/darwin-arm64/xmrig
```

## Verify

```bash
cargo test --workspace
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-drip.sh
```

## Docs

```text
docs/cli-usage.md             concise user install/run guide
docs/demo-playbook.md         demo script and talking points
docs/faucet-integration.md    backend/API integration boundary
docs/handoff.md               technical handoff
docs/demo/drip-production-flow.gif
```
