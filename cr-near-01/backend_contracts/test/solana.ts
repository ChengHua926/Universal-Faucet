import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers as ethersPkg } from "ethers";
import { network } from "hardhat";

const { ethers } = await network.connect();

function hex(bytes: number[] | Uint8Array): string {
  return ethers.hexlify(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
}

function concat(parts: string[]): string {
  return ethers.concat(parts);
}

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
  return hex(out);
}

function u32le(value: number): string {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return hex(out);
}

function u64le(value: bigint): string {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return hex(out);
}

function pk(byte: number): string {
  return "0x" + byte.toString(16).padStart(2, "0").repeat(32);
}

const SYSTEM_PROGRAM_ID = pk(0);
const MEMO_PROGRAM_ID = "0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d";
const SYSVAR_RECENT_BLOCKHASHES_ID =
  "0x06a7d517192c568ee08a845f73d29788cf035c3145b21ab344d8062ea9400000";
const SYSVAR_RENT_ID = "0x06a7d517192c5c51218cc94c3d4af17f58daee089ba1fd44e3dbd98a00000000";
const COMPUTE_BUDGET_PROGRAM_ID =
  "0x0306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000";

function cbSetComputeUnitLimitData(units: number): string {
  return concat([hex([0x02]), u32le(units)]);
}

function cbSetComputeUnitPriceData(microLamports: bigint): string {
  return concat([hex([0x03]), u64le(microLamports)]);
}

function ix(programIdIndex: number, accounts: number[], data: string): string {
  return concat([
    hex([programIdIndex]),
    shortvec(accounts.length),
    hex(accounts),
    shortvec(ethers.getBytes(data).length),
    data,
  ]);
}

function v0Message(opts: {
  numRequiredSignatures: number;
  numReadonlySignedAccounts?: number;
  numReadonlyUnsignedAccounts: number;
  accountKeys: string[];
  recentBlockhash: string;
  instructions: string[];
  lookups?: string[];
}): string {
  return concat([
    "0x80",
    hex([
      opts.numRequiredSignatures,
      opts.numReadonlySignedAccounts ?? 0,
      opts.numReadonlyUnsignedAccounts,
    ]),
    shortvec(opts.accountKeys.length),
    ...opts.accountKeys,
    opts.recentBlockhash,
    shortvec(opts.instructions.length),
    ...opts.instructions,
    shortvec(opts.lookups?.length ?? 0),
    ...(opts.lookups ?? []),
  ]);
}

function signV0(message: string, count = 1, seed = 0xa0): string {
  const signatures = Array.from(
    { length: count },
    (_, i) => "0x" + ((seed + i) & 0xff).toString(16).padStart(2, "0").repeat(64),
  );
  return concat([shortvec(count), ...signatures, message]);
}

function primarySig(signedTx: string): string {
  return ethers.hexlify(ethers.getBytes(signedTx).slice(1, 65));
}

function solanaProof(signedTx: string): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [primarySig(signedTx)]);
}

function transferData(lamports: bigint): string {
  return concat([u32le(2), u64le(lamports)]);
}

function memoAddressData(account: string): string {
  return ethers.hexlify(ethers.toUtf8Bytes(account.slice(2).toLowerCase()));
}

function advanceNonceData(): string {
  return u32le(4);
}

function createAccountData(lamports: bigint, space: bigint, owner = SYSTEM_PROGRAM_ID): string {
  return concat([u32le(0), u64le(lamports), u64le(space), owner]);
}

function initializeNonceData(authority: string): string {
  return concat([u32le(6), authority]);
}

function depositMessage(
  sender: string,
  depositor: string,
  encAccount: string,
  amount: bigint,
  blockhash = pk(9),
): string {
  return v0Message({
    numRequiredSignatures: 1,
    numReadonlyUnsignedAccounts: 2,
    accountKeys: [depositor, encAccount, SYSTEM_PROGRAM_ID, MEMO_PROGRAM_ID],
    recentBlockhash: blockhash,
    instructions: [ix(2, [0, 1], transferData(amount)), ix(3, [], memoAddressData(sender))],
  });
}

function withdrawalMessage(args: {
  spender: string;
  primary: string;
  nonceAccount: string;
  recipient: string;
  nonce: string;
  amount: bigint;
}): string {
  return v0Message({
    numRequiredSignatures: 1,
    numReadonlyUnsignedAccounts: 3,
    accountKeys: [
      args.primary,
      args.nonceAccount,
      args.recipient,
      SYSTEM_PROGRAM_ID,
      SYSVAR_RECENT_BLOCKHASHES_ID,
      MEMO_PROGRAM_ID,
    ],
    recentBlockhash: args.nonce,
    instructions: [
      ix(3, [1, 4, 0], advanceNonceData()),
      ix(3, [0, 2], transferData(args.amount)),
      ix(5, [], memoAddressData(args.spender)),
    ],
  });
}

