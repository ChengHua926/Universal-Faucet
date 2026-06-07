# Universal Faucet Agent Context

Never add yourself as co-author in commits or PR messages.

This repo now owns only the miner client:

```text
Rust CLI binary: drip
local EVM keypair/address
local voucher cache
bundled/managed XMRig
local process lifecycle
local status/UX
release packaging for drip + XMRig
```

Out of scope in this repo:

```text
backend
Stratum gate
XMRig Proxy
Postgres accounting
share validation
contracts
Crossroads routing/swap/bridge
relayer service
```

Do not reintroduce backend/gate/proxy/Postgres architecture here. The backend is
owned elsewhere.

Current client model:

```text
drip
  -> load or generate Ethereum secp256k1 keypair
  -> address is XMRig username and token owner
  -> start bundled XMRig
  -> periodically POST /voucher
  -> store latest cumulative voucher locally
  -> prepare claim/withdraw handoff commands
```

Required backend API shape:

```text
GET  /pool
GET  /miner/:addr
GET  /onion
GET  /state/:addr
POST /voucher
POST /restore
```

Voucher rule:

```text
keep exactly one local voucher: highest cumulative_amount wins
```

The CLI must never expose the private key in generated XMRig config or normal
status output.

The user must explicitly run mining. Do not add hidden mining, autostart mining,
or boot-time persistence.

Primary docs:

```text
docs/handoff.md
docs/cli-ux.md
```

The Rust crate is `drip-cli`; the binary is `drip`.
