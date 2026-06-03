import { expect } from "chai";
import { ethers as ethersPkg } from "ethers";
import { network } from "hardhat";

import { MockSigningCommittee } from "../scripts/signing-committee.js";

const { ethers } = await network.connect();

const PROOF_REWARD = ethers.parseEther("1");

function mockTxData(cost: bigint, epoch: bigint, spender: string, valid = true): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "address", "bool"],
    [cost, epoch, spender, valid],
  );
}

describe("CrossroadsAssetContract accounting", function () {
  async function deployAccountingStack() {
    const [owner, spender, prover] = await ethers.getSigners();

    const MockOracleFactory = await ethers.getContractFactory("MockBridgeOracle");
    const bridgeOracle = await MockOracleFactory.deploy();
    await bridgeOracle.waitForDeployment();

    const AssetFactory = await ethers.getContractFactory("CrossroadsAssetContract");
    const asset = await AssetFactory.deploy(
      "Crossroads Wrapped ETH",
      "cWETH",
      bridgeOracle,
      1,
      PROOF_REWARD,
    );
    await asset.waitForDeployment();

    const committee = new MockSigningCommittee(asset.connect(owner) as any);
    await committee.registerEncumberedAccount();

    return {
      owner,
      spender,
      prover,
      bridgeOracle,
      asset,
      committee,
      encAccount: committee.getEncAddressId(),
    };
  }

  async function mintWrapped(
    asset: any,
    bridgeOracle: any,
    spender: ethersPkg.Signer & { address: string },
    encAccount: string,
    amount: bigint,
    salt: string,
  ) {
    const depositTx = ethers.solidityPacked(["string"], [salt]);
    await bridgeOracle.setDeposit(depositTx, spender.address, encAccount, amount).then((r: any) => r.wait());
    await asset.deposit(depositTx, "0x").then((r: any) => r.wait());
  }

  async function finalizeMockWithdrawal(
    asset: any,
    bridgeOracle: any,
    prover: ethersPkg.Signer,
    encAccount: string,
    spender: string,
    amountSpent: bigint,
    epoch: bigint,
    salt: string,
  ) {
    const withdrawalTx = ethers.solidityPacked(["string"], [salt]);
    await bridgeOracle
      .setWithdrawal(withdrawalTx, encAccount, spender, amountSpent, epoch)
      .then((r: any) => r.wait());
    await asset.connect(prover).finalizeWithdrawal(withdrawalTx, "0x", encAccount).then((r: any) => r.wait());
  }

  it("uses spending balance as the maximum transaction cost and requires proof subsidy", async () => {
    const { asset, bridgeOracle, spender, encAccount } = await deployAccountingStack();

    await mintWrapped(asset, bridgeOracle, spender, encAccount, ethers.parseEther("10"), "deposit-1");
    await asset.connect(spender).lockWithdrawal(ethers.parseEther("5"), encAccount, { value: PROOF_REWARD });

    expect(await asset.spendingBalance(spender.address, encAccount)).to.equal(ethers.parseEther("5"));
    expect(await asset.withdrawalProofSubsidy(spender.address)).to.equal(PROOF_REWARD);
    expect(await asset.requiredWithdrawalProofSubsidy(spender.address)).to.equal(PROOF_REWARD);

    const affordable = mockTxData(ethers.parseEther("4"), 0n, spender.address);
    const tooExpensive = mockTxData(ethers.parseEther("6"), 0n, spender.address);

    expect(await asset.canSign(spender.address, encAccount, affordable)).to.equal(true);
    expect(await asset.canSign(spender.address, encAccount, tooExpensive)).to.equal(false);
  });

  it("shares proof subsidy across active encumbered accounts and prevents over-withdrawal", async () => {
    const { asset, bridgeOracle, owner, spender, encAccount } = await deployAccountingStack();
    const secondCommittee = new MockSigningCommittee(asset.connect(owner) as any);
    await secondCommittee.registerEncumberedAccount();
    const encAccount2 = secondCommittee.getEncAddressId();

    await mintWrapped(asset, bridgeOracle, spender, encAccount, ethers.parseEther("10"), "deposit-a");
    await mintWrapped(asset, bridgeOracle, spender, encAccount2, ethers.parseEther("10"), "deposit-b");

    await asset.connect(spender).lockWithdrawal(ethers.parseEther("2"), encAccount, { value: PROOF_REWARD * 2n });
    await asset.connect(spender).lockWithdrawal(ethers.parseEther("2"), encAccount2);

    expect(await asset.activeWithdrawalAccountCount(spender.address)).to.equal(2n);
    expect(await asset.requiredWithdrawalProofSubsidy(spender.address)).to.equal(PROOF_REWARD * 2n);

    await expect(asset.connect(spender).withdrawWithdrawalProofSubsidy(PROOF_REWARD)).to.be.revertedWith(
      "Active withdrawals need subsidy",
    );

    await asset.connect(spender).blockSpendingBalance(encAccount2);
    expect(await asset.activeWithdrawalAccountCount(spender.address)).to.equal(1n);

    await expect(asset.connect(spender).withdrawWithdrawalProofSubsidy(PROOF_REWARD))
      .to.emit(asset, "WithdrawalProofSubsidyWithdrawn")
      .withArgs(spender.address, PROOF_REWARD, PROOF_REWARD);

    const tx1 = mockTxData(ethers.parseEther("1"), 0n, spender.address);
    expect(await asset.canSign(spender.address, encAccount, tx1)).to.equal(true);
    expect(await asset.canSign(spender.address, encAccount2, tx1)).to.equal(false);
  });

  it("consumes proof subsidy and spending balance when a withdrawal is finalized", async () => {
    const { asset, bridgeOracle, spender, prover, encAccount } = await deployAccountingStack();

    await mintWrapped(asset, bridgeOracle, spender, encAccount, ethers.parseEther("10"), "deposit-finalize");
    await asset.connect(spender).lockWithdrawal(ethers.parseEther("5"), encAccount, { value: PROOF_REWARD });

    await finalizeMockWithdrawal(
      asset,
      bridgeOracle,
      prover,
      encAccount,
      spender.address,
      ethers.parseEther("2"),
      0n,
      "withdraw-finalize",
    );

    expect(await asset.accountEpoch(encAccount)).to.equal(1n);
    expect(await asset.spendingBalance(spender.address, encAccount)).to.equal(ethers.parseEther("3"));
    expect(await asset.withdrawalProofSubsidy(spender.address)).to.equal(0n);
    expect(await asset.activeWithdrawalAccountCount(spender.address)).to.equal(1n);

    const txData = mockTxData(ethers.parseEther("1"), 1n, spender.address);
    expect(await asset.canSign(spender.address, encAccount, txData)).to.equal(false);
  });

  it("requires blocking and an epoch increase before spending balance can be reclaimed", async () => {
    const { asset, bridgeOracle, spender, prover, encAccount } = await deployAccountingStack();

    await mintWrapped(asset, bridgeOracle, spender, encAccount, ethers.parseEther("5"), "deposit-reclaim");
    await asset.connect(spender).lockWithdrawal(ethers.parseEther("5"), encAccount, { value: PROOF_REWARD });
    await asset.connect(spender).blockSpendingBalance(encAccount);

    const txData = mockTxData(ethers.parseEther("1"), 0n, spender.address);
    expect(await asset.canSign(spender.address, encAccount, txData)).to.equal(false);
    expect(await asset.requiredWithdrawalProofSubsidy(spender.address)).to.equal(0n);

    await expect(asset.connect(spender).withdrawSpendingBalance(encAccount, ethers.parseEther("2"))).to.be.revertedWith(
      "Epoch not advanced",
    );

    await finalizeMockWithdrawal(
      asset,
      bridgeOracle,
      prover,
      encAccount,
      spender.address,
      0n,
      0n,
      "withdraw-advance-epoch",
    );

    await expect(asset.connect(spender).withdrawSpendingBalance(encAccount, ethers.parseEther("2")))
      .to.emit(asset, "SpendingBalanceWithdrawn")
      .withArgs(spender.address, encAccount, ethers.parseEther("2"));

    expect(await asset.balanceOf(spender.address)).to.equal(ethers.parseEther("2"));
    expect(await asset.spendingBalance(spender.address, encAccount)).to.equal(ethers.parseEther("3"));
    expect(await asset.spendingBalanceBlocked(spender.address, encAccount)).to.equal(true);
  });

  it("requires a fresh epoch increase after unblocking and blocking again", async () => {
    const { asset, bridgeOracle, spender, prover, encAccount } = await deployAccountingStack();

    await mintWrapped(asset, bridgeOracle, spender, encAccount, ethers.parseEther("5"), "deposit-reblock");
    await asset.connect(spender).lockWithdrawal(ethers.parseEther("5"), encAccount, { value: PROOF_REWARD * 2n });
    await asset.connect(spender).blockSpendingBalance(encAccount);

    await finalizeMockWithdrawal(
      asset,
      bridgeOracle,
      prover,
      encAccount,
      spender.address,
      0n,
      0n,
      "withdraw-reblock-epoch-1",
    );

    await asset.connect(spender).unblockSpendingBalance(encAccount);
    await asset.connect(spender).blockSpendingBalance(encAccount);

    await expect(asset.connect(spender).withdrawSpendingBalance(encAccount, ethers.parseEther("1"))).to.be.revertedWith(
      "Epoch not advanced",
    );

    await finalizeMockWithdrawal(
      asset,
      bridgeOracle,
      prover,
      encAccount,
      spender.address,
      0n,
      1n,
      "withdraw-reblock-epoch-2",
    );

    await asset.connect(spender).withdrawSpendingBalance(encAccount, ethers.parseEther("1"));
    expect(await asset.balanceOf(spender.address)).to.equal(ethers.parseEther("1"));
  });
});
