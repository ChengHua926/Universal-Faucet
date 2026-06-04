# Crossroads × Universal Faucet

A permissionless cross-chain asset bridge on Oasis Sapphire: **deposit an asset on a
source chain (Ethereum Sepolia) → mint a wrapped Crossroads token on Sapphire → trade
it in an AMM → withdraw back out.** The signing committee is a single Sapphire
confidential contract (no MPC). The EVM path is live on testnet.

## On-chain components

All contracts live on Oasis Sapphire.

- **[crossroads_oracle/contracts](crossroads_oracle/contracts)** — `HeaderReportOracle` (holds
  TEE-signed source-chain block hashes) and `SapphireSigningCommittee` (the confidential
  signing-committee contract).
- **[backend_contracts](backend_contracts)** — the Crossroads asset/bridge contracts, the
  debug-free inclusion-proof tooling, the deposit/withdraw demo (`scripts/crossroads-evm`), and
  the Uniswap-v2 mining AMM (`scripts/mining-amm`).

## How it works

1. A real tx on the source chain (Sepolia) → the TEE oracle recomputes & signs that block's
   hash in-enclave → relayed on Sapphire (`submitSignedHeader`).
2. The client builds a tx-inclusion proof from a plain `eth_getBlockByNumber` — no
   `debug_getRawBlock`, so any RPC works (self-checked against the header).
3. `asset.deposit(signedTx, proof)` verifies inclusion + the oracle's block hash, then mints.
4. Withdraw: lock the token → `SapphireSigningCommittee.sign` signs a source-chain tx in a
   confidential `eth_call` (gated by the asset's `canSign`) → broadcast → `finalizeWithdrawal`.

The mining AMM lets the mining token (`MiningRewardToken`, minter-role) trade against
Crossroads assets.

## Run flow

**Prerequisites**
- `export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"` (Node ≥22.10 + Foundry)
- A funded **Sapphire testnet** key (TEST-ROSE) and a funded **Sepolia** key (Sepolia ETH).
- TEE oracle running: `oasis rofl deploy --replace-machine` → `oasis rofl machine show` → copy
  the `https://p8080.….rofl.app` URL.
- Put both keys + the URL in `backend_contracts/.env.demo-keys`, then before each run:
  `set -a; source .env.demo-keys; set +a`

**In `crossroads_oracle/contracts`**
```sh
# 1. Block-hash oracle (one per source chain; the TEE auto-registers its signer on first use).
PRIVATE_KEY=$SAPPHIRE_PRIVATE_KEY ROFL_APP_ID=0x002339e39056f12efc2e8f1476a871e22555bc4e49 \
SOURCE_CHAIN_ID=11155111 MIN_CONFIRMATIONS=3 SOURCE_RPC_QUORUM=2 \
SOURCE_RPC_URLS=https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org,https://public.1rpc.io/sepolia \
  npx hardhat run scripts/deploy-header-oracle.js --network sapphire-testnet   # → oracle address

# 2. Signing committee (the Sapphire contract); deploys + self-tests.
PRIVATE_KEY=$SAPPHIRE_PRIVATE_KEY \
  npx hardhat run scripts/test-sapphire-committee.js --network sapphire-testnet # → committee address
```

**In `backend_contracts`**
```sh
# 3. Bridge + asset (crsETH), wired to the oracle from step 1.
ORACLE_CONTRACT_ADDRESS=<oracle> npx hardhat run scripts/crossroads-evm/deploy-stack.ts --network sapphireTestnet
# 4. Deposit -> mint crsETH (real Sepolia tx).
npx hardhat run scripts/crossroads-evm/deposit.ts --network sapphireTestnet
# 5. Withdraw — deposit -> lock -> committee-sign -> finalize.
COMMITTEE_ADDRESS=<committee> npx hardhat run scripts/crossroads-evm/withdraw-live.ts --network sapphireTestnet
# 6. AMM: Uniswap v2 + mining token + pools + a swap.
npx hardhat run scripts/mining-amm/deploy-amm.ts --network sapphireTestnet
```

## Deployed (Sapphire testnet, chainId 23295)

- **Signing committee:** `0xDa3dFdEa5C52C56c3F667e00Df90eCEaA7faDEf5`
- **3-conf stack:** oracle `0x3045628524530CB056D74Eacd2C4F0b0A6Bf4388`, asset crsETH `0x52B56eEFE06B54f9cf323310Bf3CDa5bfecD87a3`
- **12-conf stack:** oracle `0xa852946E2FfEb92FB8f06a8272cCE5323eCFE133`, asset crsETH `0x22d3Fb59c21940645E4c212316f33c898402eAF5`
- **AMM:** Factory `0x39924Df94Cc639654DdCF74ededCA428Ca285582`, Router `0x94Aa01382f7c64F98D591Af04A179A76fED5da69`
- **Oracle API:** ephemeral — get the current URL from `oasis rofl machine show`

## Tests

Offline (no keys, free):
```sh
cd backend_contracts
node scripts/crossroads-evm/dev/validate-proof-rpc.mjs   # debug-free proof vs live Sepolia
node scripts/crossroads-evm/dev/validate-submit.mjs      # report digest/sig vs the saved fixture
npx hardhat test test/asset-accounting.ts                # asset accounting (5 tests)
```
On-chain isolation test of the committee: `crossroads_oracle/contracts/scripts/test-sapphire-committee.js`
(deterministic derivation, signature recovers to the derived address, `canSign` gating).

Live end-to-end (verified on testnet): **deposit→mint**, **contract-signed withdrawal**
(epoch 0→1), **AMM swap** (100 dcrETH → 197.43 UFM).

## Mining-pool integration seam

`MiningRewardToken` has a minter role: `setMinter(poolTee, true)`, then the pool's TEE calls
`mint(miner, amount)` as it attests mining output. Rewards trade against Crossroads assets in
the AMM.

## Not done

Other source chains (BTC/Solana), real mining backing for the token, production hardening
(contract TODOs, audit, committee key recovery/attestation, mainnet).
