import { ethers } from "ethers";

export type BitcoinNetwork = "mainnet" | "testnet" | "testnet4" | "signet" | "regtest";

export function bech32Hrp(network: BitcoinNetwork): string {
  switch (network) {
    case "mainnet":
      return "bc";
    case "testnet":
    case "testnet4":
    case "signet":
      return "tb";
    case "regtest":
      return "bcrt";
  }
}

export function hex(bytes: number[] | Uint8Array): string {
  return ethers.hexlify(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
}

export function concat(parts: string[]): string {
  return ethers.concat(parts);
}

export function le32(value: number): string {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return hex(out);
}

export function le64(value: bigint): string {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return hex(out);
}

export function varInt(value: number): string {
  if (value < 0xfd) {
    return hex([value]);
  }
  if (value <= 0xffff) {
    return hex([0xfd, value & 0xff, value >> 8]);
  }
  throw new Error("test helper only supports compact varints");
}

export function push(data: string): string {
  const bytes = ethers.getBytes(data);
  return concat([varInt(bytes.length), data]);
}

export function output(value: bigint, script: string): string {
  return concat([le64(value), push(script)]);
}

export function p2wpkh(hash160: string): string {
  return concat(["0x0014", hash160]);
}

export function opReturnAddress(address: string): string {
  return concat(["0x6a14", address]);
}

export function hash160(data: string): string {
  return ethers.ripemd160(ethers.getBytes(ethers.sha256(data)));
}

/// Pad a 20-byte hash160 to the 32-byte encumbered-account form used by the
/// asset/bridge contracts: `hash160 ++ 12 zero bytes`.
export function accountId(hash: string): string {
  return concat([hash, "0x" + "00".repeat(12)]);
}

export function dsha(data: string): string {
  return ethers.sha256(ethers.getBytes(ethers.sha256(data)));
}

function readVarIntJs(bytes: Uint8Array, offset: number): [number, number] {
  const first = bytes[offset];
  if (first < 0xfd) return [first, offset + 1];
  if (first === 0xfd) {
    return [bytes[offset + 1] | (bytes[offset + 2] << 8), offset + 3];
  }
  if (first === 0xfe) {
    return [
      bytes[offset + 1] |
        (bytes[offset + 2] << 8) |
        (bytes[offset + 3] << 16) |
        (bytes[offset + 4] << 24),
      offset + 5,
    ];
  }
  throw new Error("tx-helpers stripWitness: 8-byte varint not supported");
}

/// Strip the segwit marker, flag and witness data from `rawHex`, leaving the
/// canonical "txid" serialization. Mirrors BitcoinBridgeOracle._stripWitness.
export function stripWitness(rawHex: string): string {
  const bytes = ethers.getBytes(rawHex);
  if (bytes.length <= 5 || bytes[4] !== 0x00 || bytes[5] === 0x00) {
    return rawHex;
  }
  let offset = 6;
  const [inputCount, afterInputCount] = readVarIntJs(bytes, offset);
  offset = afterInputCount;
  for (let i = 0; i < inputCount; i++) {
    offset += 36; // 32 prev txid + 4 vout
    const [scriptLen, scriptOffset] = readVarIntJs(bytes, offset);
    offset = scriptOffset + scriptLen + 4; // scriptSig + sequence
  }
  const [outputCount, afterOutputCount] = readVarIntJs(bytes, offset);
  offset = afterOutputCount;
  for (let i = 0; i < outputCount; i++) {
    offset += 8;
    const [scriptLen, scriptOffset] = readVarIntJs(bytes, offset);
    offset = scriptOffset + scriptLen;
  }
  // offset now sits at the start of witness data; locktime is the trailing 4 bytes.
  const stripped = new Uint8Array(4 + (offset - 6) + 4);
  stripped.set(bytes.slice(0, 4), 0);
  stripped.set(bytes.slice(6, offset), 4);
  stripped.set(bytes.slice(bytes.length - 4), 4 + (offset - 6));
  return hex(stripped);
}

/// 80-byte Bitcoin block header with the given merkle root. Other fields are
/// zeroed/loose — only the merkle root and the resulting block hash matter to
/// the bridge oracle since the trivial block-hash oracle accepts any hash.
export function blockHeaderWithMerkleRoot(merkleRoot: string): string {
  return concat([le32(1), "0x" + "00".repeat(32), merkleRoot, le32(1), le32(0x207fffff), le32(0)]);
}

/// Build a single-tx inclusion proof for `rawTx` at the given block height.
/// The caller is expected to push `blockHash` into the block-hash oracle.
export function makeTrivialProof(
  rawTx: string,
  blockHeight: number,
): { proof: string; blockHash: string; header: string; txid: string } {
  const txid = dsha(stripWitness(rawTx));
  const header = blockHeaderWithMerkleRoot(txid);
  const blockHash = dsha(header);
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint256 blockHeight, bytes blockHeader, bytes32[] merkleProof, uint256 txIndex)"],
    [{ blockHeight, blockHeader: header, merkleProof: [], txIndex: 0 }],
  );
  return { proof, blockHash, header, txid };
}

