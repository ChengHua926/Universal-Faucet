// Offline validation of the submit-report path against the saved fixture:
//   1. reportToTuple encodes cleanly through the submitSignedHeader ABI
//   2. our digest recomputation matches the fixture reportDigest
//   3. ecrecover over that raw digest returns the fixture signer
// If all three pass, submitSignedHeader would accept a genuine report on-chain.

import { readFile } from "node:fs/promises";
import { ethers } from "ethers";

const FIXTURE =
  "../../../../crossroads_oracle/contracts/test/fixtures/header_report_fixture.json";

const SUBMIT_ABI = [
  "function submitSignedHeader((uint256 sourceChainId,uint256 blockNumber,bytes32 blockHash,bytes32 rlpHeaderHash,uint256 requiredConfirmations,uint256 observedConfirmations,uint256 quorumTip,bool requireFinalized,uint256 finalizedBlockNumber,bytes32 rpcVoteDigest,uint256 expiresAt,uint64 signerEpoch,bytes rlpHeader) r, bytes signature)",
];

const DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("CROSSROADS_HEADER_REPORT_V1"));

function reportToTuple(r) {
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

function recomputeDigest(sapphireChainId, oracleContract, r) {
  const enc = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "bytes32", "uint256", "address", "uint256", "uint256", "bytes32", "bytes32",
      "uint256", "uint256", "uint256", "bool", "uint256", "bytes32", "uint256", "uint64",
    ],
    [
      DOMAIN,
      BigInt(sapphireChainId),
      ethers.getAddress(oracleContract),
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
    ],
  );
  return ethers.keccak256(enc);
}

const f = JSON.parse(await readFile(new URL(FIXTURE, import.meta.url), "utf8"));
const r = f.report;

// 1. ABI encode
const iface = new ethers.Interface(SUBMIT_ABI);
const calldata = iface.encodeFunctionData("submitSignedHeader", [reportToTuple(r), f.signature]);
console.log(`1. reportToTuple ABI-encodes OK (${calldata.length} hex chars)`);

// 2. digest
const digest = recomputeDigest(f.sapphireChainId, f.oracleContract, r);
const digestOk = digest.toLowerCase() === f.reportDigest.toLowerCase();
console.log(`2. digest ${digest} ${digestOk ? "== fixture ✅" : "!= " + f.reportDigest + " ❌"}`);

// 3. signature -> raw ecrecover (no EIP-191 prefix, matching the contract)
const recovered = ethers.recoverAddress(digest, f.signature);
const sigOk = recovered.toLowerCase() === f.signer.toLowerCase();
console.log(`3. recovered ${recovered} ${sigOk ? "== fixture signer ✅" : "!= " + f.signer + " ❌"}`);

// header integrity (the contract also checks keccak(rlpHeader) == blockHash)
const headerOk = ethers.keccak256(r.rlpHeader).toLowerCase() === r.blockHash.toLowerCase();
console.log(`4. keccak(rlpHeader) == blockHash ${headerOk ? "✅" : "❌"}`);

process.exit(digestOk && sigOk && headerOk ? 0 : 1);
