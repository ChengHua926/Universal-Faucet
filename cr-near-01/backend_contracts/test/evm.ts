import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import { wrapEthersSigner } from "@oasisprotocol/sapphire-ethers-v6";
import { expect } from "chai";
import { ethers as ethersPkg, type JsonRpcApiProvider, VoidSigner } from "ethers";
import { network } from "hardhat";

// import { derToEthSignature } from "../liquefaction/scripts/ethereum-signatures";
import { getRlpUint, getTxInclusionProof } from "../scripts/inclusion-proofs.js";
import { createSigningCommittee } from "../scripts/signing-committee.js";
import type { Type2TxMessageStruct } from "../types/ethers-contracts/EVM/TransactionSerializer.js";

// Set if you want to encrypt transactions
const SAPPHIRE_WRAP = process.env.SAPPHIRE_WRAP === "1";

function wrapSigner(
  signer: ethersPkg.Signer & { address: string },
): ethersPkg.Signer & { address: string } {
  if (SAPPHIRE_WRAP) {
    return wrapEthersSigner(signer);
  }
  return signer;
}

const { ethers } = await network.connect();

function encodeEvmTransactionProof(proof: {
  rlpBlockHeader: string;
  transactionIndexRlp: string;
  transactionProofStack: string;
}): string {
  // `tuple(bytes,bytes,bytes)` is the ABI type for the struct.
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(bytes rlpBlockHeader, bytes transactionIndexRlp, bytes transactionProofStack)"],
    [proof],
  );
}

const publicNetwork = {
  chainId: 30121,
  name: "publicNetwork",
};
const publicProvider = new ethers.JsonRpcProvider(
  process.env.PUBLIC_RPC_URL ?? "http://127.0.0.1:32003",
  publicNetwork,
);

