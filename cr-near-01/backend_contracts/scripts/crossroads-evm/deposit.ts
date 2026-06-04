// End-to-end Crossroads deposit: prove a real Sepolia value-transfer to the
// Crossroads asset on Sapphire testnet and mint the wrapped token.
//
//   1. send ETH on Sepolia to the registered encumbered account
//   2. wait for the oracle's confirmation floor (default 12 blocks)
//   3. fetch the TEE-signed header report from the oracle API
//   4. relay submitSignedHeader on Sapphire  -> blockHashes[N] is populated
//   5. build the tx inclusion proof from plain eth_getBlockByNumber (no debug)
//   6. asset.deposit(signedTx, proof) -> mints crsETH to the depositor
//
//   SAPPHIRE_PRIVATE_KEY=0x...  (funded, ROSE)  \
//   SEPOLIA_PRIVATE_KEY=0x...   (funded, Sepolia ETH) \
//   [SEPOLIA_RPC_URL=...] [CROSSROADS_ORACLE_API=...] [DEPOSIT_ETH=0.0003] \
//     npx hardhat run scripts/crossroads-evm/deposit.ts --network sapphireTestnet

import { readFile } from "node:fs/promises";

import { ethers as ethersLib } from "ethers";
import { network } from "hardhat";

import {
  DEFAULT_ORACLE_API,
  DEFAULT_SOURCE_RPC_URL,
  HEADER_REPORT_ORACLE_ABI,
  SOURCE_CHAIN,
  buildDepositProof,
  reportToTuple,
  waitForTeeReport,
} from "./lib.js";

const ASSET_ABI = [
  "function deposit(bytes signedTx, bytes proof)",
  "function balanceOf(address) view returns (uint256)",
  "function isEncumberedAccount(bytes32) view returns (bool)",
  "function processedDeposits(bytes32) view returns (bool)",
  "event DepositProcessed(address indexed sender, bytes32 indexed destination, uint256 amount, bytes32 indexed txHash)",
];

const { ethers } = await network.connect();

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

