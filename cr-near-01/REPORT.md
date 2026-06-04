# Crossroads × Universal Faucet — run flow

A cross-chain asset bridge on Oasis Sapphire: **deposit ETH on Sepolia → mint
crsETH on Sapphire → trade in an AMM → withdraw back out.** The signing committee
is a single Sapphire confidential contract (no MPC). EVM path, live on testnet.

## Prerequisites

1. Node ≥22.10 + Foundry on PATH:
   `export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"`
2. A funded **Sapphire testnet** key (TEST-ROSE) and a funded **Sepolia** key (Sepolia ETH).
3. The TEE oracle machine running. Re-rent if expired:
   `oasis rofl deploy --replace-machine` → `oasis rofl machine show` → copy the
   `https://p8080.….rofl.app` URL.
4. Put both keys + the URL in `backend_contracts/.env.demo-keys`, then before each run:
   `set -a; source .env.demo-keys; set +a`

## Run, in order

### A) In `crossroads_oracle/contracts`

```sh
# 1. Block-hash oracle (one per source chain). TEE auto-registers its signer on first use.
PRIVATE_KEY=$SAPPHIRE_PRIVATE_KEY ROFL_APP_ID=0x002339e39056f12efc2e8f1476a871e22555bc4e49 \
SOURCE_CHAIN_ID=11155111 MIN_CONFIRMATIONS=3 SOURCE_RPC_QUORUM=2 \
SOURCE_RPC_URLS=https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org,https://public.1rpc.io/sepolia \
  npx hardhat run scripts/deploy-header-oracle.js --network sapphire-testnet
#   → note the printed oracle address

# 2. Signing committee (the Sapphire contract). Deploys + self-tests.
PRIVATE_KEY=$SAPPHIRE_PRIVATE_KEY \
  npx hardhat run scripts/test-sapphire-committee.js --network sapphire-testnet
#   → note the printed committee address
```

### B) In `backend_contracts`

```sh
# 3. Bridge + asset (crsETH), wired to the oracle from step 1.
ORACLE_CONTRACT_ADDRESS=<oracle from step 1> \
  npx hardhat run scripts/crossroads-evm/deploy-stack.ts --network sapphireTestnet

# 4. Deposit -> mint crsETH (real Sepolia tx, ~1 min with a 3-conf oracle).
npx hardhat run scripts/crossroads-evm/deposit.ts --network sapphireTestnet

# 5. Withdraw — full deposit -> lock -> committee-sign -> finalize.
COMMITTEE_ADDRESS=<committee from step 2> \
  npx hardhat run scripts/crossroads-evm/withdraw-live.ts --network sapphireTestnet

# 6. AMM: Uniswap v2 + mining token (MiningRewardToken) + pools + a swap.
npx hardhat run scripts/mining-amm/deploy-amm.ts --network sapphireTestnet
```

## Currently deployed (Sapphire testnet, chainId 23295)

- **Signing committee:** `0xDa3dFdEa5C52C56c3F667e00Df90eCEaA7faDEf5`
- **3-conf stack:** oracle `0x3045628524530CB056D74Eacd2C4F0b0A6Bf4388`, asset crsETH `0x52B56eEFE06B54f9cf323310Bf3CDa5bfecD87a3`
- **12-conf stack:** oracle `0xa852946E2FfEb92FB8f06a8272cCE5323eCFE133`, asset crsETH `0x22d3Fb59c21940645E4c212316f33c898402eAF5`
- **AMM:** Factory `0x39924Df94Cc639654DdCF74ededCA428Ca285582`, Router `0x94Aa01382f7c64F98D591Af04A179A76fED5da69`
- **Oracle API:** ephemeral — get the current URL from `oasis rofl machine show`

Verified on-chain: deposit→mint, contract-signed withdrawal (epoch 0→1), AMM swap
(100 dcrETH → 197.43 UFM).

## Quick tests (no keys, free)

```sh
cd backend_contracts
node scripts/crossroads-evm/dev/validate-proof-rpc.mjs   # proof builder vs live Sepolia
node scripts/crossroads-evm/dev/validate-submit.mjs      # report digest/sig vs fixture
npx hardhat test test/asset-accounting.ts                # asset accounting
```

## Mining-pool integration seam

The mining token is `MiningRewardToken` (minter-role). The mining pool's TEE plugs
in via `setMinter(poolTee, true)`, then calls `mint(miner, amount)` as it attests
mining output. Those rewards trade against Crossroads assets in the AMM pools.

## Not done

Other source chains (BTC/Solana), real mining backing for the token, production
hardening (contract TODOs, audit, committee key recovery/attestation, mainnet).
