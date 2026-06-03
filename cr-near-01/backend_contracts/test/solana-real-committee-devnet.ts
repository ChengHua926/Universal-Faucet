import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import { expect } from "chai";
import { network } from "hardhat";
import fs from "node:fs";

import { createSigningCommittee } from "../scripts/signing-committee.js";

const { ethers } = await network.connect();
const maybeRealCommitteeSolana =
  process.env.SOLANA_RPC_URL === undefined || process.env.SIGNING_COMMITTEE !== "real"
    ? it.skip
    : it;

function shortvec(value: number): string {
  const out: number[] = [];
  let n = value;
  while (true) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return ethers.hexlify(Uint8Array.from(out));
}

function pubkeyBytes(pubkey: { toBytes(): Uint8Array }): string {
  return ethers.hexlify(pubkey.toBytes());
}

function memoAddressData(account: string): Buffer {
  return Buffer.from(account.slice(2).toLowerCase(), "utf8");
}

function primarySig(signedTx: string): string {
  const bytes = ethers.getBytes(signedTx);
  const [, sigOffset] = readShortvec(bytes, 0);
  return ethers.hexlify(bytes.slice(sigOffset, sigOffset + 64));
}

function solanaProof(signedTx: string): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [primarySig(signedTx)]);
}

function loadDepositorKeypair(web3: typeof import("@solana/web3.js")): any | undefined {
  const secret = process.env.SOLANA_DEPOSITOR_SECRET_KEY ?? process.env.SOLANA_SECRET_KEY;
  if (secret !== undefined && secret.trim() !== "") {
    return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  }

  const path = process.env.SOLANA_DEPOSITOR_KEYPAIR ?? process.env.SOLANA_KEYPAIR;
  if (path !== undefined && path.trim() !== "") {
    return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
  }

  return undefined;
}

function requiredLamports(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return BigInt(value);
}

async function fundedDepositor(
  web3: typeof import("@solana/web3.js"),
  connection: any,
  minimumLamports: bigint,
): Promise<any> {
  const depositor = loadDepositorKeypair(web3);
  if (depositor !== undefined) {
    const balance = await connection.getBalance(depositor.publicKey, "finalized");
    if (BigInt(balance) < minimumLamports) {
      throw new Error(
        `SOLANA_DEPOSITOR_SECRET_KEY balance ${balance} lamports is below required ${minimumLamports.toString()} lamports`,
      );
    }
    return depositor;
  }

  if (process.env.SOLANA_ALLOW_AIRDROP !== "1") {
    throw new Error(
      "SOLANA_DEPOSITOR_SECRET_KEY is required for real Solana e2e. Set SOLANA_ALLOW_AIRDROP=1 only for a local validator.",
    );
  }

  const depositorFromAirdrop = web3.Keypair.generate();
  const signature = await connection.requestAirdrop(
    depositorFromAirdrop.publicKey,
    Number(minimumLamports),
  );
  await waitForFinalized(connection, signature);
  return depositorFromAirdrop;
}

function readShortvec(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (true) {
    const b = bytes[cursor++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [value, cursor];
    }
    shift += 7;
  }
}

