// Standalone utility: fetch a TEE-signed header report from the oracle API and
// relay it on-chain via submitSignedHeader, so the block hash is available for
// later deposit proofs. Useful for testing report submission independently of a
// deposit. Block number is optional (omit -> newest quorum-confirmed block).
//
//   SAPPHIRE_PRIVATE_KEY=0x... \
//   [ORACLE_CONTRACT_ADDRESS=0x...] [CROSSROADS_ORACLE_API=...] [BLOCK_NUMBER=N] \
//     npx hardhat run scripts/crossroads-evm/submit-report.ts --network sapphireTestnet

import { ethers as ethersLib } from "ethers";
import { network } from "hardhat";

import {
  DEFAULT_ORACLE_ADDRESS,
  DEFAULT_ORACLE_API,
  HEADER_REPORT_ORACLE_ABI,
  fetchTeeReport,
  reportToTuple,
} from "./lib.js";

const { ethers } = await network.connect();

async function main() {
  const [signer] = await ethers.getSigners();
  const oracleAddress = ethersLib.getAddress(
    process.env.ORACLE_CONTRACT_ADDRESS ?? DEFAULT_ORACLE_ADDRESS,
  );
  const apiUrl = process.env.CROSSROADS_ORACLE_API ?? DEFAULT_ORACLE_API;
  const blockNumber = process.env.BLOCK_NUMBER ? Number(process.env.BLOCK_NUMBER) : undefined;

  console.log(`Oracle: ${oracleAddress}`);
  console.log(`API:    ${apiUrl}`);

  const report = await fetchTeeReport(apiUrl, oracleAddress, blockNumber);
  console.log(`Report for block ${report.blockNumber}: ${report.blockHash}`);
  console.log(`  signer=${report.signer} epoch=${report.signerEpoch} confs=${report.observedConfirmations}/${report.requiredConfirmations}`);

  const oracle = new ethers.Contract(oracleAddress, HEADER_REPORT_ORACLE_ABI, signer);
  const existing = await oracle.blockHashes(report.blockNumber);
  if (existing === report.blockHash) {
    console.log("Already stored (idempotent).");
  } else {
    const tx = await oracle.submitSignedHeader(reportToTuple(report), report.signature);
    console.log(`submitSignedHeader tx=${tx.hash}`);
    await tx.wait();
  }
  const stored = await oracle.getBlockHash(report.blockNumber);
  console.log(`oracle.getBlockHash(${report.blockNumber}) = ${stored} ✅`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
