// Shared helpers for the Crossroads EVM deposit demo (Sapphire testnet backend,
// Ethereum Sepolia source chain, block hashes provided by the TEE-signed
// HeaderReportOracle). Pure/ethers-only so it can be reused by both the deploy
// script and the end-to-end deposit script.

import { ethers } from "ethers";

import { getRlpUint, getTxInclusionProofFromRpc } from "../inclusion-proofs.js";

export const SAPPHIRE_TESTNET_CHAIN_ID = 23295;

// Source chain the demo proves deposits from. The live oracle below is already
// configured for exactly this chain (quorum 2, 12 confirmations).
export const SOURCE_CHAIN = { chainId: 11155111, name: "sepolia" };
export const DEFAULT_SOURCE_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

// Source chain derived from env, so the same deposit/proof flow can target ANY
// EVM chain (multi-chain). `SOURCE_CHAIN_ID` + `SOURCE_RPC_URLS` (comma-separated;
// the first is the read RPC) are the per-chain knobs; defaults to Sepolia for
// back-compat. The header/proof reconstruction is already chain-agnostic.
export function sourceChainFromEnv(): { chainId: number; name: string; rpcUrl: string } {
  const chainId = Number(process.env.SOURCE_CHAIN_ID ?? SOURCE_CHAIN.chainId);
  const rpcUrl =
    process.env.SOURCE_RPC_URLS?.split(",").map((s) => s.trim()).filter(Boolean)[0] ??
    process.env.SEPOLIA_RPC_URL ??
    DEFAULT_SOURCE_RPC_URL;
  const name =
    process.env.SOURCE_CHAIN_NAME ??
    (chainId === SOURCE_CHAIN.chainId ? "sepolia" : `chain-${chainId}`);
  return { chainId, name, rpcUrl };
}

// Live multi-chain HeaderReportOracle on Sapphire testnet: Sepolia-configured
// (sourceRpcQuorum 2, 12 confirmations, 3 RPC URLs), TEE signer 0xEd80…6308
// already registered. This is the one the POST ?config= path reads RPC config
// from. Reused by default so a deposit can be proven without redeploying or
// re-registering an oracle. Override with ORACLE_CONTRACT_ADDRESS to point at a
// freshly deployed one (see crossroads_oracle/contracts/deploy-header-oracle).
// (0x2e56…3bC6 is an older oracle WITHOUT the multi-chain sourceRpc* fields, so
// it only works via GET /v1/header without ?config=.)
export const DEFAULT_ORACLE_ADDRESS = "0xa852946E2FfEb92FB8f06a8272cCE5323eCFE133";

// ROFL Port Proxy URL of the oracle's HTTP API. The machine is ephemeral; if
// this 404s/refuses, get the current URL via `oasis rofl machine show` and pass
// CROSSROADS_ORACLE_API.
export const DEFAULT_ORACLE_API = "https://p8080.m1561.test-proxy-b.rofl.app";

// Minimal ABI: the report-submission entrypoint plus the views we read.
export const HEADER_REPORT_ORACLE_ABI = [
  "function submitSignedHeader((uint256 sourceChainId,uint256 blockNumber,bytes32 blockHash,bytes32 rlpHeaderHash,uint256 requiredConfirmations,uint256 observedConfirmations,uint256 quorumTip,bool requireFinalized,uint256 finalizedBlockNumber,bytes32 rpcVoteDigest,uint256 expiresAt,uint64 signerEpoch,bytes rlpHeader) r, bytes signature)",
  "function getBlockHash(uint256 blockNumber) view returns (bytes32)",
  "function blockHashes(uint256) view returns (bytes32)",
  "function headerSigner() view returns (address)",
  "function headerSignerEpoch() view returns (uint64)",
  "function latestBlockNumber() view returns (uint256)",
  "function expectedSourceChainId() view returns (uint256)",
  "function minConfirmations() view returns (uint256)",
];

