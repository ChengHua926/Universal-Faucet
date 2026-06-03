const hre = require("hardhat");

// Deploys the cr-near EVM bridge stack, but fed by OUR ROFL BlockHashOracle
// instead of the owner-operated CentralizedEvmBlockHashOracle.
//
//   CrossroadsAssetContract
//        -> BridgeOracle
//             -> BlockHashOracle  (ROFL/TEE-fed, implements IBlockHashOracle)
//             -> ProvethVerifier  (tx Merkle inclusion proofs)
//
// MUST be deployed on Sapphire (BlockHashOracle.storeBlockHash uses the
// roflEnsureAuthorizedOrigin precompile). On a plain-EVM chain the bridge would
// deploy, but the oracle could never be written to.
async function main() {
  const ROFL_APP_ID = process.env.ROFL_APP_ID;
  if (!ROFL_APP_ID || ROFL_APP_ID.length !== 44 /* 0x + 42 hex */) {
    throw new Error("Set ROFL_APP_ID in .env to the bytes21 value (0x + 42 hex chars)");
  }
  console.log(`Deploying EVM bridge stack on network: ${hre.network.name}`);

  const Oracle = await hre.ethers.getContractFactory("BlockHashOracle");
  const oracle = await Oracle.deploy(ROFL_APP_ID);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`BlockHashOracle (ROFL-fed, IBlockHashOracle): ${oracleAddr}`);

  const Proveth = await hre.ethers.getContractFactory("ProvethVerifier");
  const proveth = await Proveth.deploy();
  await proveth.waitForDeployment();
  const provethAddr = await proveth.getAddress();
  console.log(`ProvethVerifier (tx inclusion proofs):        ${provethAddr}`);

  // TransactionSerializer is a library with public functions -> link it.
  const TxSer = await hre.ethers.getContractFactory("TransactionSerializer");
  const txSer = await TxSer.deploy();
  await txSer.waitForDeployment();
  const txSerAddr = await txSer.getAddress();
  console.log(`TransactionSerializer (library):              ${txSerAddr}`);

  const Bridge = await hre.ethers.getContractFactory("BridgeOracle", {
    libraries: { TransactionSerializer: txSerAddr },
  });
  const bridge = await Bridge.deploy(oracleAddr, provethAddr);
  await bridge.waitForDeployment();
  const bridgeAddr = await bridge.getAddress();
  console.log(`BridgeOracle (verifyDeposit/Withdrawal):      ${bridgeAddr}`);

  const Asset = await hre.ethers.getContractFactory("CrossroadsAssetContract");
  const asset = await Asset.deploy("Crossroads EVM", "crEVM", bridgeAddr, 1, 0);
  await asset.waitForDeployment();
  console.log(`CrossroadsAssetContract (ledger):             ${await asset.getAddress()}`);

  console.log(
    "\nWiring OK: AssetContract -> BridgeOracle -> { BlockHashOracle(ROFL), ProvethVerifier }"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
