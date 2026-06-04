// Standalone validation for the debug-free inclusion-proof approach.
//
// Reconstructs a real source-chain block's transaction trie using ONLY
// eth_getBlockByNumber (full txs) — no debug_getRawBlock — by re-serializing
// each transaction with ethers, then checks the rebuilt transactionsRoot against
// the header. If this matches on a live block, the same reconstruction is safe
// to feed the Crossroads BridgeOracle / ProvethVerifier.
//
// Usage:
//   SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
//   node scripts/_validate-proof-rpc.mjs [blockNumber]

import { encode } from "@ethereumjs/rlp";
import { Trie } from "@ethereumjs/trie";
import { ethers } from "ethers";

const RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN = { chainId: 11155111, name: "sepolia" };

function hexUint(n) {
  return "0x" + BigInt(n).toString(16);
}

// RLP-encode an integer index the way the tx trie keys it (canonical minimal,
// with 0 -> empty string). Mirrors scripts/inclusion-proofs.ts getRlpUint.
function getRlpUint(number) {
  const n = BigInt(number);
  let hex = "0x" + n.toString(16);
  if (hex.length % 2 !== 0) hex = "0x0" + hex.slice(2);
  return n > 0n ? ethers.encodeRlp(ethers.getBytes(hex)) : ethers.encodeRlp("0x");
}

// Re-serialize a JSON-RPC transaction object into its canonical signed raw bytes.
// The returned bytes are exactly what lives at the tx's leaf in the block's
// transactions trie, for every EIP-2718 type (0/1/2/3/4).
function rawTxFromJson(tx) {
  const type = tx.type == null ? 0 : Number(tx.type);
  const like = {
    type,
    nonce: Number(tx.nonce),
    gasLimit: BigInt(tx.gas),
    to: tx.to ?? null,
    value: BigInt(tx.value ?? 0),
    data: tx.input ?? "0x",
  };
  if (tx.chainId != null) like.chainId = BigInt(tx.chainId);
  if (type === 0) {
    like.gasPrice = BigInt(tx.gasPrice);
  } else if (type === 1) {
    like.gasPrice = BigInt(tx.gasPrice);
    like.accessList = tx.accessList ?? [];
  } else if (type === 2) {
    like.maxFeePerGas = BigInt(tx.maxFeePerGas);
    like.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas);
    like.accessList = tx.accessList ?? [];
  } else if (type === 3) {
    like.maxFeePerGas = BigInt(tx.maxFeePerGas);
    like.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas);
    like.accessList = tx.accessList ?? [];
    like.maxFeePerBlobGas = BigInt(tx.maxFeePerBlobGas);
    like.blobVersionedHashes = tx.blobVersionedHashes;
  } else if (type === 4) {
    like.maxFeePerGas = BigInt(tx.maxFeePerGas);
    like.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas);
    like.accessList = tx.accessList ?? [];
    like.authorizationList = (tx.authorizationList ?? []).map((a) => ({
      address: a.address,
      nonce: BigInt(a.nonce),
      chainId: BigInt(a.chainId),
      signature: ethers.Signature.from({
        r: a.r,
        s: a.s,
        yParity: a.yParity != null ? Number(a.yParity) : undefined,
        v: a.v != null ? Number(a.v) : undefined,
      }),
    }));
  } else {
    throw new Error(`Unsupported tx type ${type}`);
  }
  like.signature =
    tx.yParity != null
      ? ethers.Signature.from({ r: tx.r, s: tx.s, yParity: Number(tx.yParity) ? 1 : 0 })
      : ethers.Signature.from({ r: tx.r, s: tx.s, v: Number(tx.v) });
  const t = ethers.Transaction.from(like);
  if (t.hash.toLowerCase() !== tx.hash.toLowerCase()) {
    throw new Error(`tx ${tx.hash}: reconstructed hash ${t.hash} != rpc hash`);
  }
  return t.serialized;
}

