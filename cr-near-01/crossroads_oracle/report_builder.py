"""Assemble a TEE-signed header report.

Glues source_rpc (the quorum-verified header + votes) to header_report (the
contract-aligned digest + signature). The returned dict is exactly what a client
relays to HeaderReportOracle.submitSignedHeader: the report fields plus the raw
report digest and a 65-byte r||s||v signature (v in {27,28}, low-s) the contract
recovers with ecrecover. Keeping this here keeps header_report.py pure crypto.
"""

import time
from typing import Any

from eth_utils import keccak
from web3 import Web3

import header_report
from source_rpc import ConfirmedHeaderResult


def build_signed_header_report(
    *,
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
    oracle = Web3.to_checksum_address(oracle_contract_address)

    rlp_header_hash = "0x" + keccak(result.rlp_header).hex()
    votes_json = [vote.to_json() for vote in result.votes]
    rvd = header_report.rpc_vote_digest(votes_json)

    digest = header_report.report_digest(
        sapphire_chain_id=sapphire_chain_id,
        oracle_contract=oracle,
        source_chain_id=result.source_chain_id,
        block_number=result.block_number,
        block_hash=result.block_hash,
        rlp_header_hash=rlp_header_hash,
        required_confirmations=result.required_confirmations,
        observed_confirmations=result.observed_confirmations,
        quorum_tip=result.quorum_tip,
        require_finalized=result.require_finalized,
        finalized_block_number=int(result.finalized_block_number or 0),
        rpc_vote_digest_value=rvd,
        expires_at=expires_at,
        signer_epoch=signer_epoch,
    )
    signature = header_report.sign_digest(digest, private_key)  # 65-byte r||s||v

    return {
        "version": 1,
        "sourceChainId": result.source_chain_id,
        "blockNumber": result.block_number,
        "blockHash": result.block_hash,
        "rlpHeader": "0x" + result.rlp_header.hex(),
        "rlpHeaderHash": rlp_header_hash,
        "requiredConfirmations": result.required_confirmations,
        "observedConfirmations": result.observed_confirmations,
        "quorumTip": result.quorum_tip,
        "requireFinalized": result.require_finalized,
        "finalizedBlockNumber": result.finalized_block_number,
        "rpcVotes": votes_json,
        "rpcVoteDigest": "0x" + rvd.hex(),
        "signer": Web3.to_checksum_address(signer_address),
        "signerEpoch": int(signer_epoch),
        "oracleContractAddress": oracle,
        "sapphireChainId": int(sapphire_chain_id),
        "reportDigest": "0x" + digest.hex(),
        "signature": "0x" + signature.hex(),
        "expiresAt": expires_at,
    }
