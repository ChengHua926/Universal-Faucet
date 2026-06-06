// Onboard a NEW Crossroads token onto ANY EVM chain and list it in the mining
// AMM — ONE command. Given an existing Uniswap-v2 factory/router + mining token:
//
//   1. deploys (or reuses) the chain's HeaderReportOracle with YOUR config —
//      RPC URLs, agreement quorum, confirmations (default 3), chainId;
//   2. deploys the bridge + a real CrossroadsAssetContract (your name/symbol);
//   3. mints the new token by doing a REAL deposit on the source chain (a real
//      Crossroads asset has no pre-mint — supply comes from deposits);
//   4. creates the <token>/<mining> Uniswap-v2 pool and seeds initial liquidity.
//
// Multi-chain = run this once per chain with that chain's configs; the same TEE
// container serves every chain (via ?config=) and the same mining AMM lists them
// all. "If your chain isn't supported, here's how you list a token on it."
//
//   SAPPHIRE_PRIVATE_KEY=0x...   (deployer; owns the asset; mints mining token if it is the owner) \
//   SEPOLIA_PRIVATE_KEY=0x...    (source-chain depositor; also the LP — needs source-chain gas + ROSE) \
//   CROSSROADS_ORACLE_API=https://...rofl.app \
//   # --- per-chain oracle config (omit if reusing ORACLE_CONTRACT_ADDRESS) ---
//   [SOURCE_CHAIN_ID=11155111] [SOURCE_RPC_URLS=url1,url2,url3] [SOURCE_RPC_QUORUM=2] [MIN_CONFIRMATIONS=3] \
//   [ORACLE_CONTRACT_ADDRESS=0x..]  (reuse an existing oracle instead of deploying one) \
//   # --- token + pool ---
//   [ASSET_NAME="Crossroads Sepolia ETH"] [ASSET_SYMBOL=crsETH] \
//   [FACTORY_ADDRESS=0x..] [ROUTER_ADDRESS=0x..] [MINING_TOKEN_ADDRESS=0x..]  (default: deployments/mining-amm-*.json) \
//   [DEPOSIT_ETH=0.0015]  (source value -> minted crsX, the token side of the pool) \
//   [MINING_LIQUIDITY=3]  (mining-token amount paired with it; the ratio sets the initial price) \
//     npx hardhat run scripts/crossroads-evm/onboard-crossroads-token.ts --network sapphireTestnet
//
// Example — list a token on a 2nd chain (Hoodi), one command:
//   SOURCE_CHAIN_ID=560048 SOURCE_RPC_URLS=https://ethereum-hoodi-rpc.publicnode.com \
//   SOURCE_RPC_QUORUM=1 MIN_CONFIRMATIONS=3 ASSET_NAME="Crossroads Hoodi ETH" ASSET_SYMBOL=crsHOOD \
//     npx hardhat run scripts/crossroads-evm/onboard-crossroads-token.ts --network sapphireTestnet

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ethers as ethersLib } from "ethers";
import { network } from "hardhat";

import { factoryArtifact, pairArtifact, routerArtifact } from "../mining-amm/uniswap-artifacts.js";
import {
  DEFAULT_ORACLE_API,
  DEFAULT_SOURCE_RPC_URL,
  HEADER_REPORT_ORACLE_ABI,
  accountIdFromAddress,
  buildDepositProof,
  reportToTuple,
  sourceChainFromEnv,
  waitForTeeReport,
} from "./lib.js";

const { ethers } = await network.connect();

// Pre-compiled HeaderReportOracle (deployed as vendored bytecode when no
// ORACLE_CONTRACT_ADDRESS is given — like the Uniswap deploy). Already
// paris-compiled for Sapphire; no copy/dep/recompile needed in this project.
const HEADER_ORACLE_ARTIFACT = new URL(
  "../../../crossroads_oracle/contracts/artifacts/contracts/HeaderReportOracle.sol/HeaderReportOracle.json",
  import.meta.url,
);
const DEFAULT_ROFL_APP_ID = "0x002339e39056f12efc2e8f1476a871e22555bc4e49";

const ASSET_ABI = [
  "function deposit(bytes signedTx, bytes proof)",
  "function balanceOf(address) view returns (uint256)",
  "function isEncumberedAccount(bytes32) view returns (bool)",
  "function registerEncumberedAccount(bytes32)",
  "function approve(address,uint256) returns (bool)",
];
const MINING_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`Set ${n}`);
  return v;
};