export interface TeeHeaderReport {
  sourceChainId: number;
  blockNumber: number;
  blockHash: string;
  rlpHeaderHash: string;
  rlpHeader: string;
  requiredConfirmations: number;
  observedConfirmations: number;
  quorumTip: number;
  requireFinalized: boolean;
  finalizedBlockNumber: number | null;
  rpcVoteDigest: string;
  signer: string;
  signerEpoch: number;
  oracleContractAddress: string;
  sapphireChainId: number;
  reportDigest: string;
  signature: string;
  expiresAt: number;
}

// The destination/encumbered account id is the source-chain address right-padded
// into bytes32, matching BridgeOracle._accountIdFromAddress.
export function accountIdFromAddress(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

// POST /v1/header { oracle_contract, block_number? } -> signed report JSON.
// Omitting block_number asks for the newest quorum-confirmed block.
export async function fetchTeeReport(
  apiUrl: string,
  oracleContract: string,
  blockNumber?: number,
): Promise<TeeHeaderReport> {
  const body: Record<string, unknown> = { oracle_contract: oracleContract };
  if (blockNumber != null) body.block_number = blockNumber;
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/header`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`oracle API ${res.status} ${res.statusText}: ${text}`);
  }
  return JSON.parse(text) as TeeHeaderReport;
}

// Poll the oracle API until it returns a signed report for `blockNumber` (i.e.
// the block has reached the contract's confirmation floor). Retries swallow the
// "not yet confirmed" 4xx/5xx the service returns while the block is too shallow.
export async function waitForTeeReport(
  apiUrl: string,
  oracleContract: string,
  blockNumber: number,
  { attempts = 60, intervalMs = 10_000 }: { attempts?: number; intervalMs?: number } = {},
): Promise<TeeHeaderReport> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchTeeReport(apiUrl, oracleContract, blockNumber);
    } catch (err) {
      lastErr = err;
      process.stdout.write(
        `\r  waiting for TEE report (block ${blockNumber}) … attempt ${i + 1}/${attempts}`,
      );
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  process.stdout.write("\n");
  throw new Error(`gave up waiting for TEE report on block ${blockNumber}: ${String(lastErr)}`);
}

// Map the report JSON to the HeaderReport tuple in struct field order. null
// finalizedBlockNumber -> 0 to match what the TEE signed (int(... or 0)).
export function reportToTuple(r: TeeHeaderReport): unknown[] {
  return [
    BigInt(r.sourceChainId),
    BigInt(r.blockNumber),
    r.blockHash,
    r.rlpHeaderHash,
    BigInt(r.requiredConfirmations),
    BigInt(r.observedConfirmations),
    BigInt(r.quorumTip),
    Boolean(r.requireFinalized),
    BigInt(r.finalizedBlockNumber ?? 0),
    r.rpcVoteDigest,
    BigInt(r.expiresAt),
    BigInt(r.signerEpoch),
    r.rlpHeader,
  ];
}

// ABI-encode the TransactionProof struct the BridgeOracle/ProvethVerifier expect.
export function encodeEvmTransactionProof(proof: {
  rlpBlockHeader: string;
  transactionIndexRlp: string;
  transactionProofStack: string;
}): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(bytes rlpBlockHeader, bytes transactionIndexRlp, bytes transactionProofStack)"],
    [proof],
  );
}

// Build the ABI-encoded inclusion proof for a source-chain tx using only
// eth_getBlockByNumber (no debug_getRawBlock). Self-checked against the header.
export async function buildDepositProof(
  sourceProvider: ethers.JsonRpcProvider,
  blockNumber: number,
  txIndex: number,
): Promise<string> {
  const { rlpBlockHeader, proof } = await getTxInclusionProofFromRpc(
    sourceProvider as never,
    blockNumber,
    txIndex,
  );
  return encodeEvmTransactionProof({
    rlpBlockHeader,
    transactionIndexRlp: getRlpUint(txIndex),
    transactionProofStack: ethers.encodeRlp(proof.map((node) => ethers.decodeRlp(node))),
  });
}
