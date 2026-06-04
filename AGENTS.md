# Universal Faucet Agent Context

This project is a universal proof-of-work faucet, not a Monero points pool.

Users install only our CLI, `drip`. They should not install or manually run
XMRig. The CLI owns enrollment, payout intent capture, local XMRig
configuration, process lifecycle, status, and logs.

Primary user-facing shape:

```text
drip <chain> <token> <recipient-address>
```

Example:

```text
drip base-sepolia eth 0x...
```

Internal mining flow:

```text
user CLI
  -> bundled/managed XMRig
  -> our Stratum Gate
  -> XMRig Proxy
  -> upstream RandomX/Monero mining pool
```

Economic flow:

```text
upstream pool pays our pool wallet
  -> backend/TEE accounts accepted work
  -> internal paper-share / mining pool token credit
  -> Crossroads swaps/routes value
  -> user receives requested token on requested chain
```

The mining pool token is an internal ERC-20-style accounting and redemption
layer. Users receive it only if explicitly requested. Normal product behavior is
to route value through Crossroads into the requested chain/token/address.

## Current Team Scope

This repo's current implementation scope is the mining pool and CLI component:

- Rust CLI
- bundled or managed XMRig
- Stratum Gate for miner auth, replay rejection, stale-share policy, and stats
- XMRig Proxy integration
- upstream RandomX/Monero pool integration
- backend accounting service
- Postgres share/credit ledger
- placeholder Crossroads and contract integration boundaries

Other teammates own the smart contracts and Crossroads swap/bridge layer. In
this repo, represent those systems with clear interfaces, placeholder status
transitions, and documentation. Do not implement the swap/bridge itself unless
explicitly asked.

Contract/Crossroads integration details live in
`docs/crossroads-contract-integration.md`. Update that file when changing
handoff tables, status transitions, or adapter semantics.

Current component handoff details live in `docs/component-handoff.md`. Read that
file after this one when starting a new mining/CLI/backend task.

The backend is expected to eventually authorize or sign an on-chain action that
credits the user with paper-share/mining-pool-token value. Until the contract is
ready, keep this as a documented adapter boundary with testable placeholder
behavior.

## Architecture Guardrails

Do not regress the architecture into:

- a Monero stagenet demo
- a user-visible mining pool dashboard as the main product
- manual XMRig installation by users
- direct Monero-to-everything bridging
- custom RandomX mining code in the CLI
- hidden, background, or autostart mining

The user must explicitly start mining and must be able to stop it. The CLI must
show thread count, local mining status, and enough logs/status for debugging.

## Owned Integration Boundary

Expose clean integration points for external systems:

- payout intent: target chain, target token, recipient address
- share accounting: accepted work, rejected work, total hashes, paper-share
  credit
- settlement request: user/account, amount, destination, idempotency key
- settlement status: pending, processing, submitted, confirmed, failed, replaced
- audit trail: share deltas, credit deltas, settlement attempts, transaction IDs

Crossroads/contracts can replace the placeholder settlement adapter later
without changing miner auth, share accounting, or CLI process management.

## Naming

The user-facing CLI binary is `drip`. Internal Rust crate/service names may
still use `xpool-*` while the mining prototype is being productized.
