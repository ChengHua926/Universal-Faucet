// Full live withdrawal: deposit to the encumbered address the SigningCommittee
// contract controls, lock the minted crsETH, have the committee sign the withdrawal
// in a single confidential eth_call, broadcast on Sepolia, and finalize against the
// TEE oracle. The signer is a Sapphire contract — no MPC, no nodes, no DKG.
//
// Committee = James's EIP-712 `SigningCommittee`: the spender authorizes the
// request with an EIP-712 `SignRequest` typed signature, and `sign(...)` returns
// the raw Sapphire ASN.1 DER signature (not r||s||v), which we split + recover v
// against the derived signer here on the client.
//
//   SAPPHIRE_PRIVATE_KEY / SEPOLIA_PRIVATE_KEY / CROSSROADS_ORACLE_API in env,
//   COMMITTEE_ADDRESS=0x... (deploy one with scripts/deploy-committee.js)
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

const ALG = 1; // ALG_SECP256K1_KECCAK256

const COMMITTEE_ABI = [
  "function signerAddress(address asset, bytes32 encAccount, uint256 algId) view returns (address)",
  "function assetAccount(address asset, bytes32 encAccount, uint256 algId) view returns (address signer, bytes32 assetEncId)",
  "function sign(address asset, bytes32 encAccount, uint256 algId, bytes txData, bytes requesterSig) view returns (bytes)",
];

// EIP-712 typed request the committee authorizes against (domain bound to the
// committee's chain + address).
const SIGN_REQUEST_TYPES = {
  SignRequest: [
    { name: "asset", type: "address" },
    { name: "encAccount", type: "bytes32" },
    { name: "txData", type: "bytes" },
  ],
};

// Split Sapphire's ASN.1 DER secp256k1 signature into (r,s) and recover v by
// matching the derived signer over `digest`.
function pad32(bytes: Uint8Array): string {
  let x = bytes;
  while (x.length > 32 && x[0] === 0x00) x = x.slice(1); // strip DER sign byte
  const out = new Uint8Array(32);
  out.set(x, 32 - x.length);
  return ethersLib.hexlify(out);
}
function derToRSV(derHex: string, digest: string, signer: string) {
  const d = ethersLib.getBytes(derHex);
  if (d[0] !== 0x30) throw new Error("not a DER sequence");
  let i = 2;
  if (d[i] !== 0x02) throw new Error("DER: expected r");
  const rlen = d[i + 1];
  i += 2;
  const r = pad32(d.slice(i, i + rlen));
  i += rlen;
  if (d[i] !== 0x02) throw new Error("DER: expected s");
  const slen = d[i + 1];
  i += 2;
  const s = pad32(d.slice(i, i + slen));
  for (const v of [27, 28]) {
    if (ethersLib.recoverAddress(digest, { r, s, v }).toLowerCase() === signer.toLowerCase()) {
      return { r, s, v };
    }
  }
  throw new Error("could not recover v against the derived signer");
}

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
  const committeeAddr = ethersLib.getAddress(need("COMMITTEE_ADDRESS"));

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
  // encId is the asset-facing id (bytes32(uint160(signer))); accountId is the
  // derivation label.
  const [encAddress, encId] = await committee.assetAccount(assetAddr, accountId, ALG);
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
  // The spender authorizes the request with an EIP-712 SignRequest; the domain
  // binds the committee's chain (Sapphire) + address. sign() returns raw DER.
  const domain = {
    name: "SigningCommittee",
    version: "1",
    chainId: net.chainId,
    verifyingContract: committeeAddr,
  };
  const reqSig = await spender.signTypedData(domain, SIGN_REQUEST_TYPES, {
    asset: assetAddr,
    encAccount: accountId,
    txData: message,
  });
  const der = await committee.sign(assetAddr, accountId, ALG, message, reqSig);
  const { r, s, v } = derToRSV(der, ethersLib.keccak256(message), encAddress);
  console.log(`[6/8] Sapphire committee signed (DER ${der.slice(0, 12)}…); v=${v}`);
  unsignedTx.signature = ethersLib.Signature.from({ r, s, v });
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