export function reverseHex(hexValue: string): string {
  const prefixed = hexValue.startsWith("0x") || hexValue.startsWith("0X") ? hexValue : `0x${hexValue}`;
  return hex(Array.from(ethers.getBytes(prefixed)).reverse());
}

export function outpoint(txid: string, vout: number): string {
  return concat([reverseHex(txid), le32(vout)]);
}

/// BIP125 opt-in RBF (any value < 0xfffffffe enables replaceability; the
/// canonical "I opted in" value is 0xfffffffd). Also has the side-effect of
/// making Bitcoin consensus enforce nLockTime (which 0xffffffff disables).
export const SEQUENCE_RBF = 0xfffffffd;
export const SEQUENCE_FINAL = 0xffffffff;

export function input(prevTxid: string, vout: number, sequence = SEQUENCE_RBF): string {
  return concat([outpoint(prevTxid, vout), push("0x"), le32(sequence)]);
}

/// Committee-signed Bitcoin withdrawals always use locktime=0. The strict
/// `isValidForEpoch` check in BitcoinBridgeOracle does not enforce locktime,
/// but keeping it pinned to 0 matches the BIP143 preimage the committee signs
/// and avoids needing a fresh signing round to bump the locktime.
export function witnessTx(
  prevTxid: string,
  vout: number,
  spender: string,
  encPubkey: string,
  recipientHash: string,
  amount: bigint,
  change: bigint,
  witnessSignature: string,
): string {
  const encHash = hash160(encPubkey);
  const outs = [output(0n, opReturnAddress(spender))];
  if (change > 0n) {
    outs.push(output(change, p2wpkh(encHash)));
  }
  outs.push(output(amount, p2wpkh(recipientHash)));
  return concat([
    le32(2),
    "0x0001",
    varInt(1),
    input(prevTxid, vout),
    varInt(outs.length),
    ...outs,
    varInt(2),
    push(witnessSignature),
    push(encPubkey),
    le32(0),
  ]);
}

export function unsignedWitnessPolicyTx(
  prevTxid: string,
  vout: number,
  spender: string,
  encPubkey: string,
  recipientHash: string,
  amount: bigint,
  change: bigint,
): string {
  return witnessTx(
    prevTxid,
    vout,
    spender,
    encPubkey,
    recipientHash,
    amount,
    change,
    "0x304402200101010101010101010101010101010101010101010101010101010101010101022001010101010101010101010101010101010101010101010101010101010101010101",
  );
}

export function bip143P2wpkhPreimage(
  prevTxid: string,
  vout: number,
  inputAmount: bigint,
  encHash: string,
  outputs: string,
  sequence = SEQUENCE_RBF,
  sighashType = 1,
): string {
  const previousOutpoint = outpoint(prevTxid, vout);
  const sequenceBytes = le32(sequence);
  const scriptCode = concat(["0x1976a914", encHash, "0x88ac"]);
  return concat([
    le32(2),
    dsha(previousOutpoint),
    dsha(sequenceBytes),
    previousOutpoint,
    scriptCode,
    le64(inputAmount),
    sequenceBytes,
    dsha(outputs),
    le32(0),
    le32(sighashType),
  ]);
}

