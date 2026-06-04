# Crossroads EVM deposit demo (Sapphire testnet ← Sepolia, TEE block-hash oracle)

Proves the TEE-signed `HeaderReportOracle` works with a real Crossroads asset:
make a value transfer on **Ethereum Sepolia**, prove it on **Oasis Sapphire
testnet**, and mint the wrapped token.

```
 Sepolia (source)                         Sapphire testnet (backend)
 ────────────────                         ──────────────────────────
 deposit tx  ──┐                          CrossroadsAssetContract.deposit()
 (send ETH to  │   ┌─ TEE-signed header ─►  └─ BridgeOracle.verifyDeposit()
  encumbered   │   │   report (HTTP API)        ├─ HeaderReportOracle.getBlockHash(N)  ◄─ submitSignedHeader
  account)     │   │                            └─ ProvethVerifier (tx inclusion proof)
               └───┘                                 ▲
        inclusion proof built from eth_getBlockByNumber (no debug_getRawBlock)
```

`deposit()` mints `amount` wrapped tokens to the depositor once it verifies both
(1) the tx is in block `N` (Merkle proof) and (2) `keccak(header) ==
oracle.getBlockHash(N)`. The oracle's block hash is the one the TEE signed.

## Prerequisites

1. **Node ≥ 22.10** (Hardhat 3). On this machine: `export PATH="/opt/homebrew/bin:$PATH"`.
2. **A live oracle API URL.** The ROFL machine is ephemeral; get the current URL
   with `oasis rofl machine show` and pass it as `CROSSROADS_ORACLE_API`.
   (As of this writing the previous machine `p8080.m1561.…` is down — restart or
   redeploy it first.)
3. **A funded Sapphire testnet key** (`SAPPHIRE_PRIVATE_KEY`) — get TEST-ROSE from
   the Oasis faucet. Pays for the deploy + `submitSignedHeader` + `deposit`.
4. **A funded Sepolia key** (`SEPOLIA_PRIVATE_KEY`) — a little Sepolia ETH for the
   deposit tx. By default the depositor sends to *itself* (the encumbered account
   defaults to the depositor address), so only gas is actually spent.

The default oracle is the live multi-chain `HeaderReportOracle`
`0xa852946E2FfEb92FB8f06a8272cCE5323eCFE133` (Sepolia, quorum 2, 12 confs, TEE
signer `0xEd80…6308` registered). Override with `ORACLE_CONTRACT_ADDRESS`.

## Run

```sh
export PATH="/opt/homebrew/bin:$PATH"
export SAPPHIRE_PRIVATE_KEY=0x...      # funded with TEST-ROSE
export SEPOLIA_PRIVATE_KEY=0x...       # funded with Sepolia ETH
export CROSSROADS_ORACLE_API=https://p8080.<machine>.<...>.rofl.app

# 1. Deploy ProvethVerifier + TransactionSerializer + BridgeOracle + asset,
#    wired to the live oracle, and register the encumbered account.
npx hardhat run scripts/crossroads-evm/deploy-stack.ts --network sapphireTestnet
#    -> writes deployments/crossroads-evm-sapphire-23295.json

# 2. End-to-end deposit -> mint (sends on Sepolia, waits 12 confs, fetches +
#    submits the TEE report, builds the proof, calls deposit). ~3-4 min.
DEPOSIT_ETH=0.0003 \
  npx hardhat run scripts/crossroads-evm/deposit.ts --network sapphireTestnet
```

Optional — submit a report for the latest confirmed block without a deposit:

```sh
npx hardhat run scripts/crossroads-evm/submit-report.ts --network sapphireTestnet
```

## The debug-free inclusion proof

Public Sepolia RPCs don't expose `debug_getRawBlock`, so
[`getTxInclusionProofFromRpc`](../inclusion-proofs.ts) rebuilds the proof from a
plain `eth_getBlockByNumber` (full transactions):

- the RLP block header is reconstructed field-by-field and checked against
  `block.hash`;
- every transaction is re-serialized with ethers and the rebuilt trie root is
  checked against the header's `transactionsRoot`.

Both checks make a silent mis-encoding impossible — it throws instead of emitting
a bad proof. Validated against live Sepolia blocks (tx types 0/2/3). The
`debug_getRawBlock` variant (`getTxInclusionProof`) is kept for nodes that do
expose it.

## Withdrawal

[`withdraw-live.ts`](withdraw-live.ts) — full deposit → lock → sign → broadcast →
finalize. The withdrawal tx is signed by the **Sapphire-contract committee**
(`SapphireSigningCommittee`, in `crossroads_oracle/contracts`) in one confidential
`eth_call` — no MPC, no nodes, no DKG.

## Dev validators (no keys needed)

In [`dev/`](dev/), run from `backend_contracts/`:
`node scripts/crossroads-evm/dev/validate-proof-rpc.mjs` (proof vs live Sepolia),
`node scripts/crossroads-evm/dev/validate-submit.mjs` (report digest/signature vs
fixture), and `npx hardhat run scripts/crossroads-evm/dev/smoke-proof.ts
--network hardhatMainnet` (the exported `buildDepositProof`).
