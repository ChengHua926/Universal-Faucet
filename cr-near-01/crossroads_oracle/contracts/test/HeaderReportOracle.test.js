const { expect } = require("chai");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "header_report_fixture.json"), "utf8")
);

const APP_ID = "0x002339e39056f12efc2e8f1476a871e22555bc4e49";
const SOURCE_CHAIN_ID = 11155111;
const MIN_CONFIRMATIONS = 12;

// Map a report object -> the Solidity struct tuple order (overrides via `over`).
function reportTuple(r, over = {}) {
  const m = { ...r, ...over };
  return [
    BigInt(m.sourceChainId),
    BigInt(m.blockNumber),
    m.blockHash,
    m.rlpHeaderHash,
    BigInt(m.requiredConfirmations),
    BigInt(m.observedConfirmations),
    BigInt(m.quorumTip),
    m.requireFinalized,
    BigInt(m.finalizedBlockNumber),
    m.rpcVoteDigest,
    BigInt(m.expiresAt),
    BigInt(m.signerEpoch),
    m.rlpHeader,
  ];
}

async function deployHarness(mandateFinalized = false) {
  const F = await hre.ethers.getContractFactory("HeaderReportOracleHarness");
  const h = await F.deploy(APP_ID, SOURCE_CHAIN_ID, MIN_CONFIRMATIONS, mandateFinalized);
  await h.waitForDeployment();
  return h;
}

// Sign a report over the digest the CONTRACT itself will compute (block.chainid +
// address(this)), so the happy path verifies on the local network.
async function signFor(harness, reportObj, wallet, over = {}) {
  const net = await hre.ethers.provider.getNetwork();
  const addr = await harness.getAddress();
  const digest = await harness.digestForTest(net.chainId, addr, reportTuple(reportObj, over));
  return new hre.ethers.SigningKey(wallet.privateKey).sign(digest).serialized;
}

describe("HeaderReportOracle — Python<->Solidity alignment", function () {
  it("recomputes the exact same report digest Python produced", async function () {
    const h = await deployHarness();
    const d = await h.digestForTest(
      fixture.sapphireChainId,
      fixture.oracleContract,
      reportTuple(fixture.report)
    );
    expect(d).to.equal(fixture.reportDigest);
  });

  it("recovers the Python signer from the Python signature", async function () {
    const h = await deployHarness();
    const rec = await h.recoverForTest(fixture.reportDigest, fixture.signature);
    expect(rec).to.equal(fixture.signer);
  });
});

describe("HeaderReportOracle — submitSignedHeader", function () {
  let h, signer;

  beforeEach(async function () {
    h = await deployHarness();
    signer = hre.ethers.Wallet.createRandom();
    await h.setSignerForTest(signer.address, fixture.report.signerEpoch);
  });

  it("stores a valid report; getBlockHash returns it", async function () {
    const sig = await signFor(h, fixture.report, signer);
    await h.submitSignedHeader(reportTuple(fixture.report), sig);
    expect(await h.getBlockHash(fixture.report.blockNumber)).to.equal(fixture.report.blockHash);
    expect(await h.latestBlockNumber()).to.equal(BigInt(fixture.report.blockNumber));
  });

  it("is idempotent for the same (block, hash)", async function () {
    const sig = await signFor(h, fixture.report, signer);
    await h.submitSignedHeader(reportTuple(fixture.report), sig);
    await h.submitSignedHeader(reportTuple(fixture.report), sig); // no revert
    expect(await h.getBlockHash(fixture.report.blockNumber)).to.equal(fixture.report.blockHash);
  });

  it("rejects a signature not from the registered signer", async function () {
    const attacker = hre.ethers.Wallet.createRandom();
    const sig = await signFor(h, fixture.report, attacker);
    await expect(h.submitSignedHeader(reportTuple(fixture.report), sig)).to.be.revertedWithCustomError(
      h,
      "UnauthorizedReportSigner"
    );
  });

  it("rejects a stale signer epoch", async function () {
    await h.setSignerForTest(signer.address, fixture.report.signerEpoch + 1);
    const sig = await signFor(h, fixture.report, signer);
    await expect(h.submitSignedHeader(reportTuple(fixture.report), sig)).to.be.revertedWithCustomError(
      h,
      "StaleSignerEpoch"
    );
  });

  it("rejects a report for the wrong source chain", async function () {
    const over = { sourceChainId: 1 };
    const sig = await signFor(h, fixture.report, signer, over);
    await expect(
      h.submitSignedHeader(reportTuple(fixture.report, over), sig)
    ).to.be.revertedWithCustomError(h, "WrongSourceChain");
  });

  it("rejects confirmations below the contract floor", async function () {
    const over = { requiredConfirmations: 1 }; // < MIN_CONFIRMATIONS
    const sig = await signFor(h, fixture.report, signer, over);
    await expect(
      h.submitSignedHeader(reportTuple(fixture.report, over), sig)
    ).to.be.revertedWithCustomError(h, "InsufficientConfirmations");
  });

  it("rejects a header whose RLP does not hash to blockHash", async function () {
    const over = { rlpHeader: "0xdeadbeef" }; // keccak != blockHash
    const sig = await signFor(h, fixture.report, signer, over);
    await expect(
      h.submitSignedHeader(reportTuple(fixture.report, over), sig)
    ).to.be.revertedWithCustomError(h, "HeaderHashMismatch");
  });

  it("rejects a conflicting overwrite for the same block number", async function () {
    // First, store the real report.
    await h.submitSignedHeader(reportTuple(fixture.report), await signFor(h, fixture.report, signer));
    // Now a self-consistent but DIFFERENT header for the same block number.
    const rlp2 = "0xc0ffee";
    const h2 = hre.ethers.keccak256(rlp2);
    const over = { rlpHeader: rlp2, blockHash: h2, rlpHeaderHash: h2 };
    const sig = await signFor(h, fixture.report, signer, over);
    await expect(
      h.submitSignedHeader(reportTuple(fixture.report, over), sig)
    ).to.be.revertedWithCustomError(h, "ConflictingBlockHash");
  });

  it("enforces finality when the contract mandates it", async function () {
    const hf = await deployHarness(true); // mandateFinalized = true
    await hf.setSignerForTest(signer.address, fixture.report.signerEpoch);
    const over = { requireFinalized: false };
    const sig = await signFor(hf, fixture.report, signer, over);
    await expect(
      hf.submitSignedHeader(reportTuple(fixture.report, over), sig)
    ).to.be.revertedWithCustomError(hf, "FinalityRequired");
  });
});

describe("HeaderReportOracle — registration default-deny", function () {
  it("registerHeaderSigner reverts for a non-ROFL caller", async function () {
    const F = await hre.ethers.getContractFactory("HeaderReportOracle");
    const oracle = await F.deploy(APP_ID, SOURCE_CHAIN_ID, MIN_CONFIRMATIONS, false);
    await oracle.waitForDeployment();
    // roflEnsureAuthorizedOrigin is a Sapphire-only precompile -> reverts on EDR.
    await expect(oracle.registerHeaderSigner(hre.ethers.ZeroAddress, hre.ethers.ZeroHash)).to.be
      .reverted;
  });
});
