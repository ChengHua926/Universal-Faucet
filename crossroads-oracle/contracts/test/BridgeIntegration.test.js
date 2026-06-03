const { expect } = require("chai");
const hre = require("hardhat");

// Proves the cr-near EVM bridge stack is wired to OUR ROFL block-hash oracle.
// (The full verifyDeposit happy-path needs a real Merkle proof AND a stored
// block hash; storing requires the Sapphire ROFL origin, so that end-to-end
// path is exercised on Sapphire / sapphire-localnet, not on plain Hardhat EDR.)
describe("EVM bridge integration (cr-near stack on our ROFL oracle)", function () {
  const APP_ID = "0x002339e39056f12efc2e8f1476a871e22555bc4e49";

  let oracle, proveth, bridge;

  beforeEach(async function () {
    const Oracle = await hre.ethers.getContractFactory("BlockHashOracle");
    oracle = await Oracle.deploy(APP_ID);
    await oracle.waitForDeployment();

    const Proveth = await hre.ethers.getContractFactory("ProvethVerifier");
    proveth = await Proveth.deploy();
    await proveth.waitForDeployment();

    const TxSer = await hre.ethers.getContractFactory("TransactionSerializer");
    const txSer = await TxSer.deploy();
    await txSer.waitForDeployment();

    const Bridge = await hre.ethers.getContractFactory("BridgeOracle", {
      libraries: { TransactionSerializer: await txSer.getAddress() },
    });
    bridge = await Bridge.deploy(await oracle.getAddress(), await proveth.getAddress());
    await bridge.waitForDeployment();
  });

  it("wires BridgeOracle to OUR ROFL BlockHashOracle and the proof verifier", async function () {
    expect(await bridge.blockHashOracle()).to.equal(await oracle.getAddress());
    expect(await bridge.stateVerifier()).to.equal(await proveth.getAddress());
  });

  it("our oracle implements IBlockHashOracle and fails closed on unknown blocks", async function () {
    await expect(oracle.getBlockHash(12345)).to.be.revertedWith("No header found for this block");
  });

  it("the ROFL write guard is still intact after implementing IBlockHashOracle", async function () {
    await expect(oracle.storeBlockHash(1, "0x" + "11".repeat(32))).to.be.reverted;
  });
});
