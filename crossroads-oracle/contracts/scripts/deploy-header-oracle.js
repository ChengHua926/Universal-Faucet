const hre = require("hardhat");

// Deploys the Model B oracle: HeaderReportOracle. The TEE registers its KMS
// header-signer here (onlyROFL), then anyone relays a TEE-signed HeaderReport to
// submitSignedHeader, which verifies the signature against the registered signer
// and enforces the contract's OWN floor before storing the block hash.
async function main() {
  // 21-byte form of our ROFL app id (bech32-decoded from rofl1...). Baked in as
  // the only identity allowed to register/rotate the header signer.
  const ROFL_APP_ID = process.env.ROFL_APP_ID;
  if (!ROFL_APP_ID || ROFL_APP_ID.length !== 44 /* 0x + 42 hex */) {
    throw new Error("Set ROFL_APP_ID in .env to the bytes21 value (0x + 42 hex chars)");
  }

  // Contract-enforced floor. Keep aligned with (or stricter than) the oracle
  // service's SOURCE_* settings so legitimate reports clear it.
  const expectedSourceChainId = BigInt(process.env.SOURCE_CHAIN_ID || "11155111");
  const minConfirmations = BigInt(process.env.MIN_CONFIRMATIONS || "12");
  const mandateFinalized = process.env.MANDATE_FINALIZED === "1";

  console.log(`Deploying HeaderReportOracle to network: ${hre.network.name}`);
  console.log(`Authorized ROFL app (bytes21): ${ROFL_APP_ID}`);
  console.log(`expectedSourceChainId:         ${expectedSourceChainId}`);
  console.log(`minConfirmations:              ${minConfirmations}`);
  console.log(`mandateFinalized:              ${mandateFinalized}`);

  const factory = await hre.ethers.getContractFactory("HeaderReportOracle");
  const oracle = await factory.deploy(
    ROFL_APP_ID,
    expectedSourceChainId,
    minConfirmations,
    mandateFinalized
  );
  await oracle.waitForDeployment();

  const address = await oracle.getAddress();
  console.log(`HeaderReportOracle deployed to: ${address}`);
  console.log(`Explorer: https://explorer.oasis.io/testnet/sapphire/address/${address}`);
  console.log(`\n👉 Set ORACLE_CONTRACT_ADDRESS in compose.yaml to: ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
