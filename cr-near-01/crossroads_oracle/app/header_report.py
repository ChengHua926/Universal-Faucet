import time
from typing import Any

from eth_abi import encode
from eth_keys import keys
from eth_keys.constants import SECPK1_N
from eth_utils import keccak, to_canonical_address
from web3 import Web3

from .source_rpc import ConfirmedHeaderResult, RpcVote

HEADER_REPORT_DOMAIN_TEXT = "CROSSROADS_HEADER_REPORT_V1"
HEADER_REPORT_DOMAIN = keccak(text=HEADER_REPORT_DOMAIN_TEXT)
ZERO_BYTES32 = b"\x00" * 32


def build_signed_header_report(
    result: ConfirmedHeaderResult,
    private_key: str,
    signer_address: str,
    signer_epoch: int,
    oracle_contract_address: str,
    sapphire_chain_id: int,
    ttl_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    now = int(time.time()) if now is None else int(now)
    expires_at = now + int(ttl_seconds)
    rlp_header_hash = keccak(result.rlp_header)
    rpc_vote_digest = build_rpc_vote_digest(result.votes)
    report_digest = build_report_digest(
        sapphire_chain_id=sapphire_chain_id,
        oracle_contract_address=oracle_contract_address,
        source_chain_id=result.source_chain_id,
        block_number=result.block_number,
        block_hash=result.block_hash,
        rlp_header_hash=rlp_header_hash,
        required_confirmations=result.required_confirmations,
        observed_confirmations=result.observed_confirmations,
        quorum_tip=result.quorum_tip,
        require_finalized=result.require_finalized,
        finalized_block_number=result.finalized_block_number,
        rpc_vote_digest=rpc_vote_digest,
        expires_at=expires_at,
        signer_epoch=signer_epoch,
    )
    signature = sign_digest(private_key, report_digest)

    return {
        "version": 1,
        "domain": HEADER_REPORT_DOMAIN_TEXT,
        "domainHash": _hex(HEADER_REPORT_DOMAIN),
        "sourceChainId": result.source_chain_id,
        "blockNumber": result.block_number,
        "blockHash": Web3.to_hex(hexstr=result.block_hash),
        "rlpHeader": _hex(result.rlp_header),
        "rlpHeaderHash": _hex(rlp_header_hash),
        "requiredConfirmations": result.required_confirmations,
        "observedConfirmations": result.observed_confirmations,
        "quorumTip": result.quorum_tip,
        "requireFinalized": result.require_finalized,
        "finalizedBlockNumber": result.finalized_block_number,
        "expiresAt": expires_at,
        "rpcVotes": [vote.to_json() for vote in result.votes],
        "rpcVoteDigest": _hex(rpc_vote_digest),
        "signer": Web3.to_checksum_address(signer_address),
        "signerEpoch": int(signer_epoch),
        "oracleContractAddress": Web3.to_checksum_address(oracle_contract_address),
        "sapphireChainId": int(sapphire_chain_id),
        "reportDigest": _hex(report_digest),
        "signature": signature,
    }


def build_report_digest(
    *,
    sapphire_chain_id: int,
    oracle_contract_address: str,
    source_chain_id: int,
    block_number: int,
    block_hash: str,
    rlp_header_hash: bytes,
    required_confirmations: int,
    observed_confirmations: int,
    quorum_tip: int,
    require_finalized: bool,
    finalized_block_number: int | None,
    rpc_vote_digest: bytes,
    expires_at: int,
    signer_epoch: int,
) -> bytes:
    encoded = encode(
        [
            "bytes32",
            "uint256",
            "address",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32",
            "uint256",
            "uint256",
            "uint256",
            "bool",
            "uint256",
            "bytes32",
            "uint256",
            "uint64",
        ],
        [
            HEADER_REPORT_DOMAIN,
            int(sapphire_chain_id),
            to_canonical_address(Web3.to_checksum_address(oracle_contract_address)),
            int(source_chain_id),
            int(block_number),
            _bytes32_from_hex(block_hash),
            _ensure_bytes32(rlp_header_hash, "rlp_header_hash"),
            int(required_confirmations),
            int(observed_confirmations),
            int(quorum_tip),
            bool(require_finalized),
            int(finalized_block_number or 0),
            _ensure_bytes32(rpc_vote_digest, "rpc_vote_digest"),
            int(expires_at),
            int(signer_epoch),
        ],
    )
    return keccak(encoded)


def build_rpc_vote_digest(votes: tuple[RpcVote, ...] | list[RpcVote]) -> bytes:
    ordered_votes = sorted(votes, key=lambda vote: vote.source_index)
    vote_hashes = [build_rpc_vote_hash(vote) for vote in ordered_votes]
    encoded = encode(["uint256", "bytes32[]"], [len(vote_hashes), vote_hashes])
    return keccak(encoded)


def build_rpc_vote_hash(vote: RpcVote) -> bytes:
    encoded = encode(
        [
            "uint32",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32",
            "bool",
            "bytes32",
        ],
        [
            int(vote.source_index),
            int(vote.tip or 0),
            int(vote.finalized_block_number or 0),
            _optional_bytes32(vote.block_hash),
            _optional_bytes32(vote.recomputed_block_hash),
            bool(vote.ok),
            ZERO_BYTES32 if vote.ok else keccak(text=vote.error or ""),
        ],
    )
    return keccak(encoded)


def sign_digest(private_key: str, digest: bytes) -> str:
    digest = _ensure_bytes32(digest, "digest")
    key_bytes = bytes.fromhex(private_key.removeprefix("0x"))
    signature = keys.PrivateKey(key_bytes).sign_msg_hash(digest)
    recovery_id = int(signature.v)
    if recovery_id in (27, 28):
        recovery_id -= 27
    if recovery_id not in (0, 1):
        raise ValueError("signature recovery id must be 0/1 or 27/28")

    r = int(signature.r)
    s = int(signature.s)
    if s > SECPK1_N // 2:
        s = SECPK1_N - s
        recovery_id ^= 1

    return _hex(
        r.to_bytes(32, "big") + s.to_bytes(32, "big") + bytes([recovery_id + 27])
    )


def recover_digest_signer(digest: bytes, signature: str) -> str:
    digest = _ensure_bytes32(digest, "digest")
    raw = bytes.fromhex(signature.removeprefix("0x"))
    if len(raw) != 65:
        raise ValueError("signature must be 65 bytes")
    recovery_id = raw[64]
    if recovery_id in (27, 28):
        recovery_id -= 27
    if recovery_id not in (0, 1):
        raise ValueError("signature v must be 27/28 or 0/1")
    signature_obj = keys.Signature(
        vrs=(
            recovery_id,
            int.from_bytes(raw[:32], "big"),
            int.from_bytes(raw[32:64], "big"),
        )
    )
    return signature_obj.recover_public_key_from_msg_hash(digest).to_checksum_address()


def _optional_bytes32(value: str | None) -> bytes:
    if value is None:
        return ZERO_BYTES32
    return _bytes32_from_hex(value)


def _bytes32_from_hex(value: str) -> bytes:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise ValueError("expected 0x-prefixed bytes32 hex")
    return _ensure_bytes32(bytes.fromhex(value[2:]), "bytes32 hex")


def _ensure_bytes32(value: bytes, label: str) -> bytes:
    if len(value) != 32:
        raise ValueError(f"{label} must be 32 bytes")
    return value


def _hex(value: bytes) -> str:
    return "0x" + value.hex()