export function withdrawalOutputs(
  spender: string,
  encHash: string,
  recipientHash: string,
  amount: bigint,
  change: bigint,
): string {
  // Omit the change output entirely when change == 0; Bitcoin rejects 0-value
  // outputs and the bridge correctly treats "no encumbered output" as a full
  // drain (no canonical Crossroads UTXO after this withdrawal).
  const parts = [output(0n, opReturnAddress(spender))];
  if (change > 0n) {
    parts.push(output(change, p2wpkh(encHash)));
  }
  parts.push(output(amount, p2wpkh(recipientHash)));
  return concat(parts);
}

export function merkleProof(txids: string[], txIndex: number): string[] {
  let index = txIndex;
  let layer = txids.map(reverseHex);
  const proof: string[] = [];
  while (layer.length > 1) {
    if (layer.length % 2 === 1) {
      layer.push(layer[layer.length - 1]);
    }
    proof.push(layer[index ^ 1]);
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(dsha(concat([layer[i], layer[i + 1]])));
    }
    index = Math.floor(index / 2);
    layer = next;
  }
  return proof;
}

export function encodeBitcoinProof(
  blockHeight: number,
  blockHeader: string,
  proof: string[],
  txIndex: number,
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint256 blockHeight, bytes blockHeader, bytes32[] merkleProof, uint256 txIndex)"],
    [{ blockHeight, blockHeader, merkleProof: proof, txIndex }],
  );
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if (((top >> i) & 1) === 1) {
        chk ^= generators[i];
      }
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  return [...hrp]
    .map((c) => c.charCodeAt(0) >> 5)
    .concat(
      [0],
      [...hrp].map((c) => c.charCodeAt(0) & 31),
    );
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) {
    ret.push((acc << (toBits - bits)) & maxv);
  }
  return ret;
}