async function loadAmmDefaults(chainId: bigint) {
  // Default the existing factory/router/mining-token from the AMM deployment file.
  try {
    const d = JSON.parse(
      await readFile(`deployments/mining-amm-${chainId}.json`, "utf8"),
    );
    return { factory: d.factory, router: d.router, mining: d.miningToken.address };
  } catch {
    return { factory: undefined, router: undefined, mining: undefined };
  }
}

async function deployStack(deployer: ethersLib.Signer, oracleAddr: string, name: string, symbol: string) {
  const dep = async (cname: string, args: unknown[], opts?: unknown, ov?: object) => {
    const f = await ethers.getContractFactory(cname, opts as never);
    const c = await f.deploy(...((ov ? [...args, ov] : args) as never[]));
    await c.waitForDeployment();
    const t = c.deploymentTransaction();
    if (t) await t.wait();
    console.log(`  ${cname.padEnd(24)} ${await c.getAddress()}`);
    return c;
  };
  const proveth = await dep("ProvethVerifier", []);
  const txSer = await dep("TransactionSerializer", []);
  const bridge = await dep("BridgeOracle", [oracleAddr, await proveth.getAddress()], {
    libraries: { TransactionSerializer: await txSer.getAddress() },
  });
  // Sapphire underestimates this creation's gas — set it explicitly.
  const asset = await dep(
    "CrossroadsAssetContract",
    [name, symbol, await bridge.getAddress(), 1 /* SCHEME_ECDSA_SECP256K1 */, 0 /* proofReward */],
    undefined,
    { gasLimit: 12_000_000 },
  );
  return { proveth, txSer, bridge, asset };
}

// Real deposit on the source chain -> mints `symbol` to the depositor on Sapphire.
// (Verbatim flow from deposit.ts: send -> confirm -> TEE report -> submit -> proof -> deposit.)
async function depositAndMint(
  deployer: ethersLib.Signer,
  asset: ethersLib.Contract,
  oracle: ethersLib.Contract,
  source: ethersLib.JsonRpcProvider,
  depositor: ethersLib.Wallet,
  encAddress: string,
  apiUrl: string,
  oracleAddr: string,
  depositValue: bigint,
): Promise<bigint> {
  console.log(`[deposit] ${ethersLib.formatEther(depositValue)} source-ETH -> ${encAddress}…`);
  const fee = await source.getFeeData();
  const req = await depositor.populateTransaction({
    to: encAddress,
    value: depositValue,
    type: 2,
    maxFeePerGas: fee.maxFeePerGas ?? ethersLib.parseUnits("30", "gwei"),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethersLib.parseUnits("2", "gwei"),
  });
  const raw = await depositor.signTransaction(req);
  const sent = await source.broadcastTransaction(raw);
  const rcpt = await sent.wait();
  if (!rcpt) throw new Error("no deposit receipt");
  console.log(`  tx ${sent.hash} @ block ${rcpt.blockNumber}`);

  const minConf = Number(await oracle.minConfirmations());
  process.stdout.write(`  confirming (${minConf})…`);
  for (;;) {
    const depth = (await source.getBlockNumber()) - rcpt.blockNumber;
    process.stdout.write(`\r  confirming ${depth}/${minConf}   `);
    if (depth >= minConf) break;
    await new Promise((r) => setTimeout(r, 12_000));
  }
  process.stdout.write("\n");

  const report = await waitForTeeReport(apiUrl, oracleAddr, rcpt.blockNumber);
  if ((await oracle.blockHashes(rcpt.blockNumber)).toLowerCase() !== report.blockHash.toLowerCase()) {
    await (await oracle.submitSignedHeader(reportToTuple(report), report.signature)).wait();
  }
  const proof = await buildDepositProof(source, rcpt.blockNumber, rcpt.index);
  const before: bigint = await asset.balanceOf(depositor.address);
  await (await (asset.connect(deployer) as ethersLib.Contract).deposit(raw, proof)).wait();
  const minted: bigint = (await asset.balanceOf(depositor.address)) - before;
  console.log(`  minted ${ethersLib.formatEther(minted)} to ${depositor.address}`);
  return minted;
}

