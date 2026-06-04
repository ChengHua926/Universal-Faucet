// Full live withdrawal: deposit to the encumbered address the SapphireSigningCommittee
// contract controls, lock the minted crsETH, have the committee sign the withdrawal
// in a single confidential eth_call, broadcast on Sepolia, and finalize against the
// TEE oracle. The signer is a Sapphire contract — no MPC, no nodes, no DKG.
//
//   SAPPHIRE_PRIVATE_KEY / SEPOLIA_PRIVATE_KEY / CROSSROADS_ORACLE_API in env,
//   [COMMITTEE_ADDRESS=0x...] (default: the deployed SapphireSigningCommittee)
//     npx hardhat run scripts/crossroads-evm/withdraw-live.ts --network sapphireTestnet

import { readFile } from "node:fs/promises";

import { ethers as ethersLib } from "ethers";
import { network } from "hardhat";

import { rawTxFromJson } from "../inclusion-proofs.js";
import {
  DEFAULT_ORACLE_API,
  DEFAULT_SOURCE_RPC_URL,
  HEADER_REPORT_ORACLE_ABI,
  SOURCE_CHAIN,
  accountIdFromAddress,
  buildDepositProof,
  reportToTuple,
  waitForTeeReport,
} from "./lib.js";

const DEFAULT_COMMITTEE = "0xDa3dFdEa5C52C56c3F667e00Df90eCEaA7faDEf5";

const COMMITTEE_ABI = [
  "function encumberedAccount(address asset, bytes32 accountId) view returns (address addr, bytes32 encAccount)",
  "function requestHash(address asset, bytes32 accountId, bytes message) view returns (bytes32)",
  "function sign(address asset, bytes32 accountId, bytes message, bytes spenderSig) view returns (address encAddr, bytes32 r, bytes32 s, uint8 v)",
];

const ASSET_ABI = [
  "function deposit(bytes signedTx, bytes proof)",
  "function balanceOf(address) view returns (uint256)",
  "function isEncumberedAccount(bytes32) view returns (bool)",
  "function accountEpoch(bytes32) view returns (uint256)",
  "function registerEncumberedAccount(bytes32)",
  "function lockWithdrawal(uint256 amount, bytes32 encAccount) payable returns (uint256)",
  "function getSpendingPosition(address,bytes32) view returns (uint256,bool,uint256)",
  "function finalizeWithdrawal(bytes signedTx, bytes proof, bytes32 encAccount)",
];

const { ethers } = await network.connect();
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`Set ${n}`);
  return v;
};

