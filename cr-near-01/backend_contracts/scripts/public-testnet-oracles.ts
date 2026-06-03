import { readFile } from "node:fs/promises";

import bs58 from "bs58";
import { ethers } from "ethers";
import { network } from "hardhat";

import type { PublicTestnetDeployment } from "./public-testnet-deploy.js";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface SolanaOracleContract {
  oracleThreshold(): Promise<bigint>;
  oracleReportDigest(signatureBytes: string): Promise<string>;
}

interface BitcoinRpcConfig {
  url: string;
  username?: string;
  password?: string;
}

const { ethers: hardhatEthers } = await network.connect();

async function main(): Promise<void> {
  const mode = process.env.ORACLE_MODE ?? process.argv[2];
  if (!mode) {
    throw new Error(
      "Set ORACLE_MODE to ethereum-sepolia, bitcoin-testnet, solana-finality, or solana-nonce",
    );
  }

  const deployment = await loadDeployment();
  switch (mode) {
    case "ethereum-sepolia":
      await runLoop(() => syncEthereumSepoliaBlockHashes(deployment));
      break;
    case "bitcoin-testnet":
      await runLoop(() => syncBitcoinTestnetBlockHashes(deployment));
      break;
    case "solana-finality":
      await runLoop(() => submitFinalizedSolanaTransactions(deployment));
      break;
    case "solana-nonce":
      await runLoop(() => syncSolanaDurableNonce(deployment));
      break;
    default:
      throw new Error(`Unknown ORACLE_MODE ${mode}`);
  }
}

async function syncEthereumSepoliaBlockHashes(deployment: PublicTestnetDeployment): Promise<void> {
  const source = new ethers.JsonRpcProvider(required("SEPOLIA_RPC_URL"));
  const confirmations = Number(process.env.SEPOLIA_ORACLE_CONFIRMATIONS ?? "12");
  const batchSize = Number(process.env.ORACLE_BATCH_SIZE ?? "12");
  const latest = await source.getBlockNumber();
  const end = Math.max(0, latest - confirmations);
  const start = Math.max(0, end - batchSize + 1);
  const blockNumbers: bigint[] = [];
  const blockHashes: string[] = [];

  for (let blockNumber = start; blockNumber <= end; blockNumber++) {
    const block = await source.getBlock(blockNumber);
    if (block?.hash) {
      blockNumbers.push(BigInt(blockNumber));
      blockHashes.push(block.hash);
    }
  }
  if (blockNumbers.length === 0) {
    return;
  }

  const oracle = await hardhatEthers.getContractAt(
    "CentralizedEvmBlockHashOracle",
    deployment.sourceChains.ethereumSepolia.blockHashOracle!,
  );
  await (await oracle.setBlockHashes(blockNumbers, blockHashes)).wait();
  console.log(`reported ${blockNumbers.length} Sepolia block hashes through height ${end}`);
}

async function syncBitcoinTestnetBlockHashes(deployment: PublicTestnetDeployment): Promise<void> {
  const rpc = new BitcoinRpc(bitcoinRpcConfigFromEnv());
  const confirmations = Number(process.env.BITCOIN_TESTNET_ORACLE_CONFIRMATIONS ?? "6");
  const batchSize = Number(process.env.ORACLE_BATCH_SIZE ?? "12");
  const best = await rpc.call<number>("getblockcount", []);
  const end = Math.max(0, best - confirmations);
  const start = Math.max(0, end - batchSize + 1);
  const heights: bigint[] = [];
  const hashes: string[] = [];

  for (let height = start; height <= end; height++) {
    const displayHash = await rpc.call<string>("getblockhash", [height]);
    const rawHeader = await rpc.call<string>("getblockheader", [displayHash, false]);
    heights.push(BigInt(height));
    hashes.push(doubleSha256(`0x${rawHeader}`));
  }
  if (heights.length === 0) {
    return;
  }

  const oracle = await hardhatEthers.getContractAt(
    "CentralizedBitcoinBlockHashOracle",
    deployment.sourceChains.bitcoinTestnet.blockHashOracle!,
  );
  await (await oracle.setBlockHashes(heights, hashes)).wait();
  console.log(`reported ${heights.length} Bitcoin testnet block hashes through height ${end}`);
}

async function submitFinalizedSolanaTransactions(
  deployment: PublicTestnetDeployment,
): Promise<void> {
  const signatures = await readSolanaSignatures();
  if (signatures.length === 0) {
    return;
  }

  const web3 = await import("@solana/web3.js");
  const connection = new web3.Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "finalized",
  );
  const oracle = await hardhatEthers.getContractAt(
    "SolanaBridgeOracle",
    deployment.sourceChains.solanaTestnet.bridgeOracle,
  );

  for (const signature of signatures) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (status.value?.confirmationStatus !== "finalized" || status.value.err !== null) {
      console.log(`skipping non-finalized Solana signature ${signature}`);
      continue;
    }

    const signatureBytes = ethers.hexlify(bs58.decode(signature));
    const reportSignatures = await solanaOracleReportSignatures(oracle, signatureBytes);
    await (await oracle.submitFinalizedTransaction(signatureBytes, reportSignatures)).wait();
    console.log(`reported finalized Solana transaction ${signature}`);
  }
}