export function p2wpkhAddress(hash: string, network: BitcoinNetwork): string {
  const hrp = bech32Hrp(network);
  const data = [0, ...convertBits(ethers.getBytes(hash), 8, 5, true)];
  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (polymod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => BECH32_CHARSET[v]).join("")}`;
}

export function decodeP2wpkhAddress(address: string): { hash: string; network: BitcoinNetwork } {
  const sep = address.lastIndexOf("1");
  if (sep <= 0) {
    throw new Error(`invalid bech32 address: ${address}`);
  }
  const hrp = address.slice(0, sep).toLowerCase();
  const network: BitcoinNetwork = (() => {
    switch (hrp) {
      case "bc":
        return "mainnet";
      case "tb":
        return "testnet";
      case "bcrt":
        return "regtest";
      default:
        throw new Error(`unsupported bech32 HRP: ${hrp}`);
    }
  })();
  const body = address.slice(sep + 1).toLowerCase();
  const decoded: number[] = [];
  for (const ch of body) {
    const value = BECH32_CHARSET.indexOf(ch);
    if (value < 0) {
      throw new Error(`invalid bech32 character ${ch} in ${address}`);
    }
    decoded.push(value);
  }
  if (decoded.length < 7) {
    throw new Error(`bech32 address too short: ${address}`);
  }
  const payload = decoded.slice(0, decoded.length - 6);
  if (payload[0] !== 0) {
    throw new Error(`only witness v0 (P2WPKH) supported, got version ${payload[0]}`);
  }
  const programBits = payload.slice(1);
  const bytes = convertBits(Uint8Array.from(programBits), 5, 8, false);
  if (bytes.length !== 20) {
    throw new Error(`expected 20-byte P2WPKH program, got ${bytes.length}`);
  }
  return { hash: hex(bytes), network };
}

export class BitcoinRpc {
  private id = 0;
  private readonly url: URL;
  private auth?: string;

  constructor(rawUrl: string) {
    this.url = new URL(rawUrl);
    if (this.url.username.length > 0 || this.url.password.length > 0) {
      this.auth = Buffer.from(
        `${decodeURIComponent(this.url.username)}:${decodeURIComponent(this.url.password)}`,
      ).toString("base64");
      this.url.username = "";
      this.url.password = "";
    }
  }

  wallet(name: string): BitcoinRpc {
    const next = new BitcoinRpc(this.url.toString());
    next.auth = this.auth;
    next.url.pathname = `/wallet/${name}`;
    return next;
  }

  async call<T = any>(method: string, params: any[] = []): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.auth === undefined ? {} : { authorization: `Basic ${this.auth}` }),
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
    });
    const body: any = await response.json();
    if (body.error !== null) {
      throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
    }
    return body.result as T;
  }
}

export interface InclusionProof {
  header: string;
  proof: string[];
  txIndex: number;
  height: number;
}

export async function fetchInclusionProof(
  wallet: BitcoinRpc,
  txid: string,
): Promise<InclusionProof> {
  const tx = await wallet.call<any>("getrawtransaction", [txid, true]);
  if (typeof tx.blockhash !== "string") {
    throw new Error(`transaction ${txid} is not yet in a block`);
  }
  const block = await wallet.call<any>("getblock", [tx.blockhash, 1]);
  const header = await wallet.call<string>("getblockheader", [tx.blockhash, false]);
  const txIndex = block.tx.indexOf(txid);
  if (txIndex < 0) {
    throw new Error(`transaction ${txid} missing from mined block ${tx.blockhash}`);
  }
  return {
    header: `0x${header}`,
    proof: merkleProof(block.tx, txIndex),
    txIndex,
    height: block.height,
  };
}

export async function mineTxProof(
  wallet: BitcoinRpc,
  txid: string,
): Promise<InclusionProof> {
  const miningAddress = await wallet.call<string>("getnewaddress", ["", "bech32"]);
  await wallet.call("generatetoaddress", [1, miningAddress]);
  return fetchInclusionProof(wallet, txid);
}

export async function waitForConfirmations(
  wallet: BitcoinRpc,
  txid: string,
  minConfirmations: number,
  timeoutMs: number,
  pollIntervalMs = 5_000,
): Promise<InclusionProof> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tx = await wallet.call<any>("getrawtransaction", [txid, true]).catch(() => undefined);
    if (tx !== undefined && typeof tx.confirmations === "number" && tx.confirmations >= minConfirmations) {
      return fetchInclusionProof(wallet, txid);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `transaction ${txid} did not reach ${minConfirmations} confirmations within ${timeoutMs}ms`,
  );
}

export async function findP2wpkhOutput(
  wallet: BitcoinRpc,
  rawTx: string,
  encHash: string,
): Promise<{ vout: number; value: bigint }> {
  const decoded = await wallet.call<any>("decoderawtransaction", [rawTx.slice(2)]);
  const script = p2wpkh(encHash).slice(2);
  const out = decoded.vout.find((v: any) => v.scriptPubKey.hex === script);
  if (out === undefined) {
    throw new Error(`missing P2WPKH output ${script}`);
  }
  return { vout: out.n, value: BigInt(Math.round(Number(out.value) * 100_000_000)) };
}

export async function sendDepositTx(
  wallet: BitcoinRpc,
  sender: string,
  encHash: string,
  amountBtc: string,
  network: BitcoinNetwork,
  feeRateSatVb = 1,
): Promise<{ txid: string; rawTx: string }> {
  const address = p2wpkhAddress(encHash, network);
  const raw = await wallet.call<string>("createrawtransaction", [
    [],
    [{ data: sender.slice(2) }, { [address]: amountBtc }],
  ]);
  const funded = await wallet.call<any>("fundrawtransaction", [
    raw,
    { fee_rate: feeRateSatVb, changePosition: 2 },
  ]);
  const signed = await wallet.call<any>("signrawtransactionwithwallet", [funded.hex]);
  const txid = await wallet.call<string>("sendrawtransaction", [signed.hex]);
  return { txid, rawTx: `0x${signed.hex}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