function nonceInitializationMessage(args: {
  payer: string;
  nonceAccount: string;
  authority: string;
  lamports: bigint;
  blockhash?: string;
}): string {
  return v0Message({
    numRequiredSignatures: 2,
    numReadonlyUnsignedAccounts: 3,
    accountKeys: [
      args.payer,
      args.nonceAccount,
      SYSTEM_PROGRAM_ID,
      SYSVAR_RECENT_BLOCKHASHES_ID,
      SYSVAR_RENT_ID,
    ],
    recentBlockhash: args.blockhash ?? pk(0x77),
    instructions: [
      ix(2, [0, 1], createAccountData(args.lamports, 80n)),
      ix(2, [1, 3, 4], initializeNonceData(args.authority)),
    ],
  });
}

async function deploySolanaStack(threshold = 0, signers: string[] = []) {
  const [owner, prover] = await ethers.getSigners();
  const SolanaLib = await ethers.getContractFactory("SolanaTransactionLib");
  const solanaLib = await SolanaLib.deploy();
  await solanaLib.waitForDeployment();

  const libraries = { SolanaTransactionLib: solanaLib.target };
  const Oracle = await ethers.getContractFactory("SolanaBridgeOracle", {
    libraries,
  });
  const oracle = await Oracle.deploy(signers, threshold);
  await oracle.waitForDeployment();

  const Asset = await ethers.getContractFactory("CrossroadsAssetContract");
  const asset = await Asset.deploy("Crossroads Wrapped SOL", "cWSOL", oracle, 2, 1000);
  await asset.waitForDeployment();
  return { owner, prover, oracle, asset, libraries };
}

