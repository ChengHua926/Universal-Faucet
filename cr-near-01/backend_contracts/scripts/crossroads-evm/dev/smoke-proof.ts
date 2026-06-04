// Smoke-test the REAL exported buildDepositProof (the path the deposit uses)
// against a live Sepolia block: builds the ABI-encoded TransactionProof, then
// decodes it and confirms the header hashes to block.hash. No keys needed.
//   npx hardhat run scripts/crossroads-evm/dev/smoke-proof.ts --network hardhatMainnet

import { ethers as ethersLib } from "ethers";

import { DEFAULT_SOURCE_RPC_URL, SOURCE_CHAIN, buildDepositProof } from "../lib.js";

const p = new ethersLib.JsonRpcProvider(
  process.env.SEPOLIA_RPC_URL ?? DEFAULT_SOURCE_RPC_URL,
  SOURCE_CHAIN,
  { staticNetwork: true },
);

const latest = await p.getBlockNumber();
const bn = latest - 30;
const blk = await p.send("eth_getBlockByNumber", ["0x" + bn.toString(16), false]);
const txCount = blk.transactions.length;
console.log(`block ${bn}: ${txCount} txs`);
if (txCount === 0) {
  console.log("empty block, nothing to prove");
  process.exit(0);
}
const idx = Math.min(1, txCount - 1);
const encoded = await buildDepositProof(p, bn, idx);

const [decoded] = ethersLib.AbiCoder.defaultAbiCoder().decode(
  ["tuple(bytes rlpBlockHeader, bytes transactionIndexRlp, bytes transactionProofStack)"],
  encoded,
);
const headerOk = ethersLib.keccak256(decoded.rlpBlockHeader).toLowerCase() === blk.hash.toLowerCase();
console.log(`  proof for tx[${idx}]: ${encoded.length} hex chars`);
console.log(`  rlpBlockHeader: ${ethersLib.dataLength(decoded.rlpBlockHeader)} bytes, hashes to block.hash: ${headerOk}`);
console.log(`  transactionIndexRlp: ${decoded.transactionIndexRlp}`);
console.log(headerOk ? "✅ buildDepositProof (real TS export) works" : "❌ header mismatch");
process.exit(headerOk ? 0 : 1);
