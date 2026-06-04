# Universal Faucet mining AMM (Uniswap v2 on Sapphire)

Self-deployed Uniswap v2 (no canonical deployment exists on Sapphire testnet),
plus the mining-token placeholder and a couple of pools pairing it with stand-in
Crossroads tokens.

## What it deploys

- **WROSE** — a WETH9-equivalent wrapped-native token ([WROSE.sol](../../contracts/WROSE.sol)).
- **UniswapV2Factory + UniswapV2Router02** — the OFFICIAL precompiled bytecode
  (`@uniswap/v2-core@1.0.1`, `@uniswap/v2-periphery@1.1.0-beta.0`). We deploy the
  canonical bytecode rather than recompiling because Router02 hard-codes the pair
  init-code-hash; recompiling would change it and break `pairFor`. Verified:
  `keccak256(UniswapV2Pair.bytecode) == 0x96e8ac42…845f` (the router's hard-coded
  value).
- **MintableERC20** — `UFM` (mining token) and `dcrETH` / `dcrUSDC` stand-in
  Crossroads tokens ([MintableERC20.sol](../../contracts/MintableERC20.sol)).
- Two pools (`UFM/dcrETH`, `UFM/dcrUSDC`) with seeded liquidity, plus a sample swap.

## Run

```sh
export PATH="/opt/homebrew/bin:$PATH"

# Local EDR (free, instant) — validated end-to-end:
npx hardhat run scripts/mining-amm/deploy-amm.ts --network hardhatMainnet

# Sapphire testnet:
SAPPHIRE_PRIVATE_KEY=0x... \
  npx hardhat run scripts/mining-amm/deploy-amm.ts --network sapphireTestnet
```

Writes `deployments/mining-amm-<chainId>.json`.

## Notes / next steps

- The mining token and `dcr*` tokens are freely-mintable placeholders. To pair
  against a *real* Crossroads token, deposit first (see `../crossroads-evm/`) so
  the asset contract mints `crsETH`, then point a pool at that address.
- Real mining/reward mechanics (the TEE mining pool) are not modeled yet — `UFM`
  is a plain ERC20 stand-in.
- v2 was chosen for simplicity; v3 (concentrated liquidity) would be a larger lift.