async function syncSolanaDurableNonce(deployment: PublicTestnetDeployment): Promise<void> {
  const web3 = await import("@solana/web3.js");
  const connection = new web3.Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "finalized",
  );
  const primary = pubkeyBytes32(required("SOLANA_PRIMARY_ACCOUNT"));
  const primaryPubkey = new web3.PublicKey(required("SOLANA_PRIMARY_ACCOUNT"));
  const nonceAccount = new web3.PublicKey(required("SOLANA_NONCE_ACCOUNT"));
  const accountInfo = await connection.getAccountInfo(nonceAccount, "finalized");
  if (accountInfo === null) {
    throw new Error(`Solana nonce account ${nonceAccount.toBase58()} not found`);
  }

  const decodedNonce = web3.NonceAccount.fromAccountData(accountInfo.data);
  if (!decodedNonce.authorizedPubkey.equals(primaryPubkey)) {
    throw new Error(
      `Solana nonce account ${nonceAccount.toBase58()} authority ${decodedNonce.authorizedPubkey.toBase58()} does not match primary ${primaryPubkey.toBase58()}`,
    );
  }
  const nonce = ethers.hexlify(bs58.decode(decodedNonce.nonce));
  const nonceAccountBytes = pubkeyBytes32(nonceAccount.toBase58());
  const oracle = await hardhatEthers.getContractAt(
    "SolanaBridgeOracle",
    deployment.sourceChains.solanaTestnet.bridgeOracle,
  );
  const configuredNonceAccount = await oracle.durableNonceAccountForPrimary(primary);

  if (configuredNonceAccount === ethers.ZeroHash) {
    await (await oracle.setDurableNonce(primary, nonceAccountBytes, nonce)).wait();
    console.log(`configured Solana durable nonce ${decodedNonce.nonce}`);
    return;
  }

  const currentNonce = await oracle.currentDurableNonceForPrimary(primary);
  if (currentNonce.toLowerCase() !== nonce.toLowerCase()) {
    await (await oracle.advanceDurableNonce(primary, nonce)).wait();
    console.log(`advanced Solana durable nonce to ${decodedNonce.nonce}`);
  }
}

async function solanaOracleReportSignatures(
  oracle: SolanaOracleContract,
  signatureBytes: string,
): Promise<string[]> {
  const threshold = await oracle.oracleThreshold();
  if (threshold === 0n) {
    return [];
  }

  const privateKeys = readList(required("SOLANA_ORACLE_REPORT_PRIVATE_KEY"));
  const digest = await oracle.oracleReportDigest(signatureBytes);
  const signatures = await Promise.all(
    privateKeys.map((privateKey) =>
      new ethers.Wallet(privateKey).signMessage(ethers.getBytes(digest)),
    ),
  );
  signatures.sort((a, b) =>
    recoverReportSigner(digest, a).localeCompare(recoverReportSigner(digest, b)),
  );
  return signatures;
}

function recoverReportSigner(digest: string, signature: string): string {
  return ethers.verifyMessage(ethers.getBytes(digest), signature).toLowerCase();
}

async function readSolanaSignatures(): Promise<string[]> {
  const configured = readList(process.env.SOLANA_TRANSACTION_SIGNATURES ?? "");
  if (configured.length > 0) {
    return configured;
  }
  const path = process.env.SOLANA_TRANSACTION_SIGNATURES_FILE;
  if (!path) {
    return [];
  }
  return readList(await readFile(path, "utf8"));
}

async function runLoop(task: () => Promise<void>): Promise<void> {
  const once = process.env.ORACLE_ONCE !== "0";
  const intervalMs = Number(process.env.ORACLE_POLL_INTERVAL_MS ?? "30000");
  do {
    await task();
    if (once) {
      return;
    }
    await sleep(intervalMs);
  } while (true);
}

async function loadDeployment(): Promise<PublicTestnetDeployment> {
  const path = required("PUBLIC_TESTNET_DEPLOYMENT_PATH");
  return JSON.parse(await readFile(path, "utf8")) as PublicTestnetDeployment;
}

function bitcoinRpcConfigFromEnv(): BitcoinRpcConfig {
  const url = required("BITCOIN_TESTNET_RPC_URL");
  return {
    url,
    username: optional("BITCOIN_TESTNET_RPC_USER"),
    password: optional("BITCOIN_TESTNET_RPC_PASSWORD"),
  };
}

class BitcoinRpc {
  private nextId = 1;

  constructor(private readonly config: BitcoinRpcConfig) {}

  async call<T extends Json>(method: string, params: Json[]): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.username !== undefined || this.config.password !== undefined) {
      headers.authorization =
        "Basic " +
        Buffer.from(`${this.config.username ?? ""}:${this.config.password ?? ""}`).toString(
          "base64",
        );
    }
    const response = await fetch(this.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: this.nextId++, method, params }),
    });
    if (!response.ok) {
      throw new Error(
        `Bitcoin RPC ${method} failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as { result: T; error?: { message: string } | null };
    if (payload.error) {
      throw new Error(`Bitcoin RPC ${method} failed: ${payload.error.message}`);
    }
    return payload.result;
  }
}

function doubleSha256(data: string): string {
  return ethers.sha256(ethers.sha256(data));
}

function pubkeyBytes32(publicKey: string): string {
  const bytes = bs58.decode(publicKey);
  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte Solana public key, got ${bytes.length} bytes`);
  }
  return ethers.hexlify(bytes);
}

function readList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