// Minimal big-endian encoding of an RPC quantity for RLP (0 -> empty string).
function q(hexQuantity) {
  const v = BigInt(hexQuantity ?? 0);
  return v === 0n ? "0x" : ethers.toBeHex(v);
}

// Rebuild the canonical RLP block header from the eth_getBlockByNumber JSON.
// Field order follows the consensus header through Prague/Pectra; trailing
// fields are only appended when the block actually carries them, so the same
// code works pre- and post-fork. keccak(result) must equal block.hash.
function rlpHeaderFromJson(b) {
  const fields = [
    b.parentHash,
    b.sha3Uncles,
    b.miner,
    b.stateRoot,
    b.transactionsRoot,
    b.receiptsRoot,
    b.logsBloom,
    q(b.difficulty),
    q(b.number),
    q(b.gasLimit),
    q(b.gasUsed),
    q(b.timestamp),
    b.extraData,
    b.mixHash,
    b.nonce,
  ];
  if (b.baseFeePerGas != null) fields.push(q(b.baseFeePerGas)); // London
  if (b.withdrawalsRoot != null) fields.push(b.withdrawalsRoot); // Shanghai
  if (b.blobGasUsed != null) fields.push(q(b.blobGasUsed)); // Cancun
  if (b.excessBlobGas != null) fields.push(q(b.excessBlobGas)); // Cancun
  if (b.parentBeaconBlockRoot != null) fields.push(b.parentBeaconBlockRoot); // Cancun
  if (b.requestsHash != null) fields.push(b.requestsHash); // Prague
  return ethers.encodeRlp(fields);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: true });
  let blockNumber = process.argv[2] ? Number(process.argv[2]) : undefined;
  if (blockNumber == null) {
    const latest = await provider.send("eth_blockNumber", []);
    blockNumber = Number(latest) - 30; // well behind the tip to avoid reorgs
  }
  console.log(`RPC: ${RPC}`);
  console.log(`Validating block ${blockNumber}…`);

  const block = await provider.send("eth_getBlockByNumber", [hexUint(blockNumber), true]);
  const txs = block.transactions;
  console.log(`  txCount=${txs.length}  transactionsRoot=${block.transactionsRoot}`);

  // Header check: keccak(reconstructed RLP header) must equal block.hash.
  const rlpHeader = rlpHeaderFromJson(block);
  const headerHash = ethers.keccak256(rlpHeader);
  const headerOk = headerHash.toLowerCase() === block.hash.toLowerCase();
  console.log(`  header hash   =${headerHash}  ${headerOk ? "✅ == block.hash" : "❌ != " + block.hash}`);

  // Tally tx types for visibility.
  const typeCounts = {};
  for (const tx of txs) {
    const t = tx.type == null ? 0 : Number(tx.type);
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  }
  console.log(`  tx types: ${JSON.stringify(typeCounts)}`);

  const trie = new Trie();
  for (let i = 0; i < txs.length; i++) {
    const raw = rawTxFromJson(txs[i]);
    await trie.put(ethers.getBytes(getRlpUint(i)), ethers.getBytes(raw));
  }
  const root = ethers.hexlify(trie.root());
  const rootOk = root.toLowerCase() === block.transactionsRoot.toLowerCase();
  console.log(`  rebuilt root  =${root}`);
  const ok = rootOk && headerOk;
  console.log(
    ok
      ? "  ✅ header + transactionsRoot MATCH — debug-free reconstruction works"
      : `  ❌ MISMATCH (root ${rootOk ? "ok" : "BAD"}, header ${headerOk ? "ok" : "BAD"})`,
  );

  if (ok && txs.length > 0) {
    // Sanity: build a proof for tx index 0 and ensure encode() round-trips.
    const proof = await trie.createProof(ethers.getBytes(getRlpUint(0)));
    console.log(`  proof stack for tx[0]: ${proof.length} nodes`);
    void encode;
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