async function main() {
  const [sapphireSigner] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  // Load the deployment produced by deploy-stack.ts.
  const deploymentPath =
    process.env.CROSSROADS_EVM_DEPLOYMENT_PATH ??
    `deployments/crossroads-evm-sapphire-${net.chainId}.json`;
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  const apiUrl = process.env.CROSSROADS_ORACLE_API ?? DEFAULT_ORACLE_API;

  // Source-chain (Sepolia) wallet + provider.
  const sourceProvider = new ethersLib.JsonRpcProvider(
    process.env.SEPOLIA_RPC_URL ?? DEFAULT_SOURCE_RPC_URL,
    SOURCE_CHAIN,
    { staticNetwork: true },
  );
  const sourceWallet = new ethersLib.Wallet(need("SEPOLIA_PRIVATE_KEY"), sourceProvider);
  const depositValue = ethersLib.parseEther(process.env.DEPOSIT_ETH ?? "0.0003");
  const encAddress = ethersLib.getAddress(deployment.encAccount.address);

  console.log(`Sapphire backend : ${net.name} (chainId ${net.chainId})`);
  console.log(`Asset            : ${deployment.asset.address} (${deployment.asset.symbol})`);
  console.log(`Oracle           : ${deployment.oracle}`);
  console.log(`Oracle API       : ${apiUrl}`);
  console.log(`Depositor (Sepolia/Sapphire): ${sourceWallet.address}`);
  console.log(`Encumbered acct  : ${encAddress}`);
  console.log(`Deposit value    : ${ethersLib.formatEther(depositValue)} ETH\n`);

  const asset = new ethers.Contract(deployment.asset.address, ASSET_ABI, sapphireSigner);
  const oracle = new ethers.Contract(deployment.oracle, HEADER_REPORT_ORACLE_ABI, sapphireSigner);

  if (!(await asset.isEncumberedAccount(deployment.encAccount.id))) {
    throw new Error(`encumbered account ${encAddress} is not registered on the asset`);
  }

  // --- 1. send the deposit tx on Sepolia ----------------------------------
  console.log("[1/6] Sending deposit tx on Sepolia…");
  const feeData = await sourceProvider.getFeeData();
  const txReq = await sourceWallet.populateTransaction({
    to: encAddress,
    value: depositValue,
    type: 2,
    maxFeePerGas: feeData.maxFeePerGas ?? ethersLib.parseUnits("30", "gwei"),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? ethersLib.parseUnits("2", "gwei"),
  });
  const signedRaw = await sourceWallet.signTransaction(txReq);
  const sent = await sourceProvider.broadcastTransaction(signedRaw);
  console.log(`  txHash=${sent.hash}`);
  const receipt = await sent.wait();
  if (!receipt) throw new Error("no receipt");
  const blockNumber = receipt.blockNumber;
  console.log(`  included in block ${blockNumber}, index ${receipt.index}`);

  // --- 2. wait for the confirmation floor ---------------------------------
  const minConf = Number(await oracle.minConfirmations());
  console.log(`[2/6] Waiting for ${minConf} confirmations on Sepolia…`);
  for (;;) {
    const tip = await sourceProvider.getBlockNumber();
    const depth = tip - blockNumber;
    process.stdout.write(`\r  depth ${depth}/${minConf} (tip ${tip})   `);
    if (depth >= minConf) break;
    await new Promise((r) => setTimeout(r, 12_000));
  }
  process.stdout.write("\n");

  // --- 3. fetch the TEE-signed report -------------------------------------
  console.log("[3/6] Fetching TEE-signed header report…");
  const report = await waitForTeeReport(apiUrl, deployment.oracle, blockNumber);
  console.log(`  report blockHash=${report.blockHash} signer=${report.signer} epoch=${report.signerEpoch}`);
  const srcBlock = await sourceProvider.send("eth_getBlockByNumber", [
    "0x" + blockNumber.toString(16),
    false,
  ]);
  if (srcBlock.hash.toLowerCase() !== report.blockHash.toLowerCase()) {
    throw new Error(`report blockHash ${report.blockHash} != Sepolia block hash ${srcBlock.hash}`);
  }

  // --- 4. relay submitSignedHeader on Sapphire ----------------------------
  console.log("[4/6] Submitting signed header to the oracle on Sapphire…");
  const existing: string = await oracle.blockHashes(blockNumber);
  if (existing.toLowerCase() === report.blockHash.toLowerCase()) {
    console.log("  already stored (idempotent), skipping submit");
  } else {
    const tx = await oracle.submitSignedHeader(reportToTuple(report), report.signature);
    console.log(`  submit tx=${tx.hash}`);
    await tx.wait();
  }
  const storedHash = await oracle.getBlockHash(blockNumber);
  if (storedHash.toLowerCase() !== report.blockHash.toLowerCase()) {
    throw new Error("oracle did not store the expected block hash");
  }
  console.log(`  oracle.getBlockHash(${blockNumber}) = ${storedHash} ✅`);

  // --- 5. build the inclusion proof (debug-free) --------------------------
  console.log("[5/6] Building inclusion proof from eth_getBlockByNumber…");
  const encodedProof = await buildDepositProof(sourceProvider, blockNumber, receipt.index);

  // --- 6. deposit -> mint --------------------------------------------------
  console.log("[6/6] Calling asset.deposit() on Sapphire…");
  const balanceBefore: bigint = await asset.balanceOf(sourceWallet.address);
  const depositTx = await asset.deposit(signedRaw, encodedProof);
  console.log(`  deposit tx=${depositTx.hash}`);
  const depositReceipt = await depositTx.wait();
  const balanceAfter: bigint = await asset.balanceOf(sourceWallet.address);

  const minted = balanceAfter - balanceBefore;
  console.log(`\n✅ Deposit processed.`);
  console.log(`  ${deployment.asset.symbol} minted to ${sourceWallet.address}: ${ethersLib.formatEther(minted)}`);
  console.log(`  new balance: ${ethersLib.formatEther(balanceAfter)} ${deployment.asset.symbol}`);
  if (minted !== depositValue) {
    console.warn(`  ⚠ minted ${minted} != deposited ${depositValue}`);
  }
  void depositReceipt;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
