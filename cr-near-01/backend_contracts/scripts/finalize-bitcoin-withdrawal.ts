/**
 * One-shot helper to finalize a Bitcoin withdrawal on the deployed public-
 * testnet asset contract, given just the confirmed withdrawal txid. Useful when
 * the e2e test bailed at the confirmation step (e.g. testnet4 produced blocks
 * slower than the timeout) but the BTC side of the flow eventually mined.
 *
 * Reads:
 *   PUBLIC_TESTNET_DEPLOYMENT_PATH   default: tmp/public-testnet-deployment.json
 *   BITCOIN_RPC_URL                  required
 *   BITCOIN_WITHDRAWAL_TXID          required (hex, no 0x prefix)
 *
 * Runs through hardhat run, so use --network <name> to target the right EVM.
 */
import { network } from "hardhat";
import fs from "node:fs";
import path from "node:path";

import {
  BitcoinRpc,
  dsha,
  encodeBitcoinProof,
  fetchInclusionProof,
} from "./bitcoin/tx-helpers.js";
import type { PublicTestnetDeployment } from "./public-testnet-deploy.js";

const { ethers } = await network.connect();

function deploymentArtifactPath(): string {
  const fromEnv = process.env.PUBLIC_TESTNET_DEPLOYMENT_PATH;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return path.resolve(fromEnv);
  }
  return path.resolve(process.cwd(), "tmp/public-testnet-deployment.json");
}

function loadDeployment(): PublicTestnetDeployment {
  const p = deploymentArtifactPath();
  if (!fs.existsSync(p)) {
    throw new Error(`deployment artifact not found at ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as PublicTestnetDeployment;
}

function require_(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`${name} must be set`);
  }
  return v;
}

async function main(): Promise<void> {
  const txid = require_("BITCOIN_WITHDRAWAL_TXID").replace(/^0x/, "");
  const rpcUrl = require_("BITCOIN_RPC_URL");

  const root = new BitcoinRpc(rpcUrl);
  const walletName = process.env.BITCOIN_WALLET_NAME;
  const wallet = walletName ? root.wallet(walletName) : root;

  console.log(`fetching withdrawal tx ${txid}`);
  const tx = await wallet.call<any>("getrawtransaction", [txid, true]);
  if (typeof tx.blockhash !== "string") {
    throw new Error(`withdrawal ${txid} is not yet confirmed`);
  }
  const rawHex = `0x${tx.hex}`;

  // Recover the encumbered account from the witness P2WPKH change output.
  // Layout per the test: vout[0]=OP_RETURN, vout[1]=change to encHash, vout[2]=recipient.
  const changeScript = tx.vout[1]?.scriptPubKey?.hex;
  if (typeof changeScript !== "string" || !changeScript.startsWith("0014") || changeScript.length !== 44) {
    throw new Error(`vout[1] is not a P2WPKH (got ${changeScript})`);
  }
  // Bitcoin's encAccount is the 20-byte witness hash160 left-aligned in a
  // 32-byte slot (`hash160 ++ 12 zero bytes`). See
  // BitcoinBridgeOracle._hash160FromAccount which recovers the hash via
  // `bytes20(encAccount)`.
  const encHash = `0x${changeScript.slice(4)}`;
  const encAccount = ethers.concat([encHash, "0x" + "00".repeat(12)]);
  console.log(`recovered encAccount: ${encAccount}`);

  const proof = await fetchInclusionProof(wallet, txid);
  console.log(`included at height=${proof.height} txIndex=${proof.txIndex} merkleDepth=${proof.proof.length}`);

  const deployment = loadDeployment();
  const bitcoin = deployment.sourceChains.bitcoinTestnet;
  const asset = await ethers.getContractAt("CrossroadsAssetContract", bitcoin.asset);
  const blockHashOracle = await ethers.getContractAt(
    "CentralizedBitcoinBlockHashOracle",
    bitcoin.blockHashOracle!,
  );

  const expectedBlockHash = dsha(proof.header);
  const onChainHash = await blockHashOracle.getBlockHash(proof.height);
  if (onChainHash.toLowerCase() !== expectedBlockHash.toLowerCase()) {
    console.log(`setting block hash for height ${proof.height}`);
    const setHashTx = await blockHashOracle.setBlockHash(proof.height, expectedBlockHash);
    await setHashTx.wait(1);
  } else {
    console.log(`block hash for height ${proof.height} already set`);
  }

  const signers = await ethers.getSigners();
  // The "prover" role is "anyone with a valid proof"; if a second signer exists, use it
  // so the subsidy demonstrably flows to a non-deployer, otherwise fall back to the first signer.
  const prover = signers[1] ?? signers[0];
  console.log(`calling finalizeWithdrawal from ${prover.address}`);
  const finalizeTx = await (asset.connect(prover) as typeof asset).finalizeWithdrawal(
    rawHex,
    encodeBitcoinProof(proof.height, proof.header, proof.proof, proof.txIndex),
    encAccount,
  );
  console.log(`  finalize tx ${finalizeTx.hash} sent`);
  const receipt = await finalizeTx.wait(1);
  console.log(`  status=${receipt!.status} gasUsed=${receipt!.gasUsed}`);
  if (receipt!.status !== 1) {
    throw new Error(`finalizeWithdrawal reverted`);
  }
  const topic = asset.interface.getEvent("WithdrawalFinalized")!.topicHash;
  const log = receipt!.logs.find((l) => l.topics[0] === topic);
  if (log === undefined) {
    throw new Error(`WithdrawalFinalized not emitted`);
  }
  const parsed = asset.interface.parseLog({ topics: log.topics as string[], data: log.data })!;
  console.log("WithdrawalFinalized:", {
    spender: parsed.args[0],
    encAccount: parsed.args[1],
    amountSpent: parsed.args[2].toString(),
    withdrawalProofRewardPaid: parsed.args[3].toString(),
    txHash: parsed.args[4],
  });
}

await main();
