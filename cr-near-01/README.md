# Crossroads × Universal Faucet

A permissionless cross-chain asset bridge on Oasis Sapphire: **deposit an asset on a
source chain (Ethereum Sepolia) → mint a wrapped Crossroads token on Sapphire → trade
it in an AMM → withdraw back out.** The signing committee is a single Sapphire
confidential contract (no MPC). The EVM path is live on testnet.

**Full run flow + deployed addresses → [REPORT.md](REPORT.md).**

## Sub-projects

- **[crossroads_oracle](crossroads_oracle)** — the TEE block-hash oracle (ROFL app, Python)
  and its Sapphire contracts: `HeaderReportOracle` and the contract-based signing committee
  `SapphireSigningCommittee`.
- **[backend_contracts](backend_contracts)** — the Crossroads asset/bridge contracts, the
  debug-free inclusion-proof tooling, the deposit/withdraw demo scripts, and the Uniswap-v2
  mining AMM (`scripts/crossroads-evm`, `scripts/mining-amm`).
- **[signing_committee](signing_committee)** — the older off-chain NEAR-MPC committee.
  Superseded by `SapphireSigningCommittee`; kept for reference, not used.

## How it works

1. A real tx on the source chain (Sepolia) → the TEE oracle recomputes & signs that block's
   hash in-enclave → it's relayed on Sapphire (`submitSignedHeader`).
2. The client builds a tx-inclusion proof from a plain `eth_getBlockByNumber` — no
   `debug_getRawBlock`, so any RPC works (self-checked against the header).
3. `asset.deposit(signedTx, proof)` verifies inclusion + the oracle's block hash, then mints.
4. To withdraw: lock the token → `SapphireSigningCommittee.sign` signs a source-chain tx in a
   confidential `eth_call` (gated by the asset's `canSign`) → broadcast → `finalizeWithdrawal`.

The mining AMM lets the Universal Faucet mining token (`MiningRewardToken`, minter-role —
the mining pool's TEE plugs in as the minter) trade against Crossroads assets.

## Quick start

See [REPORT.md](REPORT.md) for the ordered run flow. Free offline checks:

```sh
cd backend_contracts
node scripts/crossroads-evm/dev/validate-proof-rpc.mjs   # proof builder vs live Sepolia
npx hardhat test test/asset-accounting.ts                # asset accounting
```

Tooling: Node ≥22.10 (Hardhat 3); Foundry for the local committee harness; Docker/Kurtosis
only for the legacy MPC e2e in `signing_committee`.
