import { expect } from "chai";
import { network } from "hardhat";
import fs from "node:fs";
import path from "node:path";

import {
  deployPublicTestnetContracts,
  type PublicTestnetDeployment,
} from "../../scripts/public-testnet-deploy.js";
import { publicTestnetDeploymentConfigFromEnv } from "../../scripts/public-testnet-config.js";

const { ethers } = await network.connect();

const DEFAULT_DEPLOYMENT_PATH = path.resolve(
  process.cwd(),
  "tmp/public-testnet-deployment.json",
);

function deploymentArtifactPath(): string {
  const fromEnv = process.env.PUBLIC_TESTNET_DEPLOYMENT_PATH;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return path.resolve(fromEnv);
  }
  return DEFAULT_DEPLOYMENT_PATH;
}

function writeArtifact(deployment: PublicTestnetDeployment): string {
  const artifactPath = deploymentArtifactPath();
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(deployment, null, 2)}\n`);
  return artifactPath;
}

describe("public testnet deployment", function () {
  it("deploys the Crossroads stacks for Sepolia, Bitcoin testnet, and Solana devnet", async () => {
    const [deployer] = await ethers.getSigners();
    const config = publicTestnetDeploymentConfigFromEnv(process.env);

    const deployment = await deployPublicTestnetContracts(ethers, config);

    expect(deployment.target.deployer.toLowerCase()).to.equal(deployer.address.toLowerCase());
    expect(BigInt(deployment.target.chainId)).to.equal(
      (await ethers.provider.getNetwork()).chainId,
    );

    const sepolia = deployment.sourceChains.ethereumSepolia;
    const sepoliaAsset = await ethers.getContractAt("CrossroadsAssetContract", sepolia.asset);
    const sepoliaBridgeOracle = await ethers.getContractAt("BridgeOracle", sepolia.bridgeOracle);
    expect((await sepoliaAsset.bridgeOracle()).toLowerCase()).to.equal(
      sepolia.bridgeOracle.toLowerCase(),
    );
    expect(await sepoliaAsset.signatureScheme()).to.equal(1n);
    expect(await sepoliaAsset.name()).to.equal(config.ethereumSepolia.name);
    expect(await sepoliaAsset.symbol()).to.equal(config.ethereumSepolia.symbol);
    expect(await sepoliaAsset.withdrawalProofReward()).to.equal(
      config.ethereumSepolia.withdrawalProofReward,
    );
    expect((await sepoliaBridgeOracle.blockHashOracle()).toLowerCase()).to.equal(
      sepolia.blockHashOracle!.toLowerCase(),
    );

    const bitcoin = deployment.sourceChains.bitcoinTestnet;
    const bitcoinAsset = await ethers.getContractAt("CrossroadsAssetContract", bitcoin.asset);
    const bitcoinBridgeOracle = await ethers.getContractAt(
      "BitcoinBridgeOracle",
      bitcoin.bridgeOracle,
    );
    const bitcoinBlockHashOracle = await ethers.getContractAt(
      "CentralizedBitcoinBlockHashOracle",
      bitcoin.blockHashOracle!,
    );
    expect((await bitcoinAsset.bridgeOracle()).toLowerCase()).to.equal(
      bitcoin.bridgeOracle.toLowerCase(),
    );
    expect(await bitcoinAsset.signatureScheme()).to.equal(1n);
    expect(await bitcoinAsset.name()).to.equal(config.bitcoinTestnet.name);
    expect(await bitcoinAsset.symbol()).to.equal(config.bitcoinTestnet.symbol);
    expect(await bitcoinAsset.withdrawalProofReward()).to.equal(
      config.bitcoinTestnet.withdrawalProofReward,
    );
    expect((await bitcoinBridgeOracle.blockHashOracle()).toLowerCase()).to.equal(
      bitcoin.blockHashOracle!.toLowerCase(),
    );
    expect((await bitcoinBlockHashOracle.owner()).toLowerCase()).to.equal(
      deployer.address.toLowerCase(),
    );

    const solana = deployment.sourceChains.solanaTestnet;
    const solanaAsset = await ethers.getContractAt("CrossroadsAssetContract", solana.asset);
    expect((await solanaAsset.bridgeOracle()).toLowerCase()).to.equal(
      solana.bridgeOracle.toLowerCase(),
    );
    expect(await solanaAsset.signatureScheme()).to.equal(2n);
    expect(await solanaAsset.name()).to.equal(config.solanaTestnet.name);
    expect(await solanaAsset.symbol()).to.equal(config.solanaTestnet.symbol);
    expect(await solanaAsset.withdrawalProofReward()).to.equal(
      config.solanaTestnet.withdrawalProofReward,
    );

    const artifactPath = writeArtifact(deployment);
    console.log(`public testnet deployment written to ${artifactPath}`);
  });
});
