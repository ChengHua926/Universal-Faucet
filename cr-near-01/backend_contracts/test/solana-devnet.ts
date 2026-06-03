import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
const maybeSolanaDevnet =
  process.env.SOLANA_RPC_URL === undefined || process.env.SOLANA_ALLOW_AIRDROP !== "1"
    ? it.skip
    : it;

function pubkeyBytes(pubkey: { toBytes(): Uint8Array }): string {
  return ethers.hexlify(pubkey.toBytes());
}

function memoAddressData(account: string): Buffer {
  return Buffer.from(account.slice(2).toLowerCase(), "utf8");
}

async function waitForFinalized(connection: any, signature: string): Promise<void> {
  const deadline = Date.now() + 60_000;
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

async function deploySolanaOracle() {
  const SolanaLib = await ethers.getContractFactory("SolanaTransactionLib");
  const solanaLib = await SolanaLib.deploy();
  await solanaLib.waitForDeployment();

  const Oracle = await ethers.getContractFactory("SolanaBridgeOracle", {
    libraries: { SolanaTransactionLib: solanaLib.target },
  });
  const oracle = await Oracle.deploy([], 0);
  await oracle.waitForDeployment();
  return oracle;
}

describe("Crossroads Solana devnet integration", function () {
  maybeSolanaDevnet(
    "submits and verifies a real durable-nonce v0 withdrawal on a local validator",
    async function () {
      this.timeout(120_000);
      const web3 = await import("@solana/web3.js");
      const bs58Module = await import("bs58");
      const bs58 = (bs58Module as any).default ?? bs58Module;

      const connection = new web3.Connection(process.env.SOLANA_RPC_URL!, "finalized");
      const payer = web3.Keypair.generate();
      const primary = web3.Keypair.generate();
      const nonceAccount = web3.Keypair.generate();
      const recipient = web3.Keypair.generate();
      const [owner] = await ethers.getSigners();

      const airdropPayer = await connection.requestAirdrop(payer.publicKey, web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropPayer, "finalized");
      const airdropPrimary = await connection.requestAirdrop(
        primary.publicKey,
        web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(airdropPrimary, "finalized");
      const airdropRecipient = await connection.requestAirdrop(
        recipient.publicKey,
        web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(airdropRecipient, "finalized");

      const rent = await connection.getMinimumBalanceForRentExemption(web3.NONCE_ACCOUNT_LENGTH);
      const latest = await connection.getLatestBlockhash("finalized");
      const initTx = new web3.Transaction({
        feePayer: payer.publicKey,
        recentBlockhash: latest.blockhash,
      }).add(
        web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: nonceAccount.publicKey,
          lamports: rent,
          space: web3.NONCE_ACCOUNT_LENGTH,
          programId: web3.SystemProgram.programId,
        }),
        web3.SystemProgram.nonceInitialize({
          noncePubkey: nonceAccount.publicKey,
          authorizedPubkey: primary.publicKey,
        }),
      );
      initTx.sign(payer, nonceAccount);
      const initSig = await connection.sendRawTransaction(initTx.serialize());
      await waitForFinalized(connection, initSig);

      const nonceInfo = await connection.getNonce(nonceAccount.publicKey, "finalized");
      if (nonceInfo === null) {
        throw new Error("failed to fetch nonce account");
      }

      const memoProgram = new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
      const memoData = memoAddressData(owner.address);
      const messageV0 = new web3.TransactionMessage({
        payerKey: primary.publicKey,
        recentBlockhash: nonceInfo.nonce,
        instructions: [
          web3.SystemProgram.nonceAdvance({
            noncePubkey: nonceAccount.publicKey,
            authorizedPubkey: primary.publicKey,
          }),
          web3.SystemProgram.transfer({
            fromPubkey: primary.publicKey,
            toPubkey: recipient.publicKey,
            lamports: 25_000,
          }),
          new web3.TransactionInstruction({ programId: memoProgram, keys: [], data: memoData }),
        ],
      }).compileToV0Message();
      const tx = new web3.VersionedTransaction(messageV0);
      tx.sign([primary]);
      const rawTx = ethers.hexlify(tx.serialize());

      const oracle = await deploySolanaOracle();
      await oracle.setDurableNonce(
        pubkeyBytes(primary.publicKey),
        pubkeyBytes(nonceAccount.publicKey),
        ethers.hexlify(bs58.decode(nonceInfo.nonce)),
      );

      expect(
        await oracle.isValidForEpoch(rawTx, pubkeyBytes(primary.publicKey), 0, owner.address),
      ).to.equal(true);
      const signature = await connection.sendRawTransaction(tx.serialize());
      await waitForFinalized(connection, signature);
      await oracle.submitFinalizedTransactionBytes(rawTx, []);
      const decoded = await oracle.decodeWithdrawal(
        rawTx,
        pubkeyBytes(primary.publicKey),
        ethers.hexlify(bs58.decode(nonceInfo.nonce)),
      );
      expect(decoded.spender).to.equal(owner.address);
      // amountSpent = 25_000 transfer + 1 * 5_000 lamports-per-signature base fee.
      expect(decoded.amountSpent).to.equal(25_000n + 5_000n);
    },
  );
});
