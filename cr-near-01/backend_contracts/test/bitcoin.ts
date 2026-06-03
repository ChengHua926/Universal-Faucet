import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers as ethersPkg } from "ethers";
import { network } from "hardhat";

import {
  BitcoinRpc,
  accountId,
  bip143P2wpkhPreimage,
  concat,
  dsha,
  encodeBitcoinProof,
  findP2wpkhOutput,
  hash160,
  input as txInput,
  le32,
  makeTrivialProof,
  reverseHex,
  mineTxProof,
  opReturnAddress,
  output,
  p2wpkh,
  push,
  sendDepositTx,
  unsignedWitnessPolicyTx,
  varInt,
  witnessTx,
  withdrawalOutputs,
} from "../scripts/bitcoin/tx-helpers.js";
import { createSigningCommittee, MockSigningCommittee } from "../scripts/signing-committee.js";

const { ethers } = await network.connect();

function fakeInput(sequence = 0xffffffff): string {
  return concat(["0x" + "11".repeat(32), le32(0), push("0x"), le32(sequence)]);
}

function syntheticDepositTx(sender: string, encHash: string, amount: bigint): string {
  return concat([
    le32(2),
    varInt(1),
    fakeInput(),
    varInt(2),
    output(0n, opReturnAddress(sender)),
    output(amount, p2wpkh(encHash)),
    le32(0),
  ]);
}

function syntheticWithdrawalTx(
  spender: string,
  encPubkey: string,
  recipientHash: string,
  amount: bigint,
  change: bigint,
  prevTxid: string,
  prevVout: number,
): string {
  const encHash = hash160(encPubkey);
  return concat([
    le32(2),
    "0x0001",
    varInt(1),
    txInput(prevTxid, prevVout),
    varInt(3),
    output(0n, opReturnAddress(spender)),
    output(change, p2wpkh(encHash)),
    output(amount, p2wpkh(recipientHash)),
    varInt(2),
    push(
      "0x3044022001010101010101010101010101010101010101010101010101010101010101010220010101010101010101010101010101010101010101010101010101010101010101",
    ),
    push(encPubkey),
    le32(0),
  ]);
}

async function setupBitcoinRegtestWallet(rpcUrl: string): Promise<BitcoinRpc> {
  const root = new BitcoinRpc(rpcUrl);
  try {
    await root.call("createwallet", ["crossroads"]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("Database already exists")) {
      throw err;
    }
  }
  const wallet = root.wallet("crossroads");
  const address = await wallet.call<string>("getnewaddress", ["", "bech32"]);
  const blocks = await wallet.call<number>("getblockcount");
  if (blocks < 101) {
    await wallet.call("generatetoaddress", [101 - blocks, address]);
  }
  return wallet;
}

