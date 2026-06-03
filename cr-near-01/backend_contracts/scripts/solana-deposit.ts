import fs from "node:fs";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ethers } from "ethers";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function loadKeypair(): Keypair {
  if (process.env.SOLANA_DEPOSITOR_SECRET_KEY !== undefined) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(process.env.SOLANA_DEPOSITOR_SECRET_KEY)),
    );
  }
  if (process.env.SOLANA_SECRET_KEY !== undefined) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY)));
  }
  const path =
    process.env.SOLANA_DEPOSITOR_KEYPAIR ??
    process.env.SOLANA_KEYPAIR ??
    `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(rpcUrl, "finalized");
const payer = loadKeypair();
const encumberedAccount = new PublicKey(required("SOLANA_ENCUMBERED_ACCOUNT"));
const crossroadsAccount = ethers.getAddress(required("CROSSROADS_ACCOUNT"));
const lamports = BigInt(required("LAMPORTS"));
if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
  throw new Error("LAMPORTS exceeds JavaScript safe integer range for @solana/web3.js");
}

const latest = await connection.getLatestBlockhash("finalized");
const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const memoData = Buffer.from(crossroadsAccount.slice(2).toLowerCase(), "utf8");
const msg = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: latest.blockhash,
  instructions: [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: encumberedAccount,
      lamports: Number(lamports),
    }),
    new TransactionInstruction({
      programId: memoProgram,
      keys: [],
      data: memoData,
    }),
  ],
}).compileToV0Message();
const tx = new VersionedTransaction(msg);
tx.sign([payer]);
const signature = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction(signature, "finalized");

console.log(
  JSON.stringify(
    {
      rpcUrl,
      signature,
      serializedTransaction: ethers.hexlify(tx.serialize()),
      crossroadsOracleTxHash: ethers.keccak256(ethers.hexlify(tx.signatures[0])),
    },
    null,
    2,
  ),
);