async function waitForFinalized(connection: any, signature: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (status.value?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Solana transaction ${signature} did not finalize`);
}

async function deploySolanaStack() {
  const [owner, prover] = await ethers.getSigners();
  const SolanaLib = await ethers.getContractFactory("SolanaTransactionLib");
  const solanaLib = await SolanaLib.deploy();
  await solanaLib.waitForDeployment();

  const Oracle = await ethers.getContractFactory("SolanaBridgeOracle", {
    libraries: { SolanaTransactionLib: solanaLib.target },
  });
  const oracle = await Oracle.deploy([], 0);
  await oracle.waitForDeployment();

  const Asset = await ethers.getContractFactory("CrossroadsAssetContract");
  const asset = await Asset.deploy("Crossroads Wrapped SOL", "cWSOL", oracle, 2, 1000);
  await asset.waitForDeployment();
  return { owner, prover, oracle, asset };
}

describe("Crossroads Solana real signing committee e2e", function () {
  maybeRealCommitteeSolana(
    "signs and broadcasts a real Solana v0 durable-nonce withdrawal with the committee Ed25519 key",
    async function () {
      this.timeout(240_000);
      const web3 = await import("@solana/web3.js");
      const bs58Module = await import("bs58");
      const bs58 = (bs58Module as any).default ?? bs58Module;

      const connection = new web3.Connection(process.env.SOLANA_RPC_URL!, "finalized");
      const nonceAccount = web3.Keypair.generate();
      const recipient = web3.Keypair.generate();
      const { owner, prover, oracle, asset } = await deploySolanaStack();
      const committee = createSigningCommittee(asset as any, owner);
      const depositLamports = requiredLamports("SOLANA_DEPOSIT_LAMPORTS", 100_000_000n);
      const withdrawalLamports = requiredLamports("SOLANA_WITHDRAWAL_LAMPORTS", 50_000_000n);
      const maxDepositLamports = requiredLamports("SOLANA_MAX_DEPOSIT_LAMPORTS", 200_000_000n);
      if (depositLamports <= 0n || withdrawalLamports <= 0n) {
        throw new Error("SOLANA_DEPOSIT_LAMPORTS and SOLANA_WITHDRAWAL_LAMPORTS must be positive");
      }
      if (depositLamports > maxDepositLamports) {
        throw new Error("SOLANA_DEPOSIT_LAMPORTS exceeds SOLANA_MAX_DEPOSIT_LAMPORTS");
      }
      if (withdrawalLamports >= depositLamports) {
        throw new Error("SOLANA_WITHDRAWAL_LAMPORTS must be less than SOLANA_DEPOSIT_LAMPORTS");
      }
      if (
        depositLamports > BigInt(Number.MAX_SAFE_INTEGER) ||
        withdrawalLamports > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new Error("Solana lamport amounts exceed JavaScript safe integer range");
      }
      const rent = BigInt(
        await connection.getMinimumBalanceForRentExemption(web3.NONCE_ACCOUNT_LENGTH),
      );
      // Airdrop must cover: the deposit transfer, the rent reserved by the
      // nonce account, plus enough leftover for the depositor account itself to
      // stay rent-exempt (≈ 890_880 lamports for a 0-data system account) since
      // Solana rejects txs that would leave a non-zero balance below rent
      // exemption. 2_000_000 gives a comfortable cushion for fees + rent.
      const depositorRequiredLamports = depositLamports + rent + 2_000_000n;

      await committee.setup();
      try {
        const encAccount = committee.getEncAddressId();
        const publicKey = committee.getPublicKey();
        if (publicKey === undefined) {
          throw new Error("real committee did not return an Ed25519 public key");
        }
        expect(encAccount).to.equal(ethers.hexlify(ethers.getBytes(publicKey)));
        const primary = new web3.PublicKey(ethers.getBytes(encAccount));

        await expect(committee.registerEncumberedAccount())
          .to.emit(asset, "EncumberedAccountRegistered")
          .withArgs(encAccount);

        const depositor = await fundedDepositor(web3, connection, depositorRequiredLamports);

        const memoProgram = new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
        const spenderMemo = memoAddressData(owner.address);

        const depositMessage = new web3.TransactionMessage({
          payerKey: depositor.publicKey,
          recentBlockhash: (await connection.getLatestBlockhash("finalized")).blockhash,
          instructions: [
            web3.SystemProgram.transfer({
              fromPubkey: depositor.publicKey,
              toPubkey: primary,
              lamports: Number(depositLamports),
            }),
            new web3.TransactionInstruction({
              programId: memoProgram,
              keys: [],
              data: spenderMemo,
            }),
          ],
        }).compileToV0Message();
        const depositTx = new web3.VersionedTransaction(depositMessage);
        depositTx.sign([depositor]);
        const depositRaw = ethers.hexlify(depositTx.serialize());
        const depositSig = await connection.sendRawTransaction(depositTx.serialize());
        await waitForFinalized(connection, depositSig);

        await oracle.submitFinalizedTransactionBytes(depositRaw, []);
        await expect(asset.deposit(depositRaw, solanaProof(depositRaw)))
          .to.emit(asset, "DepositProcessed")
          .withArgs(
            owner.address,
            encAccount,
            depositLamports,
            ethers.keccak256(primarySig(depositRaw)),
          );
        expect(await asset.balanceOf(owner.address)).to.equal(depositLamports);

        const initMessage = new web3.TransactionMessage({
          payerKey: depositor.publicKey,
          recentBlockhash: (await connection.getLatestBlockhash("finalized")).blockhash,
          instructions: [
            web3.SystemProgram.createAccount({
              fromPubkey: depositor.publicKey,
              newAccountPubkey: nonceAccount.publicKey,
              lamports: Number(rent),
              space: web3.NONCE_ACCOUNT_LENGTH,
              programId: web3.SystemProgram.programId,
            }),
            web3.SystemProgram.nonceInitialize({
              noncePubkey: nonceAccount.publicKey,
              authorizedPubkey: primary,
            }),
          ],
        }).compileToV0Message();
        const initTx = new web3.VersionedTransaction(initMessage);
        initTx.sign([depositor, nonceAccount]);
        const initRaw = ethers.hexlify(initTx.serialize());
        const decodedInit = await oracle.decodeNonceInitialization(
          initRaw,
          encAccount,
          pubkeyBytes(nonceAccount.publicKey),
        );
        expect(decodedInit.authority).to.equal(encAccount);
        const initSig = await connection.sendRawTransaction(initTx.serialize());
        await waitForFinalized(connection, initSig);

        const nonceInfo = await connection.getNonce(nonceAccount.publicKey, "finalized");
        if (nonceInfo === null) {
          throw new Error("failed to fetch nonce account");
        }
        const currentNonce = ethers.hexlify(bs58.decode(nonceInfo.nonce));
        await oracle.setDurableNonce(encAccount, pubkeyBytes(nonceAccount.publicKey), currentNonce);

        await expect(asset.lockWithdrawal(depositLamports, encAccount, { value: 1000 }))
          .to.emit(asset, "SpendingBalanceIncreased")
          .withArgs(owner.address, encAccount, depositLamports, depositLamports);

        const withdrawalMessage = new web3.TransactionMessage({
          payerKey: primary,
          recentBlockhash: nonceInfo.nonce,
          instructions: [
            web3.SystemProgram.nonceAdvance({
              noncePubkey: nonceAccount.publicKey,
              authorizedPubkey: primary,
            }),
            web3.SystemProgram.transfer({
              fromPubkey: primary,
              toPubkey: recipient.publicKey,
              lamports: Number(withdrawalLamports),
            }),
            new web3.TransactionInstruction({
              programId: memoProgram,
              keys: [],
              data: spenderMemo,
            }),
          ],
        }).compileToV0Message();
        const withdrawalMessageBytes = ethers.hexlify(withdrawalMessage.serialize());
        expect(await asset.canSign(owner.address, encAccount, withdrawalMessageBytes)).to.equal(
          true,
        );

        const signed = await committee.signRawMessage(withdrawalMessageBytes, owner);
        expect(signed.signatureKind).to.equal("ed25519-rfc8032-raw");
        expect(signed.publicKey?.toLowerCase()).to.equal(publicKey.toLowerCase());
        expect(ethers.getBytes(signed.signature)).to.have.length(64);

        const signedWithdrawal = ethers.concat([
          shortvec(1),
          signed.signature,
          withdrawalMessageBytes,
        ]);
        expect(
          await oracle.isValidForEpoch(signedWithdrawal, encAccount, 0, owner.address),
        ).to.equal(true);
        expect(await oracle.getTransactionCostForAccount(signedWithdrawal, encAccount)).to.equal(
          withdrawalLamports + 5_000n,
        );

        const networkSig = await connection.sendRawTransaction(ethers.getBytes(signedWithdrawal));
        expect(networkSig).to.equal(bs58.encode(ethers.getBytes(signed.signature)));
        await waitForFinalized(connection, networkSig);

        await oracle.submitFinalizedTransactionBytes(signedWithdrawal, []);
        await expect(
          asset
            .connect(prover)
            .finalizeWithdrawal(signedWithdrawal, solanaProof(signedWithdrawal), encAccount),
        )
          .to.emit(asset, "WithdrawalFinalized")
          .withArgs(owner.address, encAccount, withdrawalLamports + 5_000n, 1000n, anyValue);
        expect(await asset.accountEpoch(encAccount)).to.equal(1n);
        expect(await asset.spendingBalance(owner.address, encAccount)).to.equal(
          depositLamports - withdrawalLamports - 5_000n,
        );
        await expect(
          asset
            .connect(prover)
            .finalizeWithdrawal(signedWithdrawal, solanaProof(signedWithdrawal), encAccount),
        ).to.be.revertedWith("Withdrawal already processed");
      } finally {
        await committee.shutdown();
      }
    },
  );
});
