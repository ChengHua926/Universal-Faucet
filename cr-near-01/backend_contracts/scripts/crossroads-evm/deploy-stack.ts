// Deploy the Crossroads EVM bridge stack on Sapphire testnet, fed by the
// TEE-signed HeaderReportOracle (Model B) instead of an owner-operated oracle:
//
//   CrossroadsAssetContract  (the wrapped-asset ledger; mints on deposit)
//        -> BridgeOracle      (verifyDeposit: inclusion proof + block hash)
//             -> HeaderReportOracle (existing, on Sapphire; getBlockHash)
//             -> ProvethVerifier    (tx Merkle inclusion proofs)
//
// The oracle is NOT deployed here — we point at an already-deployed one (default:
// the live Sepolia-configured oracle; override with ORACLE_CONTRACT_ADDRESS).
// Deploy the oracle itself from crossroads_oracle/contracts (deploy-header-oracle).
//
//   SAPPHIRE_PRIVATE_KEY=0x...   (funded with testnet ROSE) \
//   [ORACLE_CONTRACT_ADDRESS=0x...] [ENC_ACCOUNT_ADDRESS=0x...] \
//   [SEPOLIA_PRIVATE_KEY=0x...]   (used to derive the default encumbered address) \
//     npx hardhat run scripts/crossroads-evm/deploy-stack.ts --network sapphireTestnet

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ethers as ethersLib } from "ethers";
import { network } from "hardhat";

import {
  DEFAULT_ORACLE_ADDRESS,
  HEADER_REPORT_ORACLE_ABI,
  SOURCE_CHAIN,
  accountIdFromAddress,
} from "./lib.js";

const { ethers } = await network.connect();

async function main() {
  const oracleAddress = ethersLib.getAddress(
    process.env.ORACLE_CONTRACT_ADDRESS ?? DEFAULT_ORACLE_ADDRESS,
  );

  // The deposit destination: a source-chain (Sepolia) address registered as an
  // encumbered account. In production this is committee-controlled; for the demo
  // it defaults to the depositor's own address (self-deposit, no funds lost).
  let encAddress = process.env.ENC_ACCOUNT_ADDRESS;
  if (!encAddress && process.env.SEPOLIA_PRIVATE_KEY) {
    encAddress = new ethersLib.Wallet(process.env.SEPOLIA_PRIVATE_KEY).address;
  }
  if (!encAddress) {
    throw new Error("Set ENC_ACCOUNT_ADDRESS (or SEPOLIA_PRIVATE_KEY to derive it)");
  }
  encAddress = ethersLib.getAddress(encAddress);
  const encId = accountIdFromAddress(encAddress);

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`Network:  ${net.name} (chainId ${net.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Oracle:   ${oracleAddress}`);

  // Sanity-check the oracle before building on top of it.
  const oracle = new ethers.Contract(oracleAddress, HEADER_REPORT_ORACLE_ABI, deployer);
  const expectedSrc = await oracle.expectedSourceChainId();
  const signer = await oracle.headerSigner();
  console.log(`  oracle.expectedSourceChainId = ${expectedSrc}`);
  console.log(`  oracle.headerSigner          = ${signer}`);
  if (expectedSrc !== BigInt(SOURCE_CHAIN.chainId)) {
    console.warn(
      `  ⚠ oracle source chain ${expectedSrc} != demo source ${SOURCE_CHAIN.chainId} (Sepolia)`,
    );
  }
  if (signer === ethersLib.ZeroAddress) {
    console.warn(
      "  ⚠ headerSigner is unset — make one ?config= request to the oracle API so the TEE auto-registers (Option A) before submitting reports.",
    );
  }

  const proveth = await deploy("ProvethVerifier", []);
  const txSer = await deploy("TransactionSerializer", []);
  const bridge = await deploy("BridgeOracle", [oracleAddress, await proveth.getAddress()], {
    libraries: { TransactionSerializer: await txSer.getAddress() },
  });
  const asset = await deploy(
    "CrossroadsAssetContract",
    [
      "Crossroads Sepolia ETH",
      "crsETH",
      await bridge.getAddress(),
      1, // SCHEME_ECDSA_SECP256K1
      0, // withdrawalProofReward (withdrawals out of scope until the committee exists)
    ],
    undefined,
    // Sapphire's eth_estimateGas underestimates this creation; set it explicitly
    // (mirrors the cr-near evm.ts test) so the deploy doesn't run out of gas.
    { gasLimit: 12_000_000 },
  );

  // Register the encumbered account so deposits to it are accepted.
  console.log(`Registering encumbered account ${encAddress}`);
  await (await (asset as any).registerEncumberedAccount(encId)).wait();

  const deployment = {
    network: { name: net.name, chainId: net.chainId.toString() },
    deployer: deployer.address,
    oracle: oracleAddress,
    provethVerifier: await proveth.getAddress(),
    transactionSerializer: await txSer.getAddress(),
    bridgeOracle: await bridge.getAddress(),
    asset: {
      address: await asset.getAddress(),
      name: "Crossroads Sepolia ETH",
      symbol: "crsETH",
    },
    encAccount: { address: encAddress, id: encId },
    source: { chain: "ethereum-sepolia", chainId: SOURCE_CHAIN.chainId },
  };

  const outPath =
    process.env.CROSSROADS_EVM_DEPLOYMENT_PATH ??
    `deployments/crossroads-evm-sapphire-${net.chainId}.json`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(deployment, null, 2)}\n`);

  console.log("\nDeployed Crossroads EVM stack:");
  console.log(JSON.stringify(deployment, null, 2));
  console.log(`\nWrote ${outPath}`);
}

async function deploy(name: string, args: unknown[], options?: unknown, overrides?: object) {
  const factory = await ethers.getContractFactory(name, options as never);
  const deployArgs = overrides ? [...args, overrides] : args;
  const contract = await factory.deploy(...(deployArgs as never[]));
  await contract.waitForDeployment();
  const tx = contract.deploymentTransaction();
  if (tx) await tx.wait();
  console.log(`  ${name.padEnd(24)} ${await contract.getAddress()}`);
  return contract;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
