import { ethers } from "ethers";

export interface AssetDeploymentConfig {
  name: string;
  symbol: string;
  withdrawalProofReward: bigint;
}

export interface PublicTestnetDeploymentConfig {
  ethereumSepolia: AssetDeploymentConfig;
  bitcoinTestnet: AssetDeploymentConfig;
  solanaTestnet: AssetDeploymentConfig & {
    oracleReportSigners: string[];
    oracleThreshold: bigint;
  };
}

export function defaultPublicTestnetDeploymentConfig(): PublicTestnetDeploymentConfig {
  return {
    ethereumSepolia: {
      name: "Crossroads Wrapped Sepolia ETH",
      symbol: "cWSEP",
      withdrawalProofReward: ethers.parseEther("0.01"),
    },
    bitcoinTestnet: {
      name: "Crossroads Wrapped Bitcoin Testnet",
      symbol: "cTBTC",
      withdrawalProofReward: 1_000n,
    },
    solanaTestnet: {
      name: "Crossroads Wrapped Solana Devnet",
      symbol: "cDSOL",
      withdrawalProofReward: 1_000n,
      oracleReportSigners: [],
      oracleThreshold: 0n,
    },
  };
}

export function publicTestnetDeploymentConfigFromEnv(
  env: NodeJS.ProcessEnv,
): PublicTestnetDeploymentConfig {
  const defaults = defaultPublicTestnetDeploymentConfig();
  const configuredSolanaSigners = parseAddressList(env.SOLANA_ORACLE_REPORT_SIGNERS);
  const privateKeySigner =
    configuredSolanaSigners.length === 0 && env.SOLANA_ORACLE_REPORT_PRIVATE_KEY
      ? [new ethers.Wallet(env.SOLANA_ORACLE_REPORT_PRIVATE_KEY).address]
      : [];
  const solanaSigners =
    configuredSolanaSigners.length > 0 ? configuredSolanaSigners : privateKeySigner;
  const solanaThreshold = hasValue(env.SOLANA_ORACLE_THRESHOLD)
    ? BigInt(env.SOLANA_ORACLE_THRESHOLD)
    : BigInt(solanaSigners.length);

  return {
    ethereumSepolia: {
      name: env.SEPOLIA_ASSET_NAME ?? defaults.ethereumSepolia.name,
      symbol: env.SEPOLIA_ASSET_SYMBOL ?? defaults.ethereumSepolia.symbol,
      withdrawalProofReward: readBigInt(
        env.SEPOLIA_WITHDRAWAL_PROOF_REWARD_WEI,
        defaults.ethereumSepolia.withdrawalProofReward,
      ),
    },
    bitcoinTestnet: {
      name: env.BITCOIN_TESTNET_ASSET_NAME ?? defaults.bitcoinTestnet.name,
      symbol: env.BITCOIN_TESTNET_ASSET_SYMBOL ?? defaults.bitcoinTestnet.symbol,
      withdrawalProofReward: readBigInt(
        env.BITCOIN_TESTNET_WITHDRAWAL_PROOF_REWARD_WEI,
        defaults.bitcoinTestnet.withdrawalProofReward,
      ),
    },
    solanaTestnet: {
      name: env.SOLANA_TESTNET_ASSET_NAME ?? defaults.solanaTestnet.name,
      symbol: env.SOLANA_TESTNET_ASSET_SYMBOL ?? defaults.solanaTestnet.symbol,
      withdrawalProofReward: readBigInt(
        env.SOLANA_TESTNET_WITHDRAWAL_PROOF_REWARD_WEI,
        defaults.solanaTestnet.withdrawalProofReward,
      ),
      oracleReportSigners: solanaSigners,
      oracleThreshold: solanaThreshold,
    },
  };
}

function parseAddressList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => ethers.getAddress(item))
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
}

function readBigInt(value: string | undefined, fallback: bigint): bigint {
  if (!hasValue(value)) {
    return fallback;
  }
  return BigInt(value);
}

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}