function getCurrentTime(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryJsonRpc<T>(description: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("transaction indexing is in progress")) {
        throw err;
      }
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for ${description}: ${String(lastError)}`);
}

async function waitForBroadcastReceipt(
  response: ethersPkg.TransactionResponse,
): Promise<ethersPkg.TransactionReceipt> {
  const receipt = await retryJsonRpc("broadcast transaction receipt indexing", () => response.wait());
  if (receipt === null) {
    throw new Error("Transaction receipt is null");
  }
  return receipt;
}

/**
 * Throws if a value is null/undefined. Used to make the TypeScript compiler
 * happy when dealing with the optional fields returned by ethers.
 */
function throwIfEmpty<T>(val: T | undefined | null, name: string): T {
  if (val === undefined || val === null) {
    throw new Error(`Expected ${name} to be defined`);
  }
  return val;
}

/**
 * Build a transaction inclusion proof for a type-2 transaction.
 *
 * Returns the signed transaction in the format expected by `CrossroadsAssetContract`,
 * along with the RLP-encoded proof data for the `BridgeOracle`.
 */
async function getTxInclusion(gethProvider: JsonRpcApiProvider, txHash: string) {
  // Pull the transaction from the public (target) chain - this is the transaction
  // that will be used in the proof on the Crossroads chain.
  const signedTx = await retryJsonRpc("transaction indexing", () => publicProvider.getTransaction(txHash));
  if (!signedTx) throw new Error("Transaction not found on target chain");

  if (signedTx.type !== 2) {
    throw new Error("Only EIP-1559 (type-2) transactions are supported in the tests");
  }

  // Get the receipt (needed for block number / index)
  const receipt = await retryJsonRpc("transaction receipt indexing", () =>
    gethProvider.getTransactionReceipt(txHash),
  );
  if (!receipt) throw new Error("Receipt not found");

  // Build the inclusion proof using the helper script.
  const { proof, rlpBlockHeader } = await getTxInclusionProof(
    gethProvider as any,
    receipt.blockNumber,
    receipt.index,
  );

  // Reformat the signed transaction for the bridge oracle.
  const signedTxFormatted = {
    transaction: {
      chainId: signedTx.chainId,
      nonce: signedTx.nonce,
      maxPriorityFeePerGas: throwIfEmpty(signedTx.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
      maxFeePerGas: throwIfEmpty(signedTx.maxFeePerGas, "maxFeePerGas"),
      gasLimit: signedTx.gasLimit,
      destination: throwIfEmpty(signedTx.to, "to"),
      amount: signedTx.value,
      payload: signedTx.data,
    },
    r: signedTx.signature.r,
    s: signedTx.signature.s,
    v: signedTx.signature.v,
  };

  return {
    signedTxFormatted,
    inclusionProof: {
      rlpBlockHeader,
      transactionIndexRlp: getRlpUint(receipt.index),
      transactionProofStack: ethers.encodeRlp(proof.map((rlpList) => ethers.decodeRlp(rlpList))),
    },
    proofBlockNumber: receipt.blockNumber,
  };
}

// Test suite
describe("Crossroads EVM tests", function () {
  async function deployStack() {
    const [owner, prover] = await ethers.getSigners();

    const TrivialBlockHashOracleFactory = await ethers.getContractFactory("TrivialBlockHashOracle");
    const blockHashOracle = await TrivialBlockHashOracleFactory.deploy();
    await blockHashOracle.waitForDeployment();

    const ProvethVerifierFactory = await ethers.getContractFactory("ProvethVerifier");
    const provethVerifier = await ProvethVerifierFactory.deploy();
    await provethVerifier.waitForDeployment();

    const TxSerializerFactory = await ethers.getContractFactory("TransactionSerializer");
    const txSerializer = await TxSerializerFactory.deploy();
    await txSerializer.waitForDeployment();

    const BridgeOracleFactory = await ethers.getContractFactory("BridgeOracle", {
      libraries: {
        TransactionSerializer: txSerializer.target,
      },
    });
    const bridgeOracle = await BridgeOracleFactory.deploy(blockHashOracle, provethVerifier);
    await bridgeOracle.waitForDeployment();

    const AssetFactory = await ethers.getContractFactory("CrossroadsAssetContract");
    const asset = await AssetFactory.deploy(
      "Crossroads Wrapped ETH",
      "cWETH",
      bridgeOracle,
      1,
      ethers.parseEther("0.1"), // withdrawalProofReward
      {
        gasLimit: 12_000_000,
      },
    );
    await asset.waitForDeployment();

    return {
      owner: wrapSigner(owner),
      prover: wrapSigner(prover),
      blockHashOracle,
      provethVerifier,
      txSerializer,
      bridgeOracle,
      asset: asset.connect(wrapSigner(owner)),
    };
  }

  it("owner can register and remove encumbered accounts", async () => {
    const { owner, asset } = await deployStack();

    const enc = ethers.keccak256(ethers.toUtf8Bytes("enc1"));
    await expect(asset.registerEncumberedAccount(enc))
      .to.emit(asset, "EncumberedAccountRegistered")
      .withArgs(enc);

    expect(await asset.isEncumberedAccount(enc)).to.be.true;

    await expect(asset.removeEncumberedAccount(enc))
      .to.emit(asset, "EncumberedAccountRemoved")
      .withArgs(enc);

    expect(await asset.isEncumberedAccount(enc)).to.be.false;
  });

  it("owner can change configuration values", async () => {
    const { owner, asset } = await deployStack();

    await expect(asset.setWithdrawalProofReward(ethers.parseEther("0.02")))
      .to.emit(asset, "WithdrawalProofRewardChanged")
      .withArgs(ethers.parseEther("0.02"));
    expect(await asset.withdrawalProofReward()).to.equal(ethers.parseEther("0.02"));
  });

  it("full deposit -> lock -> sign -> prove -> finalize withdrawal flow", async function () {
    const { owner, prover, blockHashOracle, bridgeOracle, asset } = await deployStack();

    const committee = createSigningCommittee(asset, owner);
    await committee.setup();
    try {
    const encAccount = new VoidSigner(committee.getEncAddress());
    const encAccountId = committee.getEncAddressId();
    // Register encumbered account
    await expect(committee.registerEncumberedAccount())
      .to.emit(asset, "EncumberedAccountRegistered")
      .withArgs(encAccountId);

    const ownerPublic = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    ).connect(publicProvider);

    const depositTx = await ownerPublic.populateTransaction({
      to: encAccount.address,
      value: ethers.parseEther("0.2"),
      chainId: (await publicProvider.getNetwork()).chainId,
    });
    const signedDepositTx = ethers.Transaction.from(await ownerPublic.signTransaction(depositTx));
    const depositTxHash = signedDepositTx.hash!;
    // Broadcast on the target chain (the same node we are using as "public")
    const receipt = await publicProvider
      .broadcastTransaction(signedDepositTx.serialized)
      .then(waitForBroadcastReceipt);

    // Record the block hash in the block hash oracle so the bridge oracle can verify it later.
    await blockHashOracle
      .setBlockHash(receipt.blockNumber, receipt.blockHash)
      .then((r) => r.wait());

    // Generate the inclusion proof and call `deposit` on the asset.
    const { signedTxFormatted, inclusionProof, proofBlockNumber } = await getTxInclusion(
      publicProvider,
      depositTxHash,
    );
    console.log(signedTxFormatted);

    await expect((asset as any).deposit(signedDepositTx.serialized, encodeEvmTransactionProof(inclusionProof)))
      .to.emit(asset, "DepositProcessed")
      .withArgs(owner.address, encAccountId, ethers.parseEther("0.2"), anyValue);

    // Verify that the wrapped token balance was minted
    expect(await asset.balanceOf(owner.address)).to.equal(ethers.parseEther("0.2"));

    // Verify bookkeeping
    expect(await asset.withdrawalProofSubsidy(owner.address)).to.equal(0n);
    expect(await asset.balanceOf(owner.address)).to.equal(ethers.parseEther("0.2"));

    // Lock a withdrawal (burn wrapped tokens and optionally fund the proof reward). The spender is `owner`.
    const lockAmount = ethers.parseEther("0.1");
    const proofSubsidyToFund = ethers.parseEther("0.15");
    await expect(
      asset
        .lockWithdrawal(lockAmount, encAccountId, {
          value: proofSubsidyToFund,
        })
        .then((r) => r.wait()),
    )
      .to.emit(asset, "SpendingBalanceIncreased")
      .withArgs(
        owner.address,
        encAccountId,
        lockAmount,
        lockAmount,
      );

    // Check internal state after locking
    const [lockedAmt, blocked] = await asset.getSpendingPosition(
      owner.address,
      encAccountId,
    );
    expect(lockedAmt).to.equal(lockAmount);
    expect(blocked).to.be.false;
    expect(await asset.withdrawalProofSubsidy(owner.address)).to.equal(proofSubsidyToFund);

    // Verify `canSign` - the policy should say the spender is eligible.
    // Build a dummy unsigned transaction that the signing machine would ask the policy to sign. The payload must start with the spender address.
    const gasEstimate = await publicProvider.estimateGas({
      from: encAccount.address,
      to: ethers.ZeroAddress,
      data: ethers.concat([owner.address]),
    });
    const unsignedWithdraw: Type2TxMessageStruct = {
      chainId: (await publicProvider.getNetwork()).chainId,
      // For EVM chains the nonce must equal the current epoch
      nonce: Number(await asset.accountEpoch(encAccountId)),
      maxPriorityFeePerGas: 10_000_000_000n,
      maxFeePerGas: 10_000_000_000n,
      gasLimit: gasEstimate,
      destination: ethers.ZeroAddress,
      amount: ethers.parseEther("0.07"),
      // We'll encode the spender's address here. TODO: Write test in which this isn't done properly
      payload: ethers.concat([owner.address]),
    };
    const can = await (asset as any).canSign(owner.address, encAccountId, committee.encodeUnsignedTx(unsignedWithdraw));
    expect(can).to.be.true;

    const { signedStruct: signedWithdraw, signedTx: signedWithdrawalTx } = await committee.signTx(
      unsignedWithdraw,
      owner,
    );

    const withdrawTxHash = await (bridgeOracle as any).getTransactionHash(signedWithdrawalTx.serialized);
    const withdrawReceipt = await publicProvider
      .broadcastTransaction(signedWithdrawalTx.serialized)
      .then(waitForBroadcastReceipt);

    await blockHashOracle
      .setBlockHash(withdrawReceipt.blockNumber, withdrawReceipt.blockHash)
      .then((r) => r.wait());

    // Record the block hash for the oracle (duplicate call retained for compatibility)
    await blockHashOracle
      .setBlockHash(withdrawReceipt.blockNumber, withdrawReceipt.blockHash)
      .then((r) => r.wait());

    // Build inclusion proof for the withdrawal
    const {
      signedTxFormatted: signedWithdrawFmt,
      inclusionProof: withdrawProof,
      proofBlockNumber: withdrawProofBlock,
    } = await getTxInclusion(publicProvider, withdrawTxHash);

    console.log(signedWithdrawFmt);

    // Prove the withdrawal. This should (1) advance the epoch, (2) pay the reward to
    // the prover, (3) refund any unused locked tokens (TODO), (4) deduct from
    // spender's withdrawal balance
    const preEpoch = await asset.accountEpoch(encAccountId);
    const preRewardBalance = await ethers.provider.getBalance(prover.address);
    const preWrapped = await asset.balanceOf(owner.address);

    await expect(
      (asset as any)
        .connect(prover)
        .finalizeWithdrawal(
          signedWithdrawalTx.serialized,
          encodeEvmTransactionProof(withdrawProof),
          encAccountId,
        )
        .then((r: any) => r.wait()),
    )
      .to.emit(asset, "EpochAdvanced")
      .withArgs(encAccountId, preEpoch + 1n)
      .and.to.emit(asset, "WithdrawalFinalized")
      .withArgs(
        owner.address,
        encAccountId,
        ethers.parseEther("0.07") +
          BigInt(unsignedWithdraw.maxFeePerGas) * BigInt(unsignedWithdraw.gasLimit), // amountSpent
        anyValue, // rewardPaid (checked below)
        anyValue, // txHash
      );

    const postEpoch = await asset.accountEpoch(encAccountId);
    expect(postEpoch).to.equal(preEpoch + 1n);

    // Reward should have been transferred to the prover (or kept in contract if balance insufficient)
    const postRewardBalance = await ethers.provider.getBalance(prover.address);
    const rewardDiff = postRewardBalance - preRewardBalance;
    // The contract pays at most `withdrawalProofReward` and at most the spender's proof subsidy.
    const rewardPaid = ethers.parseEther("0.1");
    expect(rewardDiff).to.be.above(0n);
    expect(rewardDiff).to.be.at.most(rewardPaid);

    // We don't support automatic refunds yet
    const postWrapped = await asset.balanceOf(owner.address);
    expect(postWrapped).to.equal(preWrapped /*+ ethers.parseEther("0.03")*/);

    // Proof subsidy bookkeeping: we entered 0.15 native tokens, and 0.1 were spent on posting the withdrawal.
    const postNative = await asset.withdrawalProofSubsidy(owner.address);
    const expectedProofSubsidy = proofSubsidyToFund - rewardPaid;
    expect(postNative).to.equal(expectedProofSubsidy);

    // The remaining subsidy is below one proof reward while spending balance remains active, so signing is blocked.
    expect(await (asset as any).canSign(owner.address, encAccountId, committee.encodeUnsignedTx(unsignedWithdraw))).to.be
      .false;
    } finally {
      await committee.shutdown();
    }
  });
});
