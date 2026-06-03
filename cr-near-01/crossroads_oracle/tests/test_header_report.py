from eth_account import Account
from eth_keys.constants import SECPK1_N
from eth_utils import keccak

from app.header_report import (
    HEADER_REPORT_DOMAIN,
    build_report_digest,
    build_rpc_vote_digest,
    build_signed_header_report,
    recover_digest_signer,
)
from app.source_rpc import ConfirmedHeaderResult, RpcVote


PRIVATE_KEY = "0x" + "11" * 32
SIGNER = Account.from_key(PRIVATE_KEY).address
ORACLE = "0x1111111111111111111111111111111111111111"


def test_domain_is_bytes32():
    assert isinstance(HEADER_REPORT_DOMAIN, bytes)
    assert len(HEADER_REPORT_DOMAIN) == 32


def test_signed_report_recovers_signer_and_uses_low_s():
    report = build_signed_header_report(
        result=_result(),
        private_key=PRIVATE_KEY,
        signer_address=SIGNER,
        signer_epoch=3,
        oracle_contract_address=ORACLE,
        sapphire_chain_id=23295,
        ttl_seconds=1800,
        now=1000,
    )

    signature = bytes.fromhex(report["signature"][2:])
    assert signature[64] in (27, 28)
    assert int.from_bytes(signature[32:64], "big") <= SECPK1_N // 2
    assert recover_digest_signer(
        bytes.fromhex(report["reportDigest"][2:]), report["signature"]
    ) == SIGNER


def test_digest_changes_when_finality_claim_changes():
    result = _result()
    base = _digest(result, require_finalized=False, finalized_block_number=None)
    finalized = _digest(result, require_finalized=True, finalized_block_number=199)

    assert base != finalized


def test_rpc_vote_digest_is_stable_and_error_sensitive():
    votes = _votes()

    assert build_rpc_vote_digest(votes) == build_rpc_vote_digest(tuple(reversed(votes)))

    changed = (
        votes[0],
        RpcVote(1, "rpc1", 200, None, None, None, False, "different error"),
    )
    assert build_rpc_vote_digest(votes) != build_rpc_vote_digest(changed)


def _digest(result, require_finalized, finalized_block_number):
    return build_report_digest(
        sapphire_chain_id=23295,
        oracle_contract_address=ORACLE,
        source_chain_id=result.source_chain_id,
        block_number=result.block_number,
        block_hash=result.block_hash,
        rlp_header_hash=keccak(result.rlp_header),
        required_confirmations=result.required_confirmations,
        observed_confirmations=result.observed_confirmations,
        quorum_tip=result.quorum_tip,
        require_finalized=require_finalized,
        finalized_block_number=finalized_block_number,
        rpc_vote_digest=build_rpc_vote_digest(result.votes),
        expires_at=2800,
        signer_epoch=3,
    )


def _result():
    rlp_header = b"\xc0"
    block_hash = "0x" + keccak(rlp_header).hex()
    return ConfirmedHeaderResult(
        source_chain_id=11155111,
        block_number=187,
        block_hash=block_hash,
        rlp_header=rlp_header,
        votes=_votes(),
        required_confirmations=12,
        observed_confirmations=12,
        quorum_tip=199,
        require_finalized=False,
        finalized_block_number=None,
    )


def _votes():
    block_hash = "0x" + "22" * 32
    return (
        RpcVote(0, "rpc0", 200, None, block_hash, block_hash, True, None, b"\xc0"),
        RpcVote(1, "rpc1", 200, None, None, None, False, "rpc down"),
    )