describe("Crossroads Bitcoin tests", function () {
  async function deployStack() {
    const [owner, prover] = await ethers.getSigners();
    const BlockHashOracle = await ethers.getContractFactory("TrivialBitcoinBlockHashOracle");
    const blockHashOracle = await BlockHashOracle.deploy();
    await blockHashOracle.waitForDeployment();

    const BridgeOracle = await ethers.getContractFactory("BitcoinBridgeOracle");
    const bridgeOracle = await BridgeOracle.deploy(blockHashOracle);
    await bridgeOracle.waitForDeployment();

    const Asset = await ethers.getContractFactory("CrossroadsAssetContract");
    const asset = await Asset.deploy("Crossroads Wrapped BTC", "cWBTC", bridgeOracle, 1, 1000);
    await asset.waitForDeployment();

    let nextBlockHeight = 100;
    const prepareProof = async (rawTx: string): Promise<{ proof: string; txid: string }> => {
      const height = nextBlockHeight++;
      const { proof, blockHash, txid } = makeTrivialProof(rawTx, height);
      await (blockHashOracle as any).setBlockHash(height, blockHash);
      return { proof, txid };
    };

    return { owner, prover, blockHashOracle, bridgeOracle, asset, prepareProof };
  }

  it("processes P2WPKH Bitcoin deposits with an inclusion proof", async () => {
    const { owner, asset, prepareProof } = await deployStack();
    const encHash = "0x" + "22".repeat(20);
    const encAccount = accountId(encHash);
    const rawTx = syntheticDepositTx(owner.address, encHash, 50_000n);
    const { proof, txid } = await prepareProof(rawTx);

    await asset.registerEncumberedAccount(encAccount);
    // Initial deposit burns 546 sats (UTXO dust-safety marker); user is minted (deposit − 546) cWBTC.
    await expect(asset.deposit(rawTx, proof))
      .to.emit(asset, "DepositProcessed")
      .withArgs(owner.address, encAccount, 49_454n, txid);
    expect(await asset.balanceOf(owner.address)).to.equal(49_454n);
  });

  it("authorizes and finalizes P2WPKH Bitcoin withdrawals", async () => {
    const { owner, prover, asset, prepareProof } = await deployStack();
    const encWallet = ethersPkg.Wallet.createRandom();
    const encPubkey = ethers.SigningKey.computePublicKey(encWallet.privateKey, true);
    const encHash = hash160(encPubkey);
    const encAccount = accountId(encHash);
    const recipientHash = "0x" + "33".repeat(20);
    const rawDeposit = syntheticDepositTx(owner.address, encHash, 100_000n);
    const depositTxId = reverseHex(dsha(rawDeposit));
    const rawWithdrawal = syntheticWithdrawalTx(
      owner.address,
      encPubkey,
      recipientHash,
      60_000n,
      39_500n,
      depositTxId,
      1,
    );

    const { proof: depositProof } = await prepareProof(rawDeposit);
    const { proof: withdrawProof } = await prepareProof(rawWithdrawal);

    await asset.registerEncumberedAccount(encAccount);
    await asset.deposit(rawDeposit, depositProof);
    await asset.lockWithdrawal(80_000n, encAccount, { value: 1000 });

    expect(await asset.canSign(owner.address, encAccount, rawWithdrawal)).to.equal(true);

    // Encumbered UTXO had 100k sats; change is 39_500 so amountSpent (input − change)
    // is 60_500 — the 500-sat miner fee is paid out of the encumbered pool.
    await expect(asset.connect(prover).finalizeWithdrawal(rawWithdrawal, withdrawProof, encAccount))
      .to.emit(asset, "WithdrawalFinalized")
      .withArgs(owner.address, encAccount, 60_500n, 1000n, anyValue);
    // The Bitcoin oracle's `getWithdrawalEpoch` returns `currentEpoch + 1`, and
    // by the time the asset reads it, `verifyWithdrawal` has already advanced
    // oracle.currentEpoch from 0 to 1. So the asset persists 2.
    // Initial deposit advances the epoch 0→1; withdrawal advances 1→2.
    expect(await asset.accountEpoch(encAccount)).to.equal(2n);
  });

  it("uses btc-sha256 DER signatures from the signing committee helper", async () => {
    const previousKind = process.env.ECDSA_SIGNATURE_KIND;
    process.env.ECDSA_SIGNATURE_KIND = "btc-sha256";
    try {
      const { owner, asset, prepareProof } = await deployStack();
      const committee = new MockSigningCommittee(asset as any);
      const encPubkey = committee.getPublicKey()!;
      const encHash = hash160(encPubkey);
      const encAccount = accountId(encHash);
      const recipientHash = "0x" + "44".repeat(20);
      const rawDeposit = syntheticDepositTx(owner.address, encHash, 100_000n);
      const depositTxId = reverseHex(dsha(rawDeposit));
      const rawWithdrawal = syntheticWithdrawalTx(
        owner.address,
        encPubkey,
        recipientHash,
        25_000n,
        74_500n,
        depositTxId,
        1,
      );
      const { proof: depositProof } = await prepareProof(rawDeposit);

      expect(committee.getEncAddressId()).to.equal(encAccount);
      await committee.registerEncumberedAccount();
      await asset.deposit(rawDeposit, depositProof);
      await asset.lockWithdrawal(30_000n, encAccount, { value: 1000 });

      const signed = await committee.signRawMessage(rawWithdrawal, owner);
      const der = ethers.getBytes(signed.signature);
      expect(signed.signatureKind).to.equal("btc-sha256");
      expect(signed.signature).to.match(/^0x30/);
      expect(der[1]).to.equal(der.length - 2);
      expect(signed.publicKey).to.equal(encPubkey);
    } finally {
      if (previousKind === undefined) {
        delete process.env.ECDSA_SIGNATURE_KIND;
      } else {
        process.env.ECDSA_SIGNATURE_KIND = previousKind;
      }
    }
  });

  it("rejects a subsequent deposit that does not consume the current Crossroads UTXO", async () => {
    const { owner, asset, prepareProof } = await deployStack();
    const encHash = "0x" + "66".repeat(20);
    const encAccount = accountId(encHash);
    await asset.registerEncumberedAccount(encAccount);

    const firstDeposit = syntheticDepositTx(owner.address, encHash, 50_000n);
    const { proof: firstProof } = await prepareProof(firstDeposit);
    await asset.deposit(firstDeposit, firstProof);

    // A second standalone tx (using fakeInput) doesn't consume the prior UTXO.
    // It's therefore treated as an "initial" deposit, but the slot is already taken.
    const orphanDeposit = syntheticDepositTx(owner.address, encHash, 80_000n);
    const { proof: orphanProof } = await prepareProof(orphanDeposit);
    await expect(asset.deposit(orphanDeposit, orphanProof)).to.be.revertedWith(
      "Initial deposit requires no existing Crossroads UTXO",
    );
  });

  it("rejects a subsequent deposit that does not strictly increase the UTXO value", async () => {
    const { owner, asset, prepareProof } = await deployStack();
    const encHash = "0x" + "77".repeat(20);
    const encAccount = accountId(encHash);
    await asset.registerEncumberedAccount(encAccount);

    const firstDeposit = syntheticDepositTx(owner.address, encHash, 50_000n);
    const { proof: firstProof } = await prepareProof(firstDeposit);
    await asset.deposit(firstDeposit, firstProof);
    const firstTxId = reverseHex(dsha(firstDeposit));

    // Properly consumes the prior UTXO but uses equal value (no net deposit).
    const sameValue = concat([
      le32(2),
      varInt(1),
      txInput(firstTxId, 1),
      varInt(2),
      output(0n, opReturnAddress(owner.address)),
      output(50_000n, p2wpkh(encHash)),
      le32(0),
    ]);
    const { proof: sameValueProof } = await prepareProof(sameValue);
    await expect(asset.deposit(sameValue, sameValueProof)).to.be.revertedWith(
      "Subsequent deposit must increase Crossroads UTXO value",
    );
  });

  it("chains a subsequent deposit and mints only the value delta", async () => {
    const { owner, asset, prepareProof } = await deployStack();
    const encHash = "0x" + "88".repeat(20);
    const encAccount = accountId(encHash);
    await asset.registerEncumberedAccount(encAccount);

    const firstDeposit = syntheticDepositTx(owner.address, encHash, 50_000n);
    const { proof: firstProof } = await prepareProof(firstDeposit);
    await asset.deposit(firstDeposit, firstProof);
    const firstTxId = reverseHex(dsha(firstDeposit));
    // Initial deposit burns 546 sats (permanently reserved in the UTXO marker, above P2WPKH dust).
    expect(await asset.balanceOf(owner.address)).to.equal(49_454n);

    const chained = concat([
      le32(2),
      varInt(1),
      txInput(firstTxId, 1),
      varInt(2),
      output(0n, opReturnAddress(owner.address)),
      output(80_000n, p2wpkh(encHash)),
      le32(0),
    ]);
    const { proof: chainedProof, txid: chainedTxId } = await prepareProof(chained);
    // Subsequent deposits mint the full delta (no further burn).
    await expect(asset.deposit(chained, chainedProof))
      .to.emit(asset, "DepositProcessed")
      .withArgs(owner.address, encAccount, 30_000n, chainedTxId);
    expect(await asset.balanceOf(owner.address)).to.equal(79_454n);
  });

  it("canSign rejects a fragmented withdrawal but finalizeWithdrawal still follows Bitcoin if one mines", async () => {
    const { owner, prover, asset, bridgeOracle, prepareProof } = await deployStack();
    const encWallet = ethersPkg.Wallet.createRandom();
    const encPubkey = ethers.SigningKey.computePublicKey(encWallet.privateKey, true);
    const encHash = hash160(encPubkey);
    const encAccount = accountId(encHash);
    await asset.registerEncumberedAccount(encAccount);

    const rawDeposit = syntheticDepositTx(owner.address, encHash, 100_000n);
    const { proof: depositProof } = await prepareProof(rawDeposit);
    await asset.deposit(rawDeposit, depositProof);
    await asset.lockWithdrawal(80_000n, encAccount, { value: 1000 });
    const depositTxId = reverseHex(dsha(rawDeposit));

    // Two P2WPKH outputs back to the encumbered address.
    const fragmented = concat([
      le32(2),
      "0x0001",
      varInt(1),
      txInput(depositTxId, 1),
      varInt(3),
      output(0n, opReturnAddress(owner.address)),
      output(20_000n, p2wpkh(encHash)),
      output(19_500n, p2wpkh(encHash)),
      varInt(2),
      push(
        "0x3044022001010101010101010101010101010101010101010101010101010101010101010220010101010101010101010101010101010101010101010101010101010101010101",
      ),
      push(encPubkey),
      le32(0),
    ]);
    // canSign must refuse so the committee never signs a fragmenting withdrawal.
    expect(await asset.canSign(owner.address, encAccount, fragmented)).to.equal(false);

    // But if such a tx somehow gets signed and mined, finalize must accept it
    // (otherwise the bridge is permanently frozen for this encAccount).
    // amountSpent = cur.value − sum(fragments) = 100k − 39_500 = 60_500.
    const { proof: fragmentedProof } = await prepareProof(fragmented);
    await expect(
      asset.connect(prover).finalizeWithdrawal(fragmented, fragmentedProof, encAccount),
    )
      .to.emit(asset, "WithdrawalFinalized")
      .withArgs(owner.address, encAccount, 60_500n, 1000n, anyValue);
    // Bridge clears its canonical UTXO; the fragments are now unreachable but
    // the encAccount is free to start over with a fresh initial deposit.
    const epoch = await (bridgeOracle as any).currentEpoch(encAccount);
    const cur = await (bridgeOracle as any).crossroadsUtxoByEpoch(encAccount, epoch);
    expect(cur.value).to.equal(0n);
  });

  it("canSign rejects a multi-input withdrawal but finalizeWithdrawal still follows Bitcoin if one mines", async () => {
    const { owner, prover, asset, bridgeOracle, prepareProof } = await deployStack();
    const encWallet = ethersPkg.Wallet.createRandom();
    const encPubkey = ethers.SigningKey.computePublicKey(encWallet.privateKey, true);
    const encHash = hash160(encPubkey);
    const encAccount = accountId(encHash);
    await asset.registerEncumberedAccount(encAccount);

    const rawDeposit = syntheticDepositTx(owner.address, encHash, 100_000n);
    const { proof: depositProof } = await prepareProof(rawDeposit);
    await asset.deposit(rawDeposit, depositProof);
    await asset.lockWithdrawal(80_000n, encAccount, { value: 1000 });
    const depositTxId = reverseHex(dsha(rawDeposit));

    // Tx that consumes the Crossroads UTXO PLUS an external UTXO and routes the
    // padded change back to the encumbered address.
    const recipientHash = "0x" + "99".repeat(20);
    const fakePrevTxid = "0x" + "ab".repeat(32);
    const multiInput = concat([
      le32(2),
      "0x0001",
      varInt(2),
      txInput(depositTxId, 1),
      txInput(fakePrevTxid, 0),
      varInt(3),
      output(0n, opReturnAddress(owner.address)),
      output(99_500n, p2wpkh(encHash)),
      output(50_000n, p2wpkh(recipientHash)),
      varInt(2),
      push(
        "0x3044022001010101010101010101010101010101010101010101010101010101010101010220010101010101010101010101010101010101010101010101010101010101010101",
      ),
      push(encPubkey),
      varInt(0),
      le32(0),
    ]);
    // canSign refuses (committee never signs multi-input withdrawals).
    expect(await asset.canSign(owner.address, encAccount, multiInput)).to.equal(false);

    // But finalize processes it gracefully: change (99_500) is capped at the
    // consumed UTXO value (100_000) so amountSpent = 100_000 − 99_500 = 500.
    // The bridge accepts the new Crossroads UTXO at the (single) change output.
    const { proof: multiProof } = await prepareProof(multiInput);
    await expect(
      asset.connect(prover).finalizeWithdrawal(multiInput, multiProof, encAccount),
    )
      .to.emit(asset, "WithdrawalFinalized")
      .withArgs(owner.address, encAccount, 500n, 1000n, anyValue);
    const epoch = await (bridgeOracle as any).currentEpoch(encAccount);
    const cur = await (bridgeOracle as any).crossroadsUtxoByEpoch(encAccount, epoch);
    expect(cur.value).to.equal(99_500n);
  });

  it("canSign refuses non-RBF withdrawals but finalizeWithdrawal still follows Bitcoin if one mines", async () => {
    const { owner, prover, asset, prepareProof } = await deployStack();
    const encWallet = ethersPkg.Wallet.createRandom();
    const encPubkey = ethers.SigningKey.computePublicKey(encWallet.privateKey, true);
    const encHash = hash160(encPubkey);
    const encAccount = accountId(encHash);
    const recipientHash = "0x" + "dd".repeat(20);

    const rawDeposit = syntheticDepositTx(owner.address, encHash, 100_000n);
    const { proof: depositProof } = await prepareProof(rawDeposit);
    const depositTxId = reverseHex(dsha(rawDeposit));

    await asset.registerEncumberedAccount(encAccount);
    await asset.deposit(rawDeposit, depositProof);
    await asset.lockWithdrawal(80_000n, encAccount, { value: 1000 });

    // Hand-rolled withdrawal that uses sequence 0xffffffff (final, non-RBF).
    const nonRbfSequence = 0xffffffff;
    const nonRbfWithdrawal = concat([
      le32(2),
      "0x0001",
      varInt(1),
      txInput(depositTxId, 1, nonRbfSequence),
      varInt(3),
      output(0n, opReturnAddress(owner.address)),
      output(39_500n, p2wpkh(encHash)),
      output(60_000n, p2wpkh(recipientHash)),
      varInt(2),
      push(
        "0x3044022001010101010101010101010101010101010101010101010101010101010101010220010101010101010101010101010101010101010101010101010101010101010101",
      ),
      push(encPubkey),
      le32(0),
    ]);

    // canSign refuses so the committee never signs non-RBF in the first place.
    expect(await asset.canSign(owner.address, encAccount, nonRbfWithdrawal)).to.equal(false);

    // But once such a tx is on Bitcoin, RBF no longer matters; finalize accepts it.
    const { proof: withdrawProof } = await prepareProof(nonRbfWithdrawal);
    await expect(
      asset.connect(prover).finalizeWithdrawal(nonRbfWithdrawal, withdrawProof, encAccount),
    )
      .to.emit(asset, "WithdrawalFinalized")
      .withArgs(owner.address, encAccount, 60_500n, 1000n, anyValue);
  });

  it("canSign rejects a full-drain withdrawal; finalize emits inconsistency rather than freezing", async () => {
    const { owner, prover, asset, bridgeOracle, prepareProof } = await deployStack();
    const encWallet = ethersPkg.Wallet.createRandom();
    const encPubkey = ethers.SigningKey.computePublicKey(encWallet.privateKey, true);
    const encHash = hash160(encPubkey);
    const encAccount = accountId(encHash);
    const recipientHash = "0x" + "ee".repeat(20);
    const rawDeposit = syntheticDepositTx(owner.address, encHash, 100_000n);
    const depositTxId = reverseHex(dsha(rawDeposit));
    // Try to fully drain the encumbered UTXO. The user's max spending balance
    // is 99_454 (since 546 sats are burned on initial deposit), but the tx asks
    // for the full 100_000 — canSign should refuse.
    const rawWithdrawal = syntheticWithdrawalTx(
      owner.address,
      encPubkey,
      recipientHash,
      99_500n,
      0n, // change = 0 → no encumbered output, attempted full drain
      depositTxId,
      1,
    );
    const { proof: depositProof } = await prepareProof(rawDeposit);
    const { proof: withdrawProof } = await prepareProof(rawWithdrawal);

    await asset.registerEncumberedAccount(encAccount);
    await asset.deposit(rawDeposit, depositProof);
    // Lock all the cWBTC the user actually owns (100k deposit − 546 sat burn).
    await asset.lockWithdrawal(99_454n, encAccount, { value: 1000 });

    // canSign refuses: cost (100k) > spendingBalance (99_454).
    expect(await asset.canSign(owner.address, encAccount, rawWithdrawal)).to.equal(false);

    // If such a tx somehow gets signed and mined, finalize still succeeds:
    // the asset emits WithdrawalInconsistency and charges min(balance, amountSpent)
    // rather than reverting, so funds are never frozen.
    await expect(asset.connect(prover).finalizeWithdrawal(rawWithdrawal, withdrawProof, encAccount))
      .to.emit(asset, "WithdrawalInconsistency")
      .withArgs(owner.address, encAccount, anyValue, 99_454n, 100_000n)
      .and.to.emit(asset, "WithdrawalFinalized")
      .withArgs(owner.address, encAccount, 100_000n, 1000n, anyValue);
    const epoch = await (bridgeOracle as any).currentEpoch(encAccount);
    const cur = await (bridgeOracle as any).crossroadsUtxoByEpoch(encAccount, epoch);
    expect(cur.value).to.equal(0n);
  });

  it("credits a second depositor (not the encAccount opener) for a consolidation deposit", async () => {
    const { owner, asset, bridgeOracle, prepareProof } = await deployStack();
    // owner does the initial deposit, opening the encumbered account.
    const encHash = "0x" + "be".repeat(20);
    const encAccount = accountId(encHash);
    await asset.registerEncumberedAccount(encAccount);
    const initial = syntheticDepositTx(owner.address, encHash, 100_000n);
    const initialTxId = reverseHex(dsha(initial));
    const { proof: initialProof } = await prepareProof(initial);
    await asset.deposit(initial, initialProof);
    // Initial deposit burns 546 sats; owner has (newValue − 546) cWBTC.
    expect(await asset.balanceOf(owner.address)).to.equal(99_454n);

    // A different account comes along, wants to consolidate their own funds
    // into the same encumbered account. They have NO spending balance and
    // never paid the withdrawal-proof subsidy. Use a fresh random address —
    // the test doesn't need them to sign anything on the EVM side.
    const otherDepositor = ethersPkg.Wallet.createRandom();
    expect(otherDepositor.address).to.not.equal(owner.address);
    expect(await asset.balanceOf(otherDepositor.address)).to.equal(0n);
    expect(await asset.spendingBalance(otherDepositor.address, encAccount)).to.equal(0n);
    expect(await asset.withdrawalProofSubsidy(otherDepositor.address)).to.equal(0n);

    // They construct a consolidation deposit: consume the current Crossroads
    // UTXO + their own (fake) input, produce a strictly-larger encumbered
    // output, OP_RETURN binds the credit to *their* Crossroads address.
    const otherDepositorFakePrev = "0x" + "be".repeat(32);
    const consolidation = concat([
      le32(2),
      varInt(2),
      txInput(otherDepositorFakePrev, 0),
      txInput(initialTxId, 1),
      varInt(2),
      output(0n, opReturnAddress(otherDepositor.address)),
      output(170_000n, p2wpkh(encHash)),
      le32(0),
    ]);
    expect(
      await asset.canSign(otherDepositor.address, encAccount, consolidation),
    ).to.equal(true);

    // When the committee-signed tx mines, asset.deposit credits the OP_RETURN
    // address with the net delta (170k − 100k = 70k). The original opener's
    // balance is untouched; the new encumbered UTXO is at the next epoch.
    const { proof: consolidationProof, txid: consolidationTxId } =
      await prepareProof(consolidation);
    await expect(asset.deposit(consolidation, consolidationProof))
      .to.emit(asset, "DepositProcessed")
      .withArgs(otherDepositor.address, encAccount, 70_000n, consolidationTxId);
    expect(await asset.balanceOf(owner.address)).to.equal(99_454n);
    expect(await asset.balanceOf(otherDepositor.address)).to.equal(70_000n);
    expect(await asset.accountEpoch(encAccount)).to.equal(2n);
    const cur = await (bridgeOracle as any).crossroadsUtxoByEpoch(
      encAccount,
      await (bridgeOracle as any).currentEpoch(encAccount),
    );
    expect(cur.value).to.equal(170_000n);
  });

  it("permits anyone to request a signature for a consolidation deposit regardless of spending balance", async () => {
    const { owner, asset, prepareProof } = await deployStack();
    const encHash = "0x" + "ab".repeat(20);
    const encAccount = accountId(encHash);
    await asset.registerEncumberedAccount(encAccount);

    // Initial deposit establishes the first Crossroads UTXO at value 100_000.
    const initial = syntheticDepositTx(owner.address, encHash, 100_000n);
    const initialTxId = reverseHex(dsha(initial));
    const { proof: initialProof } = await prepareProof(initial);
    await asset.deposit(initial, initialProof);

    // A second depositor (no spending balance, no subsidy) constructs a
    // consolidation deposit: spends the current Crossroads UTXO + their own
    // input, producing a strictly-larger encumbered output. OP_RETURN binds
    // their Crossroads address — they'll be credited the net delta.
    const externalDepositor = ethersPkg.Wallet.createRandom();
    const fakeOwnPrevTxid = "0x" + "cd".repeat(32);
    const consolidation = concat([
      le32(2),
      varInt(2),
      txInput(fakeOwnPrevTxid, 0),
      txInput(initialTxId, 1),
      varInt(2),
      output(0n, opReturnAddress(externalDepositor.address)),
      output(200_000n, p2wpkh(encHash)),
      le32(0),
    ]);

    // canSign returns true: getTransactionCostForAccount sees newValue > cur.value
    // and reports cost = 0, so the asset doesn't gate on spendingBalance or
    // subsidy. isValidForEpoch's deposit branch accepts the multi-input shape.
    expect(
      await asset.canSign(externalDepositor.address, encAccount, consolidation),
    ).to.equal(true);
    // Sanity: a withdrawal-shaped request from the same zero-balance depositor
    // is still rejected (it would actually drain the encumbered pool).
    const recipientHash = "0x" + "ef".repeat(20);
    const drainAttempt = concat([
      le32(2),
      varInt(1),
      txInput(initialTxId, 1),
      varInt(3),
      output(0n, opReturnAddress(externalDepositor.address)),
      output(50_000n, p2wpkh(encHash)),
      output(49_000n, p2wpkh(recipientHash)),
      le32(0),
    ]);
    expect(
      await asset.canSign(externalDepositor.address, encAccount, drainAttempt),
    ).to.equal(false);
  });

  it("rejects re-submitting the same transaction as both a deposit and a withdrawal", async () => {
    const { owner, prover, asset, prepareProof } = await deployStack();
    const encHash = "0x" + "aa".repeat(20);
    const encAccount = accountId(encHash);
    await asset.registerEncumberedAccount(encAccount);

    const rawDeposit = syntheticDepositTx(owner.address, encHash, 50_000n);
    const { proof: depositProof } = await prepareProof(rawDeposit);
    await asset.deposit(rawDeposit, depositProof);

    // Try to feed the same bytes to finalizeWithdrawal. The shared
    // processedTransaction map in the oracle should reject it as already
    // processed regardless of the asset's own per-role processed maps.
    await expect(
      asset.connect(prover).finalizeWithdrawal(rawDeposit, depositProof, encAccount),
    ).to.be.revertedWith("Transaction already processed");
  });

  it("handles a chained deposit even if the wallet change output precedes the encumbered output", async () => {
    const { owner, asset, prepareProof } = await deployStack();
    const encHash = "0x" + "bb".repeat(20);
    const encAccount = accountId(encHash);
    const walletChangeHash = "0x" + "cc".repeat(20);
    await asset.registerEncumberedAccount(encAccount);

    const firstDeposit = syntheticDepositTx(owner.address, encHash, 50_000n);
    const { proof: firstProof } = await prepareProof(firstDeposit);
    await asset.deposit(firstDeposit, firstProof);
    const firstTxId = reverseHex(dsha(firstDeposit));

    // Layout intentionally puts the wallet change BEFORE the encumbered output.
    // Pre-fix this would have misidentified the destination as the wallet change hash.
    const chained = concat([
      le32(2),
      varInt(1),
      txInput(firstTxId, 1),
      varInt(3),
      output(0n, opReturnAddress(owner.address)),
      output(10_000n, p2wpkh(walletChangeHash)),
      output(80_000n, p2wpkh(encHash)),
      le32(0),
    ]);
    const { proof: chainedProof, txid: chainedTxId } = await prepareProof(chained);
    await expect(asset.deposit(chained, chainedProof))
      .to.emit(asset, "DepositProcessed")
      .withArgs(owner.address, encAccount, 30_000n, chainedTxId);
    // Balance reflects the 546-sat burn from the initial deposit; subsequent
    // deposits mint the full delta on top.
    expect(await asset.balanceOf(owner.address)).to.equal(79_454n);
  });

  const maybeRegtest = process.env.BITCOIN_RPC_URL === undefined ? it.skip : it;
  maybeRegtest("processes real Bitcoin regtest deposits and withdrawals", async function () {
    this.timeout(120_000);
    const previousKind = process.env.ECDSA_SIGNATURE_KIND;
    process.env.ECDSA_SIGNATURE_KIND = "btc-sha256";
    const committeeWasReal = process.env.SIGNING_COMMITTEE === "real";
    const committeeNeedsSetup = committeeWasReal;
    let committee: ReturnType<typeof createSigningCommittee> | undefined;
    try {
      const wallet = await setupBitcoinRegtestWallet(process.env.BITCOIN_RPC_URL!);
      const { owner, prover, blockHashOracle, asset } = await deployStack();
      committee = createSigningCommittee(asset as any, owner);
      if (committeeNeedsSetup) {
        await committee.setup();
      }
      const encPubkey = committee.getPublicKey()!;
      const encHash = hash160(encPubkey);
      const encAccount = accountId(encHash);
      expect(committee.getEncAddressId()).to.equal(encAccount);
      await committee.registerEncumberedAccount();

      const deposit = await sendDepositTx(
        wallet,
        owner.address,
        encHash,
        "0.00100000",
        "regtest",
      );
      const depositProof = await mineTxProof(wallet, deposit.txid);
      await blockHashOracle.setBlockHash(depositProof.height, dsha(depositProof.header));
      await expect(
        asset.deposit(
          deposit.rawTx,
          encodeBitcoinProof(
            depositProof.height,
            depositProof.header,
            depositProof.proof,
            depositProof.txIndex,
          ),
        ),
      )
        .to.emit(asset, "DepositProcessed")
        .withArgs(owner.address, encAccount, 99_454n, anyValue);

      await asset.lockWithdrawal(80_000n, encAccount, { value: 1000 });
      const utxo = await findP2wpkhOutput(wallet, deposit.rawTx, encHash);
      const recipientHash = "0x" + "55".repeat(20);
      const spendAmount = 25_000n;
      const fee = 500n;
      const change = utxo.value - spendAmount - fee;
      const outputs = withdrawalOutputs(owner.address, encHash, recipientHash, spendAmount, change);
      const preimage = bip143P2wpkhPreimage(
        deposit.txid,
        utxo.vout,
        utxo.value,
        encHash,
        outputs,
      );
      const policyTx = unsignedWitnessPolicyTx(
        deposit.txid,
        utxo.vout,
        owner.address,
        encPubkey,
        recipientHash,
        spendAmount,
        change,
      );
      expect(await (asset as any).canSign(owner.address, encAccount, policyTx)).to.equal(true);

      const sighashMidstate = ethers.sha256(preimage);
      const signed = await committee.signRawMessage(sighashMidstate, owner, policyTx);
      expect(signed.signatureKind).to.equal("btc-sha256");
      const signedTx = witnessTx(
        deposit.txid,
        utxo.vout,
        owner.address,
        encPubkey,
        recipientHash,
        spendAmount,
        change,
        ethers.concat([signed.signature, "0x01"]),
      );
      const withdrawTxid = await wallet.call<string>("sendrawtransaction", [signedTx.slice(2)]);
      const withdrawProof = await mineTxProof(wallet, withdrawTxid);
      await blockHashOracle.setBlockHash(withdrawProof.height, dsha(withdrawProof.header));

      await expect(
        asset
          .connect(prover)
          .finalizeWithdrawal(
            signedTx,
            encodeBitcoinProof(
              withdrawProof.height,
              withdrawProof.header,
              withdrawProof.proof,
              withdrawProof.txIndex,
            ),
            encAccount,
          ),
      )
        .to.emit(asset, "WithdrawalFinalized")
        .withArgs(owner.address, encAccount, spendAmount + fee, 1000n, anyValue);
      // Initial deposit advances the epoch 0→1; withdrawal advances 1→2.
    expect(await asset.accountEpoch(encAccount)).to.equal(2n);
    } finally {
      if (committee !== undefined && committeeNeedsSetup) {
        await committee.shutdown();
      }
      if (previousKind === undefined) {
        delete process.env.ECDSA_SIGNATURE_KIND;
      } else {
        process.env.ECDSA_SIGNATURE_KIND = previousKind;
      }
    }
  });
});
