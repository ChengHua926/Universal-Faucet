import { encode } from "@ethereumjs/rlp";
import { Trie } from "@ethereumjs/trie";
import { ethers, JsonRpcApiProvider, type BytesLike } from "ethers";

export function getMappingStorageSlot(mappingKey: BytesLike, mappingSlot: BytesLike): string {
  return ethers.keccak256(
    ethers.concat([ethers.zeroPadValue(mappingKey, 32), ethers.zeroPadValue(mappingSlot, 32)]),
  );
}

export function getRpcUint(number: any): string {
  return "0x" + BigInt(number).toString(16);
}

export function getRlpUint(number: any): string {
  let hex_value = "0x" + number.toString(16);
  if (hex_value.length % 2 != 0) {
    hex_value = "0x0" + hex_value.slice(2);
  }
  return number > 0 ? ethers.encodeRlp(ethers.getBytes(hex_value)) : ethers.encodeRlp("0x");
}

export async function getTxInclusionProof(
  provider: JsonRpcApiProvider,
  blockNumber: number,
  txIndex: number,
): Promise<{ rlpBlockHeader: string; proof: string[] }> {
  const rawBlock = await provider.send("debug_getRawBlock", [getRpcUint(blockNumber)]);
  const blockRlp = ethers.decodeRlp(rawBlock);
  // TODO: Review whether we can make this type conversion
  const blockHeader: string[] = blockRlp[0] as string[];
  const rawTransactions: string[] = blockRlp[1] as string[];

  // Build Merkle tree
  const trie = new Trie();
  for (let [i, rawTransaction] of rawTransactions.entries()) {
    if (typeof rawTransaction == "object") {
      await trie.put(ethers.getBytes(getRlpUint(i)), ethers.getBytes(encode(rawTransaction)));
    } else {
      await trie.put(ethers.getBytes(getRlpUint(i)), ethers.getBytes(rawTransaction));
    }
  }

  // Ensure the transaction root was constructed the same way
  const txRoot = ethers.hexlify(trie.root());
  if (txRoot != blockHeader[4]) {
    throw new Error(
      "Constructed transaction Merkle tree has a root inconsistent with the transactionsRoot in the block header",
    );
  }

  if (txIndex >= rawTransactions.length) {
    throw new Error("Transaction index is outside the range of this block");
  }

  // Generate the proof of the transaction
  const txProof = await trie.createProof(ethers.getBytes(getRlpUint(txIndex)));
  const txProofHex = txProof.map((x) => ethers.hexlify(x));
  return {
    rlpBlockHeader: ethers.encodeRlp(blockHeader),
    proof: txProofHex,
  };
}

// --- debug-free variant -----------------------------------------------------
//
// Public EVM testnet RPCs almost never expose debug_getRawBlock (we probed
// Sepolia: publicnode/1rpc reject it, dRPC gates it behind a paid tier). This
// variant builds the exact same proof from the standard eth_getBlockByNumber
// (full transactions) by re-serializing every transaction with ethers and
// re-RLP-encoding the header. Both reconstructions are self-checked against the
// header's transactionsRoot and the block hash, so a silent mis-encoding is
// impossible — the function throws instead of emitting a bad proof. Validated
// against live Sepolia blocks carrying type 0/2/3 transactions.

// Minimal big-endian encoding of an RPC quantity for RLP (0 -> empty string).
function rlpQuantity(hexQuantity: any): string {
  const v = BigInt(hexQuantity ?? 0);
  return v === 0n ? "0x" : ethers.toBeHex(v);
}

