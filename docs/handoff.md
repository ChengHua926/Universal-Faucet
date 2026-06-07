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
DRIP_API_BASE_URL=https://p8080.m269.opf-mainnet-rofl-55.rofl.app
DRIP_POOL_URL=stratum+ssl://p3333.m269.opf-mainnet-rofl-55.rofl.app:443
DRIP_POOL_TLS=true                    # optional explicit override
DRIP_TOR_SOCKS5=socks5://localhost:9050  # optional Tor fallback only
DRIP_XMRIG_PATH=/optional/path/to/xmrig
```

## 5. Backend Contract

Required API:

```text
GET  /miner/:addr
GET  /pool
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

For the ROFL faucet pool, use the production `stratum+ssl://...rofl.app:443`
Stratum URL. `drip` enables SNI in the generated XMRig config for `rofl.app`
hosts. Operator relay and Tor onion endpoints are fallback paths.

Generated pool config:

```text
url       = DRIP_POOL_URL / config.mining_pool_url
user      = local Ethereum address
pass      = x
rig-id    = local Ethereum address
tls       = DRIP_POOL_TLS / config.mining_pool_tls
sni       = true for rofl.app pool hosts
socks5    = DRIP_TOR_SOCKS5 / config.tor_socks5, when set
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

Live production smoke verified on 2026-06-07:

```text
API /pool reachable and upstream connected
bundled XMRig connected to ROFL stratum with tls=true, sni=true, coin=monero
one accepted share credited to the CLI Ethereum address
checkpoint returned and cached a signed cumulative voucher
restore replayed the voucher successfully
withdraw currently renders the target chain/token/address handoff only
```

Demo artifact:

```text
docs/demo/drip-production-flow.gif
```

Faucet integration boundary:

```text
docs/faucet-integration.md
```
