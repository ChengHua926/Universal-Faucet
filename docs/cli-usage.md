# Drip CLI Usage

## Install

Users do not clone the repo and do not install XMRig.

Give them the release archive:

```text
drip-darwin-arm64.tar.gz
```

Install:

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

## Use

Create identity:

```bash
drip identity
```

Start mining:

```bash
drip start --threads 1
```

Check status:

```bash
drip status
```

Request a voucher:

```bash
drip checkpoint
```

Choose desired output token:

```bash
drip withdraw base-sepolia eth 0x1111111111111111111111111111111111111111
```

Stop mining:

```bash
drip stop
```

## Observe

Logs:

```bash
tail -f ~/.config/drip/xmrig.log
```

Clean demo profile:

```bash
export DRIP_HOME=/private/tmp/drip-demo
```

With `DRIP_HOME` set, logs are at:

```text
/private/tmp/drip-demo/xmrig.log
```

## Defaults

Production endpoints are built in:

```text
API  = https://p8080.m269.opf-mainnet-rofl-55.rofl.app
Pool = stratum+ssl://p3333.m269.opf-mainnet-rofl-55.rofl.app:443
```

No environment variables are required for normal use.

## Current Limit

Mining, live status, voucher checkpoint, and voucher restore work.

Final token delivery is not wired yet. `drip withdraw` records the target
chain/token/address and renders the handoff preview.
