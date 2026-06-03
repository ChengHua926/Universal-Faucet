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
import bs58 from "bs58";
import { ethers } from "ethers";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function loadPrimaryKeypair(): Keypair {
  if (process.env.SOLANA_ALLOW_LOCAL_PRIMARY_SIGNING !== "1") {
    throw new Error(
      "Refusing to load a local encumbered-account private key. Use the signing committee for real withdrawals.",
    );
  }
  if (process.env.SOLANA_PRIMARY_SECRET_KEY !== undefined) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(process.env.SOLANA_PRIMARY_SECRET_KEY)),
    );
  }
  const path = required("SOLANA_PRIMARY_KEYPAIR");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function primaryPublicKey(): PublicKey {
  if (
    process.env.SOLANA_ENCUMBERED_ACCOUNT !== undefined &&
    process.env.SOLANA_ENCUMBERED_ACCOUNT.length > 0
  ) {
    return new PublicKey(process.env.SOLANA_ENCUMBERED_ACCOUNT);
  }
  if (
    process.env.SOLANA_PRIMARY_ACCOUNT !== undefined &&
    process.env.SOLANA_PRIMARY_ACCOUNT.length > 0
  ) {
    return new PublicKey(process.env.SOLANA_PRIMARY_ACCOUNT);
  }
  return loadPrimaryKeypair().publicKey;
}

const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(rpcUrl, "finalized");
const signOnly = process.env.SIGN_ONLY === "1";
const primaryPubkey = signOnly ? primaryPublicKey() : loadPrimaryKeypair().publicKey;
const nonceAccount = new PublicKey(required("SOLANA_NONCE_ACCOUNT"));
const recipient = new PublicKey(required("SOLANA_RECIPIENT"));
const spender = ethers.getAddress(required("CROSSROADS_SPENDER"));
const lamports = BigInt(required("LAMPORTS"));
if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
  throw new Error("LAMPORTS exceeds JavaScript safe integer range for @solana/web3.js");
}

const nonceInfo = await connection.getNonce(nonceAccount, "finalized");
if (nonceInfo === null) {
  throw new Error(`Nonce account ${nonceAccount.toBase58()} not found`);
}

const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const memoData = Buffer.from(spender.slice(2).toLowerCase(), "utf8");
const msg = new TransactionMessage({
  payerKey: primaryPubkey,
  recentBlockhash: nonceInfo.nonce,
  instructions: [
    SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: primaryPubkey }),
    SystemProgram.transfer({
      fromPubkey: primaryPubkey,
      toPubkey: recipient,
      lamports: Number(lamports),
    }),
    new TransactionInstruction({ programId: memoProgram, keys: [], data: memoData }),
  ],
}).compileToV0Message();
const tx = new VersionedTransaction(msg);

if (signOnly) {
  console.log(
    JSON.stringify(
      {
        rpcUrl,
        primary: primaryPubkey.toBase58(),
        nonceAccount: nonceAccount.toBase58(),
        currentDurableNonce: nonceInfo.nonce,
        currentDurableNonceHex: ethers.hexlify(bs58.decode(nonceInfo.nonce)),
        unsignedMessage: ethers.hexlify(msg.serialize()),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const primary = loadPrimaryKeypair();
tx.sign([primary]);
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