describe("Crossroads Solana tests", function () {
  it("encodes, decodes, serializes, and hashes Solana v0 transactions", async () => {
    const { oracle, owner, libraries } = await deploySolanaStack();
    const Codec = await ethers.getContractFactory("SolanaTransactionCodec", {
      libraries,
    });
    const codec = await Codec.deploy();
    await codec.waitForDeployment();
    const depositor = pk(0x11);
    const encAccount = pk(0x22);
    const message = depositMessage(owner.address, depositor, encAccount, 12345n);
    const signedTx = signV0(message);

    const header = await oracle.decodeV0MessageHeader(signedTx);
    const codecHeader = await codec.decodeV0MessageHeader(signedTx);
    expect(codecHeader.instructionsLength).to.equal(2n);
    expect(header.numRequiredSignatures).to.equal(1n);
    expect(header.accountKeysLength).to.equal(4n);
    expect(header.instructionsLength).to.equal(2n);
    expect(header.recentBlockhash).to.equal(pk(9));

    const decodedIx0 = await oracle.decodeInstruction(signedTx, 0);
    expect(decodedIx0.programId).to.equal(SYSTEM_PROGRAM_ID);
    expect(decodedIx0.accounts).to.equal("0x0001");
    expect(decodedIx0.data).to.equal(transferData(12345n));

    const decoded = await oracle.decodeDeposit(signedTx);
    const codecDecoded = await codec.decodeDeposit(signedTx);
    expect(codecDecoded.sender).to.equal(owner.address);
    expect(codecDecoded.destination).to.equal(encAccount);
    expect(codecDecoded.amount).to.equal(12345n);
    expect(decoded.sender).to.equal(owner.address);
    expect(decoded.destination).to.equal(encAccount);
    expect(decoded.amount).to.equal(12345n);

    expect(await oracle.getTransactionHash(signedTx)).to.equal(
      ethers.keccak256(primarySig(signedTx)),
    );
    expect(await oracle.getTransactionWireHash(signedTx)).to.equal(ethers.keccak256(signedTx));
    expect(await oracle.getMessageHash(signedTx)).to.equal(ethers.sha256(message));
    expect(await oracle.getMessageHash(message)).to.equal(ethers.sha256(message));
  });

  it("verifies Solana bridge oracle finalized-transaction reports", async () => {
    const oracleSignerA = ethersPkg.Wallet.createRandom().connect(ethers.provider);
    const oracleSignerB = ethersPkg.Wallet.createRandom().connect(ethers.provider);
    const sorted = [oracleSignerA, oracleSignerB].sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
    );
    const { oracle, owner } = await deploySolanaStack(
      2,
      sorted.map((s) => s.address),
    );
    const signedTx = signV0(depositMessage(owner.address, pk(0x11), pk(0x22), 1n));
    const sig = primarySig(signedTx);
    const reportDigest = await oracle.oracleReportDigest(sig);
    const reportSignatures = await Promise.all(
      sorted.map((s) => s.signMessage(ethers.getBytes(reportDigest))),
    );

    await expect(oracle.submitFinalizedTransaction(sig, reportSignatures))
      .to.emit(oracle, "SolanaTransactionFinalized")
      .withArgs(ethers.keccak256(sig), sig);
    expect(await oracle.finalizedTransactions(ethers.keccak256(sig))).to.equal(true);
  });

  it("validates durable nonce account initialization transactions", async () => {
    const { oracle } = await deploySolanaStack();
    const payer = pk(0x31);
    const nonceAccount = pk(0x32);
    const primary = pk(0x33);
    const message = nonceInitializationMessage({
      payer,
      nonceAccount,
      authority: primary,
      lamports: 1_500_000n,
    });
    const signedTx = signV0(message, 2);

    const init = await oracle.decodeNonceInitialization(signedTx, primary, nonceAccount);
    expect(init.payer).to.equal(payer);
    expect(init.nonceAccount).to.equal(nonceAccount);
    expect(init.authority).to.equal(primary);
    expect(init.lamports).to.equal(1_500_000n);
    expect(init.space).to.equal(80n);

    const bad = nonceInitializationMessage({
      payer,
      nonceAccount,
      authority: nonceAccount,
      lamports: 1_500_000n,
    });
    await expect(oracle.decodeNonceInitialization(signV0(bad, 2), pk(0), pk(0))).to.be.revertedWith(
      "Authority must be primary account",
    );
  });

  it("checks withdrawal policy using durable nonce, transfer, and spender memo", async () => {
    const { oracle, owner } = await deploySolanaStack();
    const primary = pk(0x41);
    const nonceAccount = pk(0x42);
    const recipient = pk(0x43);
    const nonce = pk(0x44);
    await oracle.setDurableNonce(primary, nonceAccount, nonce);
    const message = withdrawalMessage({
      spender: owner.address,
      primary,
      nonceAccount,
      recipient,
      nonce,
      amount: 99_000n,
    });

    expect(await oracle.isValidForEpoch(message, primary, 0, owner.address)).to.equal(true);
    // amountSpent includes the Solana base fee (numRequiredSignatures * lamportsPerSignature).
    expect(await oracle.getTransactionCostForAccount(message, primary)).to.equal(99_000n + 5_000n);
    const decoded = await oracle.decodeWithdrawal(message, primary, nonce);
    expect(decoded.spender).to.equal(owner.address);
    expect(decoded.amountSpent).to.equal(99_000n + 5_000n);

    const wrongNonce = withdrawalMessage({
      spender: owner.address,
      primary,
      nonceAccount,
      recipient,
      nonce: pk(0x45),
      amount: 99_000n,
    });
    expect(await oracle.isValidForEpoch(wrongNonce, primary, 0, owner.address)).to.equal(false);

    const wrongNonceAccount = withdrawalMessage({
      spender: owner.address,
      primary,
      nonceAccount: pk(0x46),
      recipient,
      nonce,
      amount: 99_000n,
    });
    expect(await oracle.isValidForEpoch(wrongNonceAccount, primary, 0, owner.address)).to.equal(
      false,
    );
  });

  it("runs E2E asset integration for Solana deposit, withdrawal, rewards, duplicates, epochs, and rollover deposits", async () => {
    const { owner, prover, oracle, asset } = await deploySolanaStack();
    const depositor = pk(0x51);
    const primary = pk(0x52);
    const primaryB = pk(0x53);
    const nonceAccount = pk(0x54);
    const nonce = pk(0x55);
    await oracle.setDurableNonce(primary, nonceAccount, nonce);
    await asset.registerEncumberedAccount(primary);
    await asset.registerEncumberedAccount(primaryB);

    const depositSigned = signV0(
      depositMessage(owner.address, depositor, primary, 500_000n),
      1,
      0xb0,
    );
    await oracle.submitFinalizedTransactionBytes(depositSigned, []);
    await expect(asset.deposit(depositSigned, solanaProof(depositSigned)))
      .to.emit(asset, "DepositProcessed")
      .withArgs(owner.address, primary, 500_000n, ethers.keccak256(primarySig(depositSigned)));
    expect(await asset.balanceOf(owner.address)).to.equal(500_000n);
    await expect(asset.deposit(depositSigned, solanaProof(depositSigned))).to.be.revertedWith(
      "Deposit already processed",
    );

    await expect(asset.lockWithdrawal(300_000n, primary, { value: 1000 }))
      .to.emit(asset, "SpendingBalanceIncreased")
      .withArgs(owner.address, primary, 300_000n, 300_000n);

    const withdrawalMsg = withdrawalMessage({
      spender: owner.address,
      primary,
      nonceAccount,
      recipient: primaryB,
      nonce,
      amount: 125_000n,
    });
    expect(await asset.canSign(owner.address, primary, withdrawalMsg)).to.equal(true);
    const withdrawalSigned = signV0(withdrawalMsg, 1, 0xc0);
    await oracle.submitFinalizedTransactionBytes(withdrawalSigned, []);

    // A withdrawal to another registered Solana primary account is also a deposit/rollover.
    await expect(asset.deposit(withdrawalSigned, solanaProof(withdrawalSigned)))
      .to.emit(asset, "DepositProcessed")
      .withArgs(owner.address, primaryB, 125_000n, ethers.keccak256(primarySig(withdrawalSigned)));

    await expect(
      asset
        .connect(prover)
        .finalizeWithdrawal(withdrawalSigned, solanaProof(withdrawalSigned), primary),
    )
      .to.emit(asset, "WithdrawalFinalized")
      .withArgs(owner.address, primary, 125_000n + 5_000n, 1000n, anyValue);
    expect(await asset.accountEpoch(primary)).to.equal(1n);
    // 300_000 lock - (125_000 transfer + 5_000 base fee) = 170_000 remaining.
    expect(await asset.spendingBalance(owner.address, primary)).to.equal(170_000n);
    await expect(
      asset
        .connect(prover)
        .finalizeWithdrawal(withdrawalSigned, solanaProof(withdrawalSigned), primary),
    ).to.be.revertedWith("Withdrawal already processed");

    await oracle.advanceDurableNonce(primary, pk(0x56));
    expect(await asset.canSign(owner.address, primary, withdrawalMsg)).to.equal(false);
  });

  it("folds ComputeBudget priority fee into withdrawal amountSpent", async () => {
    const { oracle, owner } = await deploySolanaStack();
    const primary = pk(0x71);
    const nonceAccount = pk(0x72);
    const recipient = pk(0x73);
    const nonce = pk(0x74);
    await oracle.setDurableNonce(primary, nonceAccount, nonce);

    // Build a withdrawal message that prepends both ComputeBudget
    // instructions before the canonical advanceNonce / transfer / memo.
    // ComputeBudget program id is added as the last account key (index 6).
    const transferAmount = 99_000n;
    const cuLimit = 200_000;
    const cuPrice = 50_000n; // micro-lamports per CU
    const message = v0Message({
      numRequiredSignatures: 1,
      numReadonlyUnsignedAccounts: 4,
      accountKeys: [
        primary,
        nonceAccount,
        recipient,
        SYSTEM_PROGRAM_ID,
        SYSVAR_RECENT_BLOCKHASHES_ID,
        MEMO_PROGRAM_ID,
        COMPUTE_BUDGET_PROGRAM_ID,
      ],
      recentBlockhash: nonce,
      instructions: [
        ix(6, [], cbSetComputeUnitLimitData(cuLimit)),
        ix(6, [], cbSetComputeUnitPriceData(cuPrice)),
        ix(3, [1, 4, 0], advanceNonceData()),
        ix(3, [0, 2], transferData(transferAmount)),
        ix(5, [], memoAddressData(owner.address)),
      ],
    });

    // priorityFee = ceilDiv(200_000 * 50_000, 1_000_000) = 10_000
    // amountSpent = 99_000 (transfer) + 1 * 5_000 (base fee) + 10_000 (priority) = 114_000
    const expected = transferAmount + 5_000n + 10_000n;
    expect(await oracle.getTransactionCostForAccount(message, primary)).to.equal(expected);
    const decoded = await oracle.decodeWithdrawal(message, primary, nonce);
    expect(decoded.spender).to.equal(owner.address);
    expect(decoded.amountSpent).to.equal(expected);
  });

  it("keeps Solana oracle bytes plumbing stable", async () => {
    const { oracle, owner, asset } = await deploySolanaStack();
    const signedTx = signV0(depositMessage(owner.address, pk(0x61), pk(0x62), 777n), 1, 0xd0);
    const sig = primarySig(signedTx);
    const proof = solanaProof(signedTx);

    await expect(asset.deposit(signedTx, proof)).to.be.revertedWith("Solana tx not finalized");
    await oracle.submitFinalizedTransaction(sig, []);
    const decodedProofSig = ethers.AbiCoder.defaultAbiCoder().decode(["bytes"], proof)[0];
    expect(decodedProofSig).to.equal(sig);
    expect(await oracle.getTransactionHash(signedTx)).to.equal(ethers.keccak256(decodedProofSig));
  });
});
