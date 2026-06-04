// Deploy a self-contained Uniswap v2 (WROSE + Factory + Router02) and open a few
// pools pairing the Universal Faucet mining token with stand-in Crossroads
// tokens, seed liquidity, and prove a swap. Runs on local EDR for free
// validation, or on Sapphire testnet:
//
//   npx hardhat run scripts/mining-amm/deploy-amm.ts --network hardhatMainnet   # local
//   SAPPHIRE_PRIVATE_KEY=0x... \
//     npx hardhat run scripts/mining-amm/deploy-amm.ts --network sapphireTestnet
//
// The mining token and the "Crossroads" tokens here are simple mintable ERC20
// placeholders (real minted Crossroads assets come from the deposit flow).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ethers as ethersLib } from "ethers";
import { network } from "hardhat";

import { bytecodeOf, factoryArtifact, pairArtifact, routerArtifact } from "./uniswap-artifacts.js";

const { ethers } = await network.connect();

const E = (n: string) => ethersLib.parseEther(n);

// mining-token amount + cr-token amount per pool (ratio sets the initial price).
const POOLS = [
  { name: "Demo Crossroads ETH", symbol: "dcrETH", mining: E("20000"), cr: E("10000") },
  { name: "Demo Crossroads USDC", symbol: "dcrUSDC", mining: E("5000"), cr: E("15000") },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`Network:  ${net.name} (chainId ${net.chainId})`);
  console.log(`Deployer: ${deployer.address}\n`);

  // --- Uniswap v2 core + periphery + WROSE --------------------------------
  const wrose = await deployHardhat("WROSE", [], 3_000_000);
  const factory = await deployVendored(
    "UniswapV2Factory",
    factoryArtifact.abi,
    bytecodeOf(factoryArtifact),
    [deployer.address], // feeToSetter
    deployer,
    9_000_000,
  );
  const router = await deployVendored(
    "UniswapV2Router02",
    routerArtifact.abi,
    bytecodeOf(routerArtifact),
    [await factory.getAddress(), await wrose.getAddress()],
    deployer,
    12_000_000,
  );
  const routerAddr = await router.getAddress();

  // --- Tokens -------------------------------------------------------------
  // Mining token = MiningRewardToken: the mining pool's TEE attestor plugs in as
  // a minter. For the demo the deployer is the minter and mints seed liquidity.
  const mining = await deployHardhat("MiningRewardToken", ["Universal Faucet Mining Reward", "UFM"], 6_000_000);
  const miningAddr = await mining.getAddress();
  await (await (mining as any).setMinter(deployer.address, true)).wait();
  await (await (mining as any).mint(deployer.address, E("1000000"))).wait();
  console.log("");

  const deadline = (await latestTimestamp()) + 3600;
  const pools: Array<Record<string, string>> = [];

  for (const p of POOLS) {
    const cr = await deployHardhat(
      "MintableERC20",
      [p.name, p.symbol, E("1000000"), deployer.address],
      6_000_000,
    );
    const crAddr = await cr.getAddress();

    // Approve the router to pull both sides, then add liquidity (creates pair).
    await (await (mining as any).approve(routerAddr, p.mining)).wait();
    await (await (cr as any).approve(routerAddr, p.cr)).wait();
    await (
      await (router as any).addLiquidity(
        miningAddr,
        crAddr,
        p.mining,
        p.cr,
        0,
        0,
        deployer.address,
        deadline,
        { gasLimit: 6_000_000 }, // first call CREATE2-deploys the pair
      )
    ).wait();

    const pairAddr = await (factory as any).getPair(miningAddr, crAddr);
    const pair = new ethersLib.Contract(pairAddr, pairArtifact.abi, deployer);
    const [r0, r1] = await pair.getReserves();
    const token0 = await pair.token0();
    console.log(`Pool UFM/${p.symbol}: pair=${pairAddr}`);
    console.log(`  reserves: token0(${short(token0)})=${ethersLib.formatEther(r0)}  token1=${ethersLib.formatEther(r1)}`);
    pools.push({ symbol: p.symbol, token: crAddr, pair: pairAddr });
  }

  // --- Prove a swap on the first pool -------------------------------------
  const firstCr = pools[0].token;
  const cr0 = new ethersLib.Contract(firstCr, ["function approve(address,uint256) returns (bool)"], deployer);
  const swapIn = E("100");
  await (await cr0.approve(routerAddr, swapIn)).wait();
  const beforeBal: bigint = await (mining as any).balanceOf(deployer.address);
  await (
    await (router as any).swapExactTokensForTokens(
      swapIn,
      0,
      [firstCr, miningAddr],
      deployer.address,
      deadline,
    )
  ).wait();
  const afterBal: bigint = await (mining as any).balanceOf(deployer.address);
  console.log(`\nSwap 100 ${pools[0].symbol} -> UFM: received ${ethersLib.formatEther(afterBal - beforeBal)} UFM ✅`);

  const deployment = {
    network: { name: net.name, chainId: net.chainId.toString() },
    deployer: deployer.address,
    wrose: await wrose.getAddress(),
    factory: await factory.getAddress(),
    router: routerAddr,
    miningToken: { address: miningAddr, symbol: "UFM" },
    pools,
  };
  const outPath =
    process.env.MINING_AMM_DEPLOYMENT_PATH ?? `deployments/mining-amm-${net.chainId}.json`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
  console.log(JSON.stringify(deployment, null, 2));
}

// Sapphire's eth_estimateGas underestimates contract-CREATION txs, so deploys
// can revert out-of-gas. Pass an explicit gasLimit (esp. for the 22KB router).
async function deployHardhat(name: string, args: unknown[], gasLimit?: number) {
  const factory = await ethers.getContractFactory(name);
  const deployArgs = gasLimit ? [...args, { gasLimit }] : args;
  const c = await factory.deploy(...(deployArgs as never[]));
  await c.waitForDeployment();
  const tx = c.deploymentTransaction();
  if (tx) await tx.wait();
  console.log(`  ${name.padEnd(20)} ${await c.getAddress()}`);
  return c;
}

async function deployVendored(
  label: string,
  abi: unknown[],
  bytecode: string,
  args: unknown[],
  signer: unknown,
  gasLimit?: number,
) {
  const factory = new ethersLib.ContractFactory(abi as never, bytecode, signer as never);
  const deployArgs = gasLimit ? [...args, { gasLimit }] : args;
  const c = await factory.deploy(...(deployArgs as never[]));
  await c.waitForDeployment();
  const tx = c.deploymentTransaction();
  if (tx) await tx.wait();
  console.log(`  ${label.padEnd(20)} ${await c.getAddress()}`);
  return c;
}

async function latestTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return block ? Number(block.timestamp) : Math.floor(Date.now() / 1000);
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
