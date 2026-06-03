from eth_account import Account
from eth_utils import keccak

import header_report
from report_builder import build_signed_header_report
from source_rpc import ConfirmedHeaderResult, RpcVote

PRIVATE_KEY = "0x" + "22" * 32
SIGNER = Account.from_key(PRIVATE_KEY).address
ORACLE = "0x3164e6C6Cf50B84D5Ab50c708326BA36C5FDf404"
SAPPHIRE_CHAIN_ID = 23295


def _result():
    rlp_header = bytes.fromhex("ab" * 120)
    block_hash = "0x" + keccak(rlp_header).hex()
    return ConfirmedHeaderResult(
        source_chain_id=11155111,
        block_number=10982482,
        block_hash=block_hash,
        rlp_header=rlp_header,
        votes=(
            RpcVote(0, "rpc0", 10982502, None, block_hash, block_hash, True, None, rlp_header),
            RpcVote(1, "rpc1", 10982501, None, block_hash, block_hash, True, None, rlp_header),
        ),
        required_confirmations=12,
        observed_confirmations=20,
        quorum_tip=10982502,
        require_finalized=False,
        finalized_block_number=None,
    )


def test_signature_recovers_to_signer():
    report = build_signed_header_report(
        result=_result(),
        private_key=PRIVATE_KEY,
        signer_address=SIGNER,
        signer_epoch=1,
        oracle_contract_address=ORACLE,
        sapphire_chain_id=SAPPHIRE_CHAIN_ID,
        ttl_seconds=1800,
        now=1000,
    )

    digest = bytes.fromhex(report["reportDigest"][2:])
    signature = bytes.fromhex(report["signature"][2:])
    assert header_report.recover(digest, signature) == SIGNER
    assert report["signer"] == SIGNER
    assert report["expiresAt"] == 1000 + 1800
    assert len(signature) == 65
    assert signature[64] in (27, 28)


def test_report_digest_matches_independent_recompute():
    result = _result()
    report = build_signed_header_report(
        result=result,
        private_key=PRIVATE_KEY,
        signer_address=SIGNER,
        signer_epoch=7,
        oracle_contract_address=ORACLE,
        sapphire_chain_id=SAPPHIRE_CHAIN_ID,
        ttl_seconds=1800,
        now=2000,
    )

    rvd = header_report.rpc_vote_digest([v.to_json() for v in result.votes])
    expected = header_report.report_digest(
        sapphire_chain_id=SAPPHIRE_CHAIN_ID,
        oracle_contract=ORACLE,
        source_chain_id=result.source_chain_id,
        block_number=result.block_number,
        block_hash=result.block_hash,
        rlp_header_hash=report["rlpHeaderHash"],
        required_confirmations=result.required_confirmations,
        observed_confirmations=result.observed_confirmations,
        quorum_tip=result.quorum_tip,
        require_finalized=result.require_finalized,
        finalized_block_number=0,
        rpc_vote_digest_value=rvd,
        expires_at=2000 + 1800,
        signer_epoch=7,
    )
    assert report["reportDigest"] == "0x" + expected.hex()
