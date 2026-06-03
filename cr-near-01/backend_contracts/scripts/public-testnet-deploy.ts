import type { BaseContract, ContractFactory, ContractTransactionResponse } from "ethers";

import type { PublicTestnetDeploymentConfig } from "./public-testnet-config.js";

type ContractFactoryOptions = Parameters<HardhatEthersLike["getContractFactory"]>[1];

export interface HardhatEthersLike {
  getSigners(): Promise<Array<{ address: string }>>;
  getContractFactory(name: string, options?: unknown): Promise<ContractFactory>;
  provider: {
    getNetwork(): Promise<{ chainId: bigint }>;
  };
}

export interface ChainDeployment {
  asset: string;
  bridgeOracle: string;
  blockHashOracle?: string;
  libraries?: Record<string, string>;
  helpers?: Record<string, string>;
}

export interface PublicTestnetDeployment {
  target: {
    chainId: string;
    deployer: string;
  };
  sourceChains: {
    ethereumSepolia: ChainDeployment;
    bitcoinTestnet: ChainDeployment;
    solanaTestnet: ChainDeployment & {
      oracleReportSigners: string[];
      oracleThreshold: string;
    };
  };
}

export async function deployPublicTestnetContracts(
  ethers: HardhatEthersLike,
  config: PublicTestnetDeploymentConfig,
): Promise<PublicTestnetDeployment> {
  const [deployer] = await ethers.getSigners();
  const owner = deployer.address;

  const ethereumSepolia = await deployEthereumSepoliaStack(ethers, owner, config.ethereumSepolia);
  const bitcoinTestnet = await deployBitcoinTestnetStack(ethers, owner, config.bitcoinTestnet);
  const solanaTestnet = await deploySolanaTestnetStack(ethers, config.solanaTestnet);
  const network = await ethers.provider.getNetwork();

  return {
    target: {
      chainId: network.chainId.toString(),
      deployer: owner,
    },
    sourceChains: {
      ethereumSepolia,
      bitcoinTestnet,
      solanaTestnet,
    },
  };
}

async function deployEthereumSepoliaStack(
  ethers: HardhatEthersLike,
  owner: string,
  asset: PublicTestnetDeploymentConfig["ethereumSepolia"],
): Promise<ChainDeployment> {
  const blockHashOracle = await deploy(ethers, "CentralizedEvmBlockHashOracle", [owner]);
  const provethVerifier = await deploy(ethers, "ProvethVerifier", []);
  const txSerializer = await deploy(ethers, "TransactionSerializer", []);
  const bridgeOracle = await deploy(
    ethers,
    "BridgeOracle",
    [await addressOf(blockHashOracle), await addressOf(provethVerifier)],
    {
      libraries: {
        TransactionSerializer: await addressOf(txSerializer),
      },
    },
  );
  const assetContract = await deploy(ethers, "CrossroadsAssetContract", [
    asset.name,
    asset.symbol,
    await addressOf(bridgeOracle),
    1,
    asset.withdrawalProofReward,
  ]);

  return {
    asset: await addressOf(assetContract),
    bridgeOracle: await addressOf(bridgeOracle),
    blockHashOracle: await addressOf(blockHashOracle),
    helpers: {
      provethVerifier: await addressOf(provethVerifier),
      transactionSerializer: await addressOf(txSerializer),
    },
  };
}

async function deployBitcoinTestnetStack(
  ethers: HardhatEthersLike,
  owner: string,
  asset: PublicTestnetDeploymentConfig["bitcoinTestnet"],
): Promise<ChainDeployment> {
  const blockHashOracle = await deploy(ethers, "CentralizedBitcoinBlockHashOracle", [owner]);
  const bridgeOracle = await deploy(ethers, "BitcoinBridgeOracle", [
    await addressOf(blockHashOracle),
  ]);
  const assetContract = await deploy(ethers, "CrossroadsAssetContract", [
    asset.name,
    asset.symbol,
    await addressOf(bridgeOracle),
    1,
    asset.withdrawalProofReward,
  ]);

  return {
    asset: await addressOf(assetContract),
    bridgeOracle: await addressOf(bridgeOracle),
    blockHashOracle: await addressOf(blockHashOracle),
  };
}

async function deploySolanaTestnetStack(
  ethers: HardhatEthersLike,
  asset: PublicTestnetDeploymentConfig["solanaTestnet"],
): Promise<PublicTestnetDeployment["sourceChains"]["solanaTestnet"]> {
  const solanaLib = await deploy(ethers, "SolanaTransactionLib", []);
  const libraries = { SolanaTransactionLib: await addressOf(solanaLib) };
  const bridgeOracle = await deploy(
    ethers,
    "SolanaBridgeOracle",
    [asset.oracleReportSigners, asset.oracleThreshold],
    { libraries },
  );
  const assetContract = await deploy(ethers, "CrossroadsAssetContract", [
    asset.name,
    asset.symbol,
    await addressOf(bridgeOracle),
    2,
    asset.withdrawalProofReward,
  ]);

  return {
    asset: await addressOf(assetContract),
    bridgeOracle: await addressOf(bridgeOracle),
    libraries,
    oracleReportSigners: asset.oracleReportSigners,
    oracleThreshold: asset.oracleThreshold.toString(),
  };
}

async function deploy(
  ethers: HardhatEthersLike,
  name: string,
  args: unknown[],
  options?: ContractFactoryOptions,
): Promise<BaseContract> {
  const factory = await ethers.getContractFactory(name, options);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  await waitForDeploymentReceipt(contract);
  return contract;
}

async function waitForDeploymentReceipt(contract: BaseContract): Promise<void> {
  const deployment = contract.deploymentTransaction();
  if (deployment !== null) {
    await (deployment as ContractTransactionResponse).wait();
  }
}

async function addressOf(contract: BaseContract): Promise<string> {
  return contract.getAddress();
}