// Reuse ORACLE_CONTRACT_ADDRESS if set; otherwise deploy a fresh HeaderReportOracle
// for this chain from the pre-compiled artifact, configured with the deployer's
// RPC URLs / quorum / confirmations (default 3) — this is what makes the tool a
// single command per chain.
async function resolveOracle(deployer: ethersLib.Signer, srcChainId: number): Promise<string> {
  const existing = process.env.ORACLE_CONTRACT_ADDRESS;
  if (existing) {
    console.log(`Oracle:    reusing ${ethersLib.getAddress(existing)}`);
    return ethersLib.getAddress(existing);
  }
  const roflAppId = process.env.ROFL_APP_ID ?? DEFAULT_ROFL_APP_ID;
  const rpcUrls = (process.env.SOURCE_RPC_URLS ?? DEFAULT_SOURCE_RPC_URL)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const quorum = Number(process.env.SOURCE_RPC_QUORUM ?? Math.floor(rpcUrls.length / 2) + 1);
  const minConf = Number(process.env.MIN_CONFIRMATIONS ?? 3);
  const mandateFinalized = process.env.MANDATE_FINALIZED === "1";
  let art: { abi: unknown[]; bytecode: string };
  try {
    art = JSON.parse(await readFile(HEADER_ORACLE_ARTIFACT, "utf8"));
  } catch {
    throw new Error(
      "HeaderReportOracle artifact not found — run `npx hardhat compile` in crossroads_oracle/contracts first",
    );
  }
  console.log(
    `Oracle:    deploying new HeaderReportOracle (chainId ${srcChainId}, conf ${minConf}, quorum ${quorum}, ${rpcUrls.length} RPC)…`,
  );
  const factory = new ethersLib.ContractFactory(art.abi as never, art.bytecode, deployer as never);
  const c = await factory.deploy(roflAppId, srcChainId, minConf, mandateFinalized, rpcUrls, quorum, {
    gasLimit: 6_000_000,
  });
  await c.waitForDeployment();
  const tx = c.deploymentTransaction();
  if (tx) await tx.wait();
  const addr = await c.getAddress();
  console.log(`           → ${addr}`);
  return addr;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const apiUrl = process.env.CROSSROADS_ORACLE_API ?? DEFAULT_ORACLE_API;
  const name = process.env.ASSET_NAME ?? "Crossroads Sepolia ETH";
  const symbol = process.env.ASSET_SYMBOL ?? "crsETH";
  const src = sourceChainFromEnv();

  const amm = await loadAmmDefaults(net.chainId);
  const factoryAddr = ethersLib.getAddress(process.env.FACTORY_ADDRESS ?? amm.factory ?? need("FACTORY_ADDRESS"));
  const routerAddr = ethersLib.getAddress(process.env.ROUTER_ADDRESS ?? amm.router ?? need("ROUTER_ADDRESS"));
  const miningAddr = ethersLib.getAddress(process.env.MINING_TOKEN_ADDRESS ?? amm.mining ?? need("MINING_TOKEN_ADDRESS"));

  const depositValue = ethersLib.parseEther(process.env.DEPOSIT_ETH ?? "0.0015");
  const miningLiq = ethersLib.parseEther(process.env.MINING_LIQUIDITY ?? "3");

  const source = new ethersLib.JsonRpcProvider(
    src.rpcUrl,
    { chainId: src.chainId, name: src.name },
    { staticNetwork: true },
  );
  // Depositor on the source chain; same key is the LP on Sapphire (holds crsX + mining + ROSE for gas).
  const depositor = new ethersLib.Wallet(need("SEPOLIA_PRIVATE_KEY"), source);
  const lp = new ethersLib.Wallet(depositor.privateKey, ethers.provider);

  const oracleAddr = await resolveOracle(deployer, src.chainId);

  console.log(`Network:   ${net.name} (chainId ${net.chainId})`);
  console.log(`Source:    ${src.name} (chainId ${src.chainId}) via ${src.rpcUrl}`);
  console.log(`Deployer:  ${await deployer.getAddress()}`);
  console.log(`LP/depositor: ${depositor.address}`);
  console.log(`Oracle:    ${oracleAddr}   API: ${apiUrl}`);
  console.log(`AMM:       factory=${factoryAddr} router=${routerAddr} mining=${miningAddr}`);
  console.log(`New token: ${name} (${symbol})\n`);

  // Sanity-check the oracle.
  const oracle = new ethers.Contract(oracleAddr, HEADER_REPORT_ORACLE_ABI, deployer);
  const minConf = Number(await oracle.minConfirmations());
  console.log(`Oracle minConfirmations (from contract): ${minConf}`);
  if ((await oracle.headerSigner()) === ethersLib.ZeroAddress) {
    console.warn("  ⚠ headerSigner unset — make one ?config= request so the TEE auto-registers (Option A).");
  }

  // --- 1. deploy bridge + asset, register the deposit account ---------------
  console.log("\n[1/3] Deploying bridge + CrossroadsAssetContract…");
  const { proveth, txSer, bridge, asset: assetC } = await deployStack(deployer, oracleAddr, name, symbol);
  const asset = new ethers.Contract(await assetC.getAddress(), ASSET_ABI, deployer);
  const encAddress = depositor.address; // self-deposit: the depositor's own source-chain address
  const encId = accountIdFromAddress(encAddress);
  if (!(await asset.isEncumberedAccount(encId))) {
    await (await asset.registerEncumberedAccount(encId)).wait();
    console.log(`  registered encumbered account ${encAddress}`);
  }

  // --- 2. mint the token via a real deposit ---------------------------------
  console.log("\n[2/3] Minting the new token via a real source-chain deposit…");
  const minted = await depositAndMint(deployer, asset, oracle, source, depositor, encAddress, apiUrl, oracleAddr, depositValue);
  if (minted <= 0n) throw new Error("deposit minted nothing");

  // --- 3. create the pool + seed liquidity ----------------------------------
  console.log("\n[3/3] Creating the pool + adding liquidity…");
  const mining = new ethers.Contract(miningAddr, MINING_ABI, deployer);
  // Ensure the LP holds enough mining token. Prefer transferring from the
  // deployer's existing balance (works for any ERC20 mining token); fall back to
  // minting if the deployer can (owner/minter); otherwise the LP must pre-hold it.
  const lpMiningBal: bigint = await mining.balanceOf(depositor.address);
  if (lpMiningBal < miningLiq) {
    const shortfall = miningLiq - lpMiningBal;
    const deployerAddr = await deployer.getAddress();
    const deployerBal: bigint = await mining.balanceOf(deployerAddr);
    if (deployerBal >= shortfall) {
      await (await (mining.connect(deployer) as ethersLib.Contract).transfer(depositor.address, shortfall)).wait();
      console.log(`  transferred ${ethersLib.formatEther(shortfall)} mining token from deployer to the LP`);
    } else {
      try {
        await (await (mining.connect(deployer) as ethersLib.Contract).mint(depositor.address, shortfall)).wait();
        console.log(`  minted ${ethersLib.formatEther(shortfall)} mining token to the LP`);
      } catch {
        throw new Error(
          `LP ${depositor.address} needs ${ethersLib.formatEther(miningLiq)} mining token; deployer can neither transfer (has ${ethersLib.formatEther(deployerBal)}) nor mint it — fund the LP first`,
        );
      }
    }
  }

  const router = new ethersLib.Contract(routerAddr, routerArtifact.abi, lp);
  const factory = new ethersLib.Contract(factoryAddr, factoryArtifact.abi, deployer);
  // Approve the router to pull both sides from the LP, then add liquidity (creates the pair).
  await (await (asset.connect(lp) as ethersLib.Contract).approve(routerAddr, minted)).wait();
  await (await (mining.connect(lp) as ethersLib.Contract).approve(routerAddr, miningLiq)).wait();
  const deadline = (await latestTimestamp()) + 3600;
  await (
    await (router as ethersLib.Contract).addLiquidity(
      await asset.getAddress(),
      miningAddr,
      minted,
      miningLiq,
      0,
      0,
      depositor.address,
      deadline,
      { gasLimit: 6_000_000 }, // first call CREATE2-deploys the pair
    )
  ).wait();

  const pairAddr = await (factory as ethersLib.Contract).getPair(await asset.getAddress(), miningAddr);
  const pair = new ethersLib.Contract(pairAddr, pairArtifact.abi, deployer);
  const [r0, r1] = await pair.getReserves();
  const token0 = await pair.token0();
  console.log(`  pair ${pairAddr}`);
  console.log(`  reserves: token0(${token0.slice(0, 8)}…)=${ethersLib.formatEther(r0)} token1=${ethersLib.formatEther(r1)}`);

  const out = {
    network: { name: net.name, chainId: net.chainId.toString() },
    oracle: oracleAddr,
    minConfirmations: minConf,
    asset: { address: await asset.getAddress(), name, symbol },
    bridgeOracle: await bridge.getAddress(),
    provethVerifier: await proveth.getAddress(),
    transactionSerializer: await txSer.getAddress(),
    encAccount: { address: encAddress, id: encId },
    pool: { pair: pairAddr, token: await asset.getAddress(), mining: miningAddr, factory: factoryAddr, router: routerAddr },
    liquidity: { token: ethersLib.formatEther(minted), mining: ethersLib.formatEther(miningLiq) },
  };
  const outPath = process.env.ONBOARD_DEPLOYMENT_PATH ?? `deployments/onboard-${symbol}-${net.chainId}.json`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n✅ Onboarded ${symbol}: deployed, minted via deposit, and listed in the mining AMM.`);
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(out, null, 2));
}

async function latestTimestamp(): Promise<number> {
  const b = await ethers.provider.getBlock("latest");
  return b ? Number(b.timestamp) : Math.floor(Date.now() / 1000);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
