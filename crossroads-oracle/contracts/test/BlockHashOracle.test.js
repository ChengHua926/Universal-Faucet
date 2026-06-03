const { expect } = require("chai");
const hre = require("hardhat");

// NOTE on coverage: roflEnsureAuthorizedOrigin is a Sapphire-only precompile,
// absent on the local Hardhat (EDR) network. So the onlyROFL "happy path"
// (an attested ROFL app writing successfully) cannot run here — that is proven
// on Sapphire testnet. Locally we verify: constructor wiring, initial state,
// and that any non-ROFL caller is rejected by default.

describe("BlockHashOracle", function () {
  // bytes21 form of our oracle ROFL app id rofl1qq3nncus2mcjalpw3u28d2r3ugj4t0zwfypqrlha
  const APP_ID = "0x002339e39056f12efc2e8f1476a871e22555bc4e49";

  let oracle;

  beforeEach(async function () {
    const Factory = await hre.ethers.getContractFactory("BlockHashOracle");
    oracle = await Factory.deploy(APP_ID);
    await oracle.waitForDeployment();
  });

  it("stores the ROFL app id from the constructor", async function () {
    expect(await oracle.roflAppID()).to.equal(APP_ID);
  });

  it("starts with empty state", async function () {
    expect(await oracle.latestBlockNumber()).to.equal(0n);
    expect(await oracle.blockHashes(123)).to.equal("0x" + "00".repeat(32));
  });

  it("rejects writes that do not originate from the ROFL app (default-deny)", async function () {
    const someHash = "0x" + "11".repeat(32);
    // A normal signer is NOT the attested ROFL app, so onlyROFL must revert.
    await expect(oracle.storeBlockHash(123, someHash)).to.be.reverted;
  });

  it("does not store anything when an unauthorized write reverts", async function () {
    const someHash = "0x" + "22".repeat(32);
    await expect(oracle.storeBlockHash(456, someHash)).to.be.reverted;
    // State must be untouched.
    expect(await oracle.blockHashes(456)).to.equal("0x" + "00".repeat(32));
    expect(await oracle.latestBlockNumber()).to.equal(0n);
  });
});
