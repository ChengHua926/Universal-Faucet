# Drip CLI Handoff

## 1. Runtime Flow

```text
drip start
  -> load/create local Ethereum secp256k1 identity
  -> generate xmrig-config.json
  -> start bundled XMRig
  -> XMRig mines with user = 0x<local-address>
  -> background helper periodically POSTs /voucher
  -> highest cumulative voucher is cached locally
```

Normal user command shape:

```text
drip withdraw <chain> <token> <recipient-address> --refresh
```

`claim` and `withdraw` currently prepare the voucher handoff. Final on-chain
submission waits on the external contract/relayer interface.

## 2. Commands

```bash
drip identity
drip start --threads 2
drip resume --threads 2
drip stop
drip status
drip checkpoint
drip restore
drip claim --refresh
drip withdraw base-sepolia eth 0x1111111111111111111111111111111111111111 --refresh
```

## 3. Local State

```text
$DRIP_HOME/config.json        API/pool config + local Ethereum private key
$DRIP_HOME/voucher.json       latest cumulative voucher only
$DRIP_HOME/xmrig-config.json  generated XMRig config
$DRIP_HOME/xmrig.pid          local XMRig PID
$DRIP_HOME/xmrig.log          XMRig stdout/stderr
$DRIP_HOME/voucher-loop.pid   voucher helper PID
$DRIP_HOME/voucher-loop.log   voucher helper failures/retries
```

The Ethereum address is the XMRig username, voucher user, and token owner. The
private key must not be written to XMRig config or normal status output.

## 4. Environment

```bash
DRIP_HOME=/private/tmp/drip-demo
DRIP_API_BASE_URL=http://127.0.0.1:8081
DRIP_POOL_URL=127.0.0.1:3333
DRIP_POOL_TLS=false
DRIP_XMRIG_PATH=/optional/path/to/xmrig
```

## 5. Backend Contract

Required API:

```text
GET  /miner/:addr
GET  /state/:addr
POST /voucher
POST /restore
```

Voucher request:

```json
{ "user": "0x<addr>", "amount": null }
```

Voucher response/local cache:

```json
{
  "user": "0x...",
  "cumulative_amount": "12345",
  "signed_at": 1780000000,
  "signature": "0x..."
}
```

Rule: keep exactly one local voucher. Highest decimal `cumulative_amount` wins.
Failed voucher requests are logged and retried; they do not stop mining.

## 6. XMRig

Users do not install or run XMRig manually.

Generated pool config:

```text
url       = DRIP_POOL_URL / config.mining_pool_url
user      = local Ethereum address
pass      = x
rig-id    = local Ethereum address
tls       = DRIP_POOL_TLS / config.mining_pool_tls
cpu.rx    = one -1 affinity entry per requested thread
donations = disabled in packaged source build
```

Packaging:

```bash
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-xmrig.sh
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-drip.sh
```

## 7. Verification

```bash
cargo test --workspace
cargo run -p drip-cli -- --help
cargo run -p drip-cli -- identity
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-drip.sh
```

Demo artifact:

```text
docs/demo/drip-cli-ux.gif
```
