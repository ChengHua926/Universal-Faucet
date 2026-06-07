# Drip Demo Playbook

## 1. What To Show

Use this GIF:

```text
docs/demo/drip-production-flow.gif
```

It shows the user flow:

```text
install drip
drip identity
drip start --threads 1
drip status
drip checkpoint
drip withdraw base-sepolia eth 0x...
drip stop
```

The GIF replays the live production smoke result from 2026-06-07. It is
deterministic and does not start a miner while rendering.

## 2. Current Product Claim

Say this:

```text
The drip CLI is live against the faucet backend. It bundles XMRig, creates a
local Ethereum mining identity, mines RandomX against the ROFL pool, reads live
pool/miner accounting, checkpoints signed vouchers, and captures the target
chain/token/address for the withdrawal handoff.
```

Do not claim final token delivery yet.

```text
Final Crossroads/relayer submission is still a handoff boundary. The CLI
currently renders the withdrawal preview instead of submitting a token delivery
transaction.
```

## 3. Build A Demo Package

From the repo:

```bash
cd /Users/chenghua/workspace/Universal-Faucet
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-drip.sh
```

Output:

```text
dist/drip-darwin-arm64.tar.gz
dist/drip-darwin-arm64.tar.gz.sha256
```

The archive contains:

```text
drip-darwin-arm64/drip
drip-darwin-arm64/third_party/xmrig/darwin-arm64/xmrig
```

Users do not install XMRig.

## 4. Tester Install

Testers do not clone this repo.

Give testers `drip-darwin-arm64.tar.gz`.

```bash
mkdir -p ~/.local/opt ~/.local/bin
tar -xzf drip-darwin-arm64.tar.gz -C ~/.local/opt
ln -sf ~/.local/opt/drip-darwin-arm64/drip ~/.local/bin/drip
export PATH="$HOME/.local/bin:$PATH"
```

If macOS blocks the unsigned binary:

```bash
xattr -dr com.apple.quarantine ~/.local/opt/drip-darwin-arm64
```

Verify:

```bash
drip --help
```

## 5. Tester Run

Use a clean profile for demos:

```bash
export DRIP_HOME=/private/tmp/drip-demo
```

Run:

```bash
drip identity
drip start --threads 1
drip status
tail -f /private/tmp/drip-demo/xmrig.log
drip checkpoint
drip withdraw base-sepolia eth 0x1111111111111111111111111111111111111111
drip stop
```

Production defaults:

```text
API  = https://p8080.m269.opf-mainnet-rofl-55.rofl.app
Pool = stratum+ssl://p3333.m269.opf-mainnet-rofl-55.rofl.app:443
```

## 6. Live Smoke Evidence

Verified on 2026-06-07:

```text
XMRig connected over TLSv1.3
XMRig received rx/0 RandomX job
XMRig submitted 1 accepted share
/miner credited shares=1, work=20000, cumulative_owed_atomic=740
drip checkpoint cached cumulative voucher 740
drip restore replayed voucher successfully
```

Known caveat:

```text
One smoke run later logged read error: "end of file" after the accepted share.
Do a longer connection-stability run before presenting this as production-stable
mining uptime.
```
