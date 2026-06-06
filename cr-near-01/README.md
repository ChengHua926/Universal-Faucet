# Crossroads × Universal Faucet

A permissionless cross-chain asset bridge on Oasis Sapphire: **deposit an asset on a
source chain (Ethereum Sepolia) → mint a wrapped Crossroads token on Sapphire → trade
it in an AMM → withdraw back out.** The signing committee is a single Sapphire
confidential contract (no MPC). The EVM path is live on testnet.

## On-chain components

All contracts live on Oasis Sapphire.

- **[crossroads_oracle/contracts](crossroads_oracle/contracts)** — `HeaderReportOracle` (holds
  TEE-signed source-chain block hashes) and `SigningCommittee` (the confidential EIP-712
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
4. Withdraw: lock the token → the spender authorizes an EIP-712 `SignRequest` → `SigningCommittee.sign`
   signs a source-chain tx in a confidential `eth_call` (gated by the asset's `canSign`), returning the
   raw Sapphire DER signature (the client splits it + recovers `v`) → broadcast → `finalizeWithdrawal`.

The mining AMM lets the mining token (`MiningRewardToken`, minter-role) trade against
Crossroads assets.

## Run flow

**Prerequisites**
- `export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"` (Node ≥22.10 + Foundry)
- A funded **Sapphire testnet** key (TEST-ROSE) and a funded **Sepolia** key (Sepolia ETH).
- TEE oracle running: `oasis rofl deploy --replace-machine` → `oasis rofl machine show` → copy
  the `https://p8080.….rofl.app` URL. (Rentals are short/non-refundable; keep it alive
  unattended with `crossroads_oracle/rofl-autorenew.sh` — see
  [ROFL-AUTORENEW.md](crossroads_oracle/ROFL-AUTORENEW.md).)
- Put both keys + the URL in `backend_contracts/.env.demo-keys`, then before each run:
  `set -a; source .env.demo-keys; set +a`

**In `crossroads_oracle/contracts`**
```sh
# 1. Block-hash oracle (one per source chain; the TEE auto-registers its signer on first use).
PRIVATE_KEY=$SAPPHIRE_PRIVATE_KEY ROFL_APP_ID=0x002339e39056f12efc2e8f1476a871e22555bc4e49 \
SOURCE_CHAIN_ID=11155111 MIN_CONFIRMATIONS=3 SOURCE_RPC_QUORUM=2 \
SOURCE_RPC_URLS=https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org,https://public.1rpc.io/sepolia \
  npx hardhat run scripts/deploy-header-oracle.js --network sapphire-testnet   # → oracle address

# 2. Signing committee (the Sapphire contract). bytes32(0) seed => enclave-generated root (no backdoor).
PRIVATE_KEY=$SAPPHIRE_PRIVATE_KEY \
  npx hardhat run scripts/deploy-committee.js --network sapphire-testnet # → committee address
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

## Onboard a new token / chain (one command)

List a new Crossroads token on **any EVM source chain** in the mining AMM with a
single command. The deployer passes the chain's knobs — **RPC URLs**, **agreement
quorum**, **confirmation depth** (default 3), **chainId** — and the tool deploys
that chain's block-hash oracle, the bridge + a real Crossroads asset, mints it via
a real deposit, then creates + seeds its pool against the mining token (reusing
the existing Uniswap factory/router/mining token, defaults from the AMM
deployment).

```sh
SOURCE_CHAIN_ID=<id> SOURCE_RPC_URLS=<url1>,<url2> SOURCE_RPC_QUORUM=2 MIN_CONFIRMATIONS=3 \
ASSET_NAME="Crossroads Foo" ASSET_SYMBOL=crsFOO DEPOSIT_ETH=0.0015 MINING_LIQUIDITY=3 \
  npx hardhat run scripts/crossroads-evm/onboard-crossroads-token.ts --network sapphireTestnet
```

**Multi-chain = run it once per chain** with that chain's configs; the same TEE
container serves every chain (via `?config=`) and the same mining AMM lists them
all. Reuse an existing chain's oracle by passing `ORACLE_CONTRACT_ADDRESS=<oracle>`
instead of the RPC/quorum/confirmations.

A real Crossroads asset has **no pre-mint** — the token side of the pool is minted
by the deposit, so the oracle must be live and the depositor key funded on the
source chain. The source chain must produce standard Ethereum-format blocks (any
ETH testnet works; OP-stack L2s need their `0x7e` system tx handled — not yet
supported).

## Deployed (Sapphire testnet, chainId 23295)

- **Signing committee (`SigningCommittee`, EIP-712):** `0x86de215fEfB0eA85c0F7c771d7091B2003eA4237`
- **Sepolia stack (chainId 11155111):** oracle `0x3045628524530CB056D74Eacd2C4F0b0A6Bf4388`, asset crsETH `0x52B56eEFE06B54f9cf323310Bf3CDa5bfecD87a3` (also a 12-conf oracle `0xa852946E2FfEb92FB8f06a8272cCE5323eCFE133` / crsETH `0x22d3Fb59c21940645E4c212316f33c898402eAF5`)
- **Hoodi stack (chainId 560048) — 2nd chain via the onboarding tool:** oracle `0x52f470535A2898918e6c3FeE4fB0193c2E739b78`, asset crsHOOD `0x15BDE4FE27a30de6A3b9a800CA03aeb05fA8a481`, pool `0x413F4882169EC79eA2fEf7EC04BD0A8c67f323aa`
- **AMM:** Factory `0x39924Df94Cc639654DdCF74ededCA428Ca285582`, Router `0x94Aa01382f7c64F98D591Af04A179A76fED5da69`, mining token UFM `0xDAbaB98ea957bCa3D4d0B7C3F2f775Bb6537BA0d`
- **Oracle API:** ephemeral — get the current URL from `oasis rofl machine show`

## Tests

Offline (no keys, free):
```sh
cd backend_contracts
node scripts/crossroads-evm/dev/validate-proof-rpc.mjs   # debug-free proof vs live Sepolia
node scripts/crossroads-evm/dev/validate-submit.mjs      # report digest/sig vs the saved fixture
npx hardhat test test/asset-accounting.ts                # asset accounting (5 tests)
```
On-chain isolation test of the committee: `crossroads_oracle/contracts/scripts/test-signing-committee.js`
(5 checks: deterministic derivation, the on-chain EIP-712 digest matches the client's typed-data hash and
recovers the requester, the DER signature recovers to the derived signer, `canSign` gating, spender pinning).

Live (Sapphire + Sepolia testnets), all on the EIP-712 `SigningCommittee` `0x86de…`:
- **deposit→mint** and **AMM swap** (100 dcrETH → 197.43 UFM) verified on-chain.
- on-chain isolation test above passes 5/5.
- **full contract-signed withdrawal round-trip** (deposit→lock→committee-sign→finalize, **epoch 0→1**):
  the committee returned a raw Sapphire DER signature, the client split it + recovered `v`, and the
  withdrawal was accepted on Sepolia (`0x9edd0adc052111ea3d6b6ea6bb9ec647a4bd873c9620156d904e8f42d1d1d4ae`)
  and finalized on Sapphire.
- **multi-chain, one command** — onboarded **crsHOOD on a 2nd chain (Hoodi, 560048)** with
  `onboard-crossroads-token.ts`: it deployed Hoodi's oracle config, the bridge + asset, minted via a real
  Hoodi deposit (`0x526d67275b6e5f5f002d7e9db33ce5092c0d0174b6f3b9b930d65103d7bf63cd`), and created the
  crsHOOD/UFM pool — sharing the same TEE container and mining AMM as the Sepolia crsETH stack.

## Mining-pool integration seam

`MiningRewardToken` has a minter role: `setMinter(poolTee, true)`, then the pool's TEE calls
`mint(miner, amount)` as it attests mining output. Rewards trade against Crossroads assets in
the AMM.
