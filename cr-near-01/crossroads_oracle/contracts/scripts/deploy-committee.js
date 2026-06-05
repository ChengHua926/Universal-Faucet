// Deploy a persistent SigningCommittee (James's EIP-712 design) on Sapphire.
// Pass bytes32(0) as the seed so the enclave generates the confidential root with
// secure randomness (trustless — no deployer backdoor). Use the printed address
// as COMMITTEE_ADDRESS for the withdrawal demo.
//
//   PRIVATE_KEY=0x...(funded ROSE) \
//     npx hardhat run scripts/deploy-committee.js --network sapphire-testnet

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address);

  const committee = await (await ethers.getContractFactory("SigningCommittee")).deploy(
    ethers.ZeroHash, // enclave-generated root seed
    { gasLimit: 6_000_000 },
  );
  await committee.waitForDeployment();
  console.log("SigningCommittee:", await committee.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