// Rebuild the canonical RLP block header from eth_getBlockByNumber JSON. Field
// order follows the consensus header through Prague/Pectra; trailing fork
// fields are appended only when the block carries them, so one code path works
// across forks. keccak(result) must equal block.hash (asserted by the caller).
export function rlpBlockHeaderFromJson(b: any): string {
  const fields: string[] = [
    b.parentHash,
    b.sha3Uncles,
    b.miner,
    b.stateRoot,
    b.transactionsRoot,
    b.receiptsRoot,
    b.logsBloom,
    rlpQuantity(b.difficulty),
    rlpQuantity(b.number),
    rlpQuantity(b.gasLimit),
    rlpQuantity(b.gasUsed),
    rlpQuantity(b.timestamp),
    b.extraData,
    b.mixHash,
    b.nonce,
  ];
  if (b.baseFeePerGas != null) fields.push(rlpQuantity(b.baseFeePerGas)); // London
  if (b.withdrawalsRoot != null) fields.push(b.withdrawalsRoot); // Shanghai
  if (b.blobGasUsed != null) fields.push(rlpQuantity(b.blobGasUsed)); // Cancun
  if (b.excessBlobGas != null) fields.push(rlpQuantity(b.excessBlobGas)); // Cancun
  if (b.parentBeaconBlockRoot != null) fields.push(b.parentBeaconBlockRoot); // Cancun
  if (b.requestsHash != null) fields.push(b.requestsHash); // Prague
  return ethers.encodeRlp(fields);
}

// Build an ethers Signature from a JSON-RPC object. Typed (EIP-2718)
// transactions carry `yParity` (0/1); legacy transactions carry an EIP-155 `v`,
// from which ethers derives the parity. Prefer yParity when present so a typed
// tx whose node also echoes v=0/1 isn't misread as a legacy v.
function sigFromJson(o: any): ethers.Signature {
  if (o.yParity != null) {
    return ethers.Signature.from({ r: o.r, s: o.s, yParity: (Number(o.yParity) ? 1 : 0) as 0 | 1 });
  }
  return ethers.Signature.from({ r: o.r, s: o.s, v: Number(o.v) });
}

// Re-serialize a JSON-RPC transaction into its canonical signed raw bytes — the
// exact leaf value in the block's transactions trie — for every EIP-2718 type.
export function rawTxFromJson(tx: any): string {
  const type = tx.type == null ? 0 : Number(tx.type);
  const like: any = {
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
    like.authorizationList = (tx.authorizationList ?? []).map((a: any) => ({
      address: a.address,
      nonce: BigInt(a.nonce),
      chainId: BigInt(a.chainId),
      signature: sigFromJson(a),
    }));
  } else {
    throw new Error(`Unsupported tx type ${type}`);
  }
  like.signature = sigFromJson(tx);
  const reconstructed = ethers.Transaction.from(like);
  if (reconstructed.hash!.toLowerCase() !== tx.hash.toLowerCase()) {
    throw new Error(`tx ${tx.hash}: reconstructed hash ${reconstructed.hash} disagrees with RPC`);
  }
  return reconstructed.serialized;
}

export async function getTxInclusionProofFromRpc(
  provider: JsonRpcApiProvider,
  blockNumber: number,
  txIndex: number,
): Promise<{ rlpBlockHeader: string; proof: string[] }> {
  const block = await provider.send("eth_getBlockByNumber", [getRpcUint(blockNumber), true]);
  const txs: any[] = block.transactions;

  const rlpBlockHeader = rlpBlockHeaderFromJson(block);
  if (ethers.keccak256(rlpBlockHeader).toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error("Reconstructed RLP header does not hash to the block hash");
  }
  if (txIndex >= txs.length) {
    throw new Error("Transaction index is outside the range of this block");
  }

  const trie = new Trie();
  for (let i = 0; i < txs.length; i++) {
    await trie.put(ethers.getBytes(getRlpUint(i)), ethers.getBytes(rawTxFromJson(txs[i])));
  }
  const txRoot = ethers.hexlify(trie.root());
  if (txRoot !== block.transactionsRoot) {
    throw new Error(
      "Reconstructed transactions trie root is inconsistent with the header transactionsRoot",
    );
  }

  const txProof = await trie.createProof(ethers.getBytes(getRlpUint(txIndex)));
  return {
    rlpBlockHeader,
    proof: txProof.map((x) => ethers.hexlify(x)),
  };
}
