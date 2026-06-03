"""Header report digest + signing (Model B reference).

Builds the exact keccak256(abi.encode(...)) digest that a Sapphire
`verifySignedHeader`/`submitSignedHeader` will recompute, and signs it with the
header-signer secp256k1 key over the RAW digest (no EIP-191 prefix), emitting a
65-byte r||s||v signature with v in {27,28} and canonical low-s — so Solidity
`ecrecover(digest, v, r, s)` recovers the signer directly.

Domains are bytes32 = keccak256(domain string) so every abi.encode field is
fixed-size and Python eth_abi matches Solidity abi.encode byte-for-byte.
"""

from typing import Any

from eth_abi import encode
from eth_keys import keys
from eth_utils import keccak

HEADER_SIGNER_COMMITMENT_DOMAIN = keccak(text="CROSSROADS_HEADER_SIGNER_V1")
HEADER_REPORT_DOMAIN = keccak(text="CROSSROADS_HEADER_REPORT_V1")

SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

_ZERO32 = b"\x00" * 32


def _to_bytes(hexstr: str) -> bytes:
    return bytes.fromhex(hexstr[2:] if hexstr.startswith("0x") else hexstr)


def _b32(hexstr: str) -> bytes:
    b = _to_bytes(hexstr)
    if len(b) != 32:
        raise ValueError(f"expected 32 bytes, got {len(b)}")
    return b


def signer_commitment(
    *, sapphire_chain_id: int, oracle_contract: str, rofl_app_id: str, signer_address: str, signer_epoch: int
) -> bytes:
    """Registration-context commitment (NOT a report; distinct domain)."""
    app_id = _to_bytes(rofl_app_id)
    if len(app_id) != 21:
        raise ValueError("rofl_app_id must be 21 bytes")
    return keccak(
        encode(
            ["bytes32", "uint256", "address", "bytes21", "address", "uint64"],
            [HEADER_SIGNER_COMMITMENT_DOMAIN, sapphire_chain_id, oracle_contract, app_id, signer_address, signer_epoch],
        )
    )


def rpc_vote_digest(votes: list[dict[str, Any]]) -> bytes:
    """Canonical digest over the RPC votes (stable encoding, NOT JSON hashing).

    Vote order is the caller's configured sourceIndex order.
    """
    vote_hashes: list[bytes] = []
    for v in votes:
        ok = bool(v["ok"])
        block_hash = _b32(v["blockHash"]) if ok and v.get("blockHash") else _ZERO32
        recomputed = _b32(v["recomputedBlockHash"]) if ok and v.get("recomputedBlockHash") else _ZERO32
        error_hash = _ZERO32 if ok else keccak(text=(v.get("error") or ""))
        finalized = int(v.get("finalizedBlockNumber") or 0)
        vote_hashes.append(
            keccak(
                encode(
                    ["uint32", "uint256", "uint256", "bytes32", "bytes32", "bool", "bytes32"],
                    [int(v["sourceIndex"]), int(v.get("tip") or 0), finalized, block_hash, recomputed, ok, error_hash],
                )
            )
        )
    return keccak(encode(["uint256", "bytes32[]"], [len(vote_hashes), vote_hashes]))


def report_digest(
    *,
    sapphire_chain_id: int,
    oracle_contract: str,
    source_chain_id: int,
    block_number: int,
    block_hash: str,
    rlp_header_hash: str,
    required_confirmations: int,
    observed_confirmations: int,
    quorum_tip: int,
    require_finalized: bool,
    finalized_block_number: int,
    rpc_vote_digest_value: bytes,
    expires_at: int,
    signer_epoch: int,
) -> bytes:
    """The signed report digest. Field order/types MUST match the Solidity lib."""
    return keccak(
        encode(
            [
                "bytes32",  # HEADER_REPORT_DOMAIN
                "uint256",  # sapphireChainId
                "address",  # oracleContractAddress
                "uint256",  # sourceChainId
                "uint256",  # blockNumber
                "bytes32",  # blockHash
                "bytes32",  # rlpHeaderHash
                "uint256",  # requiredConfirmations
                "uint256",  # observedConfirmations
                "uint256",  # quorumTip
                "bool",     # requireFinalized
                "uint256",  # finalizedBlockNumber
                "bytes32",  # rpcVoteDigest
                "uint256",  # expiresAt
                "uint64",   # signerEpoch
            ],
            [
                HEADER_REPORT_DOMAIN,
                sapphire_chain_id,
                oracle_contract,
                source_chain_id,
                block_number,
                _b32(block_hash),
                _b32(rlp_header_hash),
                required_confirmations,
                observed_confirmations,
                quorum_tip,
                require_finalized,
                finalized_block_number,
                rpc_vote_digest_value,
                expires_at,
                signer_epoch,
            ],
        )
    )


def address_from_private_key(private_key_hex: str) -> str:
    return keys.PrivateKey(_to_bytes(private_key_hex)).public_key.to_checksum_address()


def sign_digest(digest: bytes, private_key_hex: str) -> bytes:
    """Sign a raw 32-byte digest -> 65-byte r||s||v with v in {27,28}, low-s."""
    sig = keys.PrivateKey(_to_bytes(private_key_hex)).sign_msg_hash(digest)
    r, s, v = sig.r, sig.s, sig.v  # eth_keys v is recovery id 0/1
    if s > SECP256K1_N // 2:  # enforce canonical low-s
        s = SECP256K1_N - s
        v ^= 1
    return r.to_bytes(32, "big") + s.to_bytes(32, "big") + bytes([v + 27])


def recover(digest: bytes, signature: bytes) -> str:
    if len(signature) != 65:
        raise ValueError("signature must be 65 bytes")
    r = int.from_bytes(signature[0:32], "big")
    s = int.from_bytes(signature[32:64], "big")
    v = signature[64] - 27
    return keys.Signature(vrs=(v, r, s)).recover_public_key_from_msg_hash(digest).to_checksum_address()
