const hre = require("hardhat");
const { bech32 } = require("bech32");

function roflAppIDToBytes21(value) {
  if (!value) {
    throw new Error("Set ROFL_APP_ID to either rofl1... or 0x + 42 hex chars");
  }

  if (/^0x[0-9a-fA-F]{42}$/.test(value)) {
    return value.toLowerCase();
  }

  const decoded = bech32.decode(value);
  if (decoded.prefix !== "rofl") {
    throw new Error(`Expected ROFL app id prefix 'rofl', got '${decoded.prefix}'`);
  }

  const bytes = Buffer.from(bech32.fromWords(decoded.words));
  if (bytes.length !== 21) {
    throw new Error(`Expected 21-byte ROFL app id, got ${bytes.length} bytes`);
  }

  return `0x${bytes.toString("hex")}`;
}

async function main() {
  const roflAppID = roflAppIDToBytes21(process.env.ROFL_APP_ID);

  console.log(`Deploying CrossroadsHeaderOracle to ${hre.network.name}`);
  console.log(`Authorized ROFL app: ${roflAppID}`);

  const factory = await hre.ethers.getContractFactory("CrossroadsHeaderOracle");
  const oracle = await factory.deploy(roflAppID);
  await oracle.waitForDeployment();

  const address = await oracle.getAddress();
  console.log(`CrossroadsHeaderOracle deployed to: ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
