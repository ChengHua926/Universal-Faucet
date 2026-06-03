const { expect } = require("chai");
const hre = require("hardhat");

// ROFL authorization is enforced by a Sapphire precompile, which is absent on
// local Hardhat. These tests verify constructor state and default-deny behavior
// for normal callers; the ROFL happy path must be validated on Sapphire/ROFL.
describe("CrossroadsHeaderOracle", function () {
  const APP_ID = "0x002339e39056f12efc2e8f1476a871e22555bc4e49";
  const COMMITMENT = "0x" + "11".repeat(32);

  let oracle;
  let signer;

  beforeEach(async function () {
    [signer] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("CrossroadsHeaderOracle");
    oracle = await Factory.deploy(APP_ID);
    await oracle.waitForDeployment();
  });

  it("stores the ROFL app id from the constructor", async function () {
    expect(await oracle.roflAppID()).to.equal(APP_ID);
  });

  it("starts without a header signer", async function () {
    expect(await oracle.headerSigner()).to.equal(hre.ethers.ZeroAddress);
    expect(await oracle.headerSignerEpoch()).to.equal(0n);
    expect(await oracle.headerSignerCommitment()).to.equal("0x" + "00".repeat(32));
  });

  it("rejects registerHeaderSigner from a normal caller", async function () {
    await expect(
      oracle.registerHeaderSigner(signer.address, COMMITMENT)
    ).to.be.reverted;
  });

  it("rejects rotateHeaderSigner from a normal caller", async function () {
    await expect(
      oracle.rotateHeaderSigner(signer.address, COMMITMENT)
    ).to.be.reverted;
  });
});
