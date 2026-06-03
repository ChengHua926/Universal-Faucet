const hre = require("hardhat");

async function main() {
  // The 21-byte form of our ROFL app ID (bech32-decoded from rofl1...).
  // This gets baked into the contract as the only authorized writer.
  const ROFL_APP_ID = process.env.ROFL_APP_ID;
  if (!ROFL_APP_ID || ROFL_APP_ID.length !== 44 /* 0x + 42 hex */) {
    throw new Error("Set ROFL_APP_ID in .env to the bytes21 value (0x + 42 hex chars)");
  }

  console.log(`Deploying BlockHashOracle to network: ${hre.network.name}`);
  console.log(`Authorized ROFL app (bytes21): ${ROFL_APP_ID}`);

  const factory = await hre.ethers.getContractFactory("BlockHashOracle");

  // Pass the app ID to the constructor.
  const oracle = await factory.deploy(ROFL_APP_ID);
  await oracle.waitForDeployment();

  const address = await oracle.getAddress();
  console.log(`BlockHashOracle deployed to: ${address}`);
  console.log(
    `Explorer: https://explorer.oasis.io/testnet/sapphire/address/${address}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
