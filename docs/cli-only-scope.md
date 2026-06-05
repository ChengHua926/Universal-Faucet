# CLI-Only Scope Handoff

Current ownership:

```text
drip CLI
local keypair
local XMRig process
local voucher cache
claim/withdraw handoff UX
release package
```

External ownership:

```text
pool backend
Stratum infrastructure
voucher signer
MiningPoolToken contract
withdraw relayer
Crossroads routes/swaps
```

## Identity

On first use, `drip` creates:

```text
$DRIP_HOME/config.json
```

It stores:

```text
Ethereum secp256k1 private key
Ethereum address
API base URL
Stratum pool URL/TLS
voucher interval
```

The Ethereum address is:

```text
XMRig username
on-chain token owner
voucher user
```

The private key is never written to XMRig config.

## Mining

`drip start`:

```text
load/create identity
write xmrig-config.json
start bundled XMRig
write xmrig.pid
start voucher-loop helper
write voucher-loop.pid
```

Generated XMRig pool fields:

```text
url    = mining_pool_url
user   = Ethereum address
pass   = x
rig-id = Ethereum address
tls    = mining_pool_tls
```

## Voucher Loop

The helper wakes every `voucher_interval_seconds`, default 300:

```http
POST /voucher
{ "user": "0x<addr>", "amount": null }
```

It stores only the latest cumulative voucher:

```json
{
  "user": "0x...",
  "cumulative_amount": "12345",
  "signed_at": 1780000000,
  "signature": "0x..."
}
```

If the returned voucher is older than the local one, it is ignored. Failed
requests are logged and retried next tick. They do not stop mining.

## Status

`drip status` reads:

```text
xmrig.pid
config.json
voucher.json
GET /miner/:addr
```

It prints:

```text
local miner state
Ethereum address
pool hashrate/shares/owed/paid if backend is reachable
cached voucher cumulative amount
```

## Redemption

Implemented locally:

```text
drip checkpoint
drip restore
drip claim --refresh
drip withdraw <chain> <token> <recipient> --refresh
```

`claim` and `withdraw` currently prepare and display the local voucher handoff.
Actual transaction/relayer submission needs final external contract/relayer
configuration.

## Active Files

```text
cli/
scripts/package-drip.sh
scripts/package-xmrig.sh
.github/workflows/package-drip.yml
.github/workflows/package-xmrig.yml
docs/cli-only-scope.md
docs/cli-ux.md
docs/demo/drip-cli-ux.tape
```