async function confirmAndReport(
  source: ethersLib.JsonRpcProvider,
  oracle: ethersLib.Contract,
  apiUrl: string,
  oracleAddr: string,
  block: number,
  minConf: number,
) {
  for (;;) {
    const depth = (await source.getBlockNumber()) - block;
    process.stdout.write(`\r  confirmations ${depth}/${minConf}   `);
    if (depth >= minConf) break;
    await new Promise((r) => setTimeout(r, 12_000));
  }
  process.stdout.write("\n");
  const report = await waitForTeeReport(apiUrl, oracleAddr, block);
  if ((await oracle.blockHashes(block)) !== report.blockHash) {
    await (await oracle.submitSignedHeader(reportToTuple(report), report.signature)).wait();
  }
  return report;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const apiUrl = process.env.CROSSROADS_ORACLE_API ?? DEFAULT_ORACLE_API;
  const committeeAddr = ethersLib.getAddress(process.env.COMMITTEE_ADDRESS ?? DEFAULT_COMMITTEE);

  const deployment = JSON.parse(
    await readFile(
      process.env.CROSSROADS_EVM_DEPLOYMENT_PATH ??
        `deployments/crossroads-evm-sapphire-${net.chainId}.json`,
      "utf8",
    ),
  );
  const assetAddr = ethersLib.getAddress(deployment.asset.address);
  const asset = new ethers.Contract(assetAddr, ASSET_ABI, deployer);
  const oracle = new ethers.Contract(deployment.oracle, HEADER_REPORT_ORACLE_ABI, deployer);
  const committee = new ethers.Contract(committeeAddr, COMMITTEE_ABI, deployer);

  const source = new ethersLib.JsonRpcProvider(
    process.env.SEPOLIA_RPC_URL ?? DEFAULT_SOURCE_RPC_URL,
    SOURCE_CHAIN,
    { staticNetwork: true },
  );
  const spender = new ethersLib.Wallet(need("SEPOLIA_PRIVATE_KEY"), source);
  const minConf = Number(await oracle.minConfirmations());
  const accountId = ethersLib.keccak256(
    ethersLib.toUtf8Bytes(process.env.ACCOUNT_ID_LABEL ?? "crsETH-withdraw-sapphire-1"),
  );

  console.log(`Committee (Sapphire contract): ${committeeAddr}`);
  console.log(`Asset: ${assetAddr}  Oracle: ${deployment.oracle}`);
  console.log(`Spender: ${spender.address}\n`);

  // --- 1. ask the committee for the encumbered account it controls ----------
  const [encAddress, encId] = await committee.encumberedAccount(assetAddr, accountId);
  console.log(`[1/8] committee-derived encumbered: ${encAddress}`);
  if (!(await asset.isEncumberedAccount(encId))) {
    await (await asset.registerEncumberedAccount(encId)).wait();
    console.log("      registered on the asset");
  }

  // --- 2. deposit to it: mints crsETH to spender + funds it with Sepolia ETH -
  const depositWei = ethersLib.parseEther(process.env.DEPOSIT_ETH ?? "0.0008");
  console.log(`[2/8] Depositing ${ethersLib.formatEther(depositWei)} ETH on Sepolia -> ${encAddress}…`);
  const fee = await source.getFeeData();
  const depReq = await spender.populateTransaction({
    to: encAddress,
    value: depositWei,
    type: 2,
    maxFeePerGas: fee.maxFeePerGas ?? ethersLib.parseUnits("30", "gwei"),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethersLib.parseUnits("2", "gwei"),
  });
  const depRaw = await spender.signTransaction(depReq);
  const depSent = await source.broadcastTransaction(depRaw);
  const depRcpt = await depSent.wait();
  if (!depRcpt) throw new Error("no deposit receipt");
  console.log(`      tx ${depSent.hash} @ block ${depRcpt.blockNumber}`);

  console.log(`[3/8] Confirming deposit + oracle report…`);
  await confirmAndReport(source, oracle, apiUrl, deployment.oracle, depRcpt.blockNumber, minConf);
  const depProof = await buildDepositProof(source, depRcpt.blockNumber, depRcpt.index);
  const balBefore: bigint = await asset.balanceOf(spender.address);
  await (await asset.deposit(depRaw, depProof)).wait();
  const minted: bigint = (await asset.balanceOf(spender.address)) - balBefore;
  console.log(`      minted ${ethersLib.formatEther(minted)} crsETH`);

  // --- 4. lock the crsETH for the encumbered account ------------------------
  console.log(`[4/8] lockWithdrawal(${ethersLib.formatEther(minted)} crsETH)…`);
  const assetAsSpender = asset.connect(new ethersLib.Wallet(spender.privateKey, ethers.provider));
  await (await (assetAsSpender as any).lockWithdrawal(minted, encId)).wait();

  // --- 5. build the unsigned withdrawal tx ----------------------------------
  const epoch = Number(await asset.accountEpoch(encId));
  const withdrawWei = ethersLib.parseEther(process.env.WITHDRAW_ETH ?? "0.0003");
  const maxFee = ethersLib.parseUnits(process.env.WITHDRAW_GWEI ?? "5", "gwei");
  const unsignedTx = ethersLib.Transaction.from({
    type: 2,
    chainId: SOURCE_CHAIN.chainId,
    nonce: epoch,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxFee,
    gasLimit: 35_000n,
    to: spender.address,
    value: withdrawWei,
    data: spender.address, // spender binding (first 20 bytes of payload)
  });
  const message = unsignedTx.unsignedSerialized;
  console.log(`[5/8] Unsigned withdrawal: nonce=${epoch}, amount=${ethersLib.formatEther(withdrawWei)} ETH`);

  // --- 6. SAPPHIRE COMMITTEE signs it (confidential eth_call) ----------------
  const reqHash = await committee.requestHash(assetAddr, accountId, message);
  const spenderSig = await spender.signMessage(ethersLib.getBytes(reqHash));
  const [signedBy, r, s, v] = await committee.sign(assetAddr, accountId, message, spenderSig);
  console.log(`[6/8] Sapphire committee signed; signer=${signedBy} v=${v}`);
  if (signedBy.toLowerCase() !== encAddress.toLowerCase()) throw new Error("committee signed for the wrong address");
  unsignedTx.signature = ethersLib.Signature.from({ r, s, v: Number(v) });
  const signedWithdrawal = unsignedTx.serialized;

  // --- 7. broadcast on Sepolia, confirm, oracle report ----------------------
  console.log(`[7/8] Broadcasting withdrawal on Sepolia…`);
  const wSent = await source.broadcastTransaction(signedWithdrawal);
  console.log(`      tx ${wSent.hash}`);
  const wRcpt = await wSent.wait();
  if (!wRcpt) throw new Error("no withdrawal receipt");
  await confirmAndReport(source, oracle, apiUrl, deployment.oracle, wRcpt.blockNumber, minConf);

  // --- 8. finalize ----------------------------------------------------------
  console.log(`[8/8] Finalizing withdrawal…`);
  const wTxJson = await source.send("eth_getTransactionByHash", [wSent.hash]);
  const wProof = await buildDepositProof(source, wRcpt.blockNumber, Number(wTxJson.transactionIndex));
  const preEpoch = Number(await asset.accountEpoch(encId));
  await (await (asset as any).finalizeWithdrawal(rawTxFromJson(wTxJson), wProof, encId)).wait();
  const postEpoch = Number(await asset.accountEpoch(encId));
  const [remaining] = await asset.getSpendingPosition(spender.address, encId);

  console.log(`\n✅ Withdrawal finalized — signed entirely by the Sapphire contract committee.`);
  console.log(`  withdrawal tx (Sepolia): ${wSent.hash}`);
  console.log(`  epoch ${preEpoch} -> ${postEpoch} (advanced: ${postEpoch === preEpoch + 1})`);
  console.log(`  remaining spending balance: ${ethersLib.formatEther(remaining)} crsETH`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
