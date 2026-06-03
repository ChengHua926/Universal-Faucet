"""Tests for the report digest, vote digest, and raw-digest signing."""

import header_report as hr

# Hardhat account #0 (well-known test key) — fine for fixtures, never real funds.
PRIV = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

SECP256K1_N = hr.SECP256K1_N

BASE = dict(
    sapphire_chain_id=23295,
    oracle_contract="0xD22bcCbb387464dd99c573aBf583b00F55626552",
    source_chain_id=11155111,
    block_number=10981587,
    block_hash="0x" + "ab" * 32,
    rlp_header_hash="0x" + "ab" * 32,
    required_confirmations=12,
    observed_confirmations=14,
    quorum_tip=10981601,
    require_finalized=False,
    finalized_block_number=0,
    rpc_vote_digest_value=b"\x11" * 32,
    expires_at=1710000000,
    signer_epoch=1,
)


def test_domains_are_bytes32():
    assert len(hr.HEADER_REPORT_DOMAIN) == 32
    assert len(hr.HEADER_SIGNER_COMMITMENT_DOMAIN) == 32
    assert hr.HEADER_REPORT_DOMAIN != hr.HEADER_SIGNER_COMMITMENT_DOMAIN


def test_report_digest_is_stable():
    assert hr.report_digest(**BASE) == hr.report_digest(**BASE)


def test_each_bound_field_changes_the_digest():
    base = hr.report_digest(**BASE)
    mutations = {
        "block_hash": "0x" + "cd" * 32,
        "rlp_header_hash": "0x" + "cd" * 32,
        "source_chain_id": 1,
        "oracle_contract": "0x0000000000000000000000000000000000000001",
        "sapphire_chain_id": 23294,
        "signer_epoch": 2,
        "require_finalized": True,
        "finalized_block_number": 10981587,
        "block_number": 10981588,
        "expires_at": 1710000001,
    }
    for field, value in mutations.items():
        d = hr.report_digest(**{**BASE, field: value})
        assert d != base, f"digest did not change when {field} changed"


def test_vote_digest_stable_and_order_sensitive():
    v0 = {"sourceIndex": 0, "tip": 100, "finalizedBlockNumber": 98, "blockHash": "0x" + "aa" * 32,
          "recomputedBlockHash": "0x" + "aa" * 32, "ok": True, "error": None}
    v1 = {"sourceIndex": 1, "tip": 100, "finalizedBlockNumber": 98, "blockHash": "0x" + "aa" * 32,
          "recomputedBlockHash": "0x" + "aa" * 32, "ok": True, "error": None}
    assert hr.rpc_vote_digest([v0, v1]) == hr.rpc_vote_digest([v0, v1])
    assert hr.rpc_vote_digest([v0, v1]) != hr.rpc_vote_digest([v1, v0])


def test_failed_vote_binds_error_hash():
    ok = {"sourceIndex": 0, "tip": 100, "finalizedBlockNumber": 0, "blockHash": "0x" + "aa" * 32,
          "recomputedBlockHash": "0x" + "aa" * 32, "ok": True, "error": None}
    bad = {"sourceIndex": 0, "tip": 100, "finalizedBlockNumber": 0, "blockHash": None,
           "recomputedBlockHash": None, "ok": False, "error": "timeout"}
    assert hr.rpc_vote_digest([ok]) != hr.rpc_vote_digest([bad])


def test_sign_recover_roundtrip_and_signature_format():
    digest = hr.report_digest(**BASE)
    sig = hr.sign_digest(digest, PRIV)
    assert len(sig) == 65
    v = sig[64]
    assert v in (27, 28)  # Solidity ecrecover form
    s = int.from_bytes(sig[32:64], "big")
    assert s <= SECP256K1_N // 2  # canonical low-s
    assert hr.recover(digest, sig) == ADDR
    assert hr.address_from_private_key(PRIV) == ADDR


def test_signature_does_not_verify_against_mutated_digest():
    sig = hr.sign_digest(hr.report_digest(**BASE), PRIV)
    other = hr.report_digest(**{**BASE, "block_hash": "0x" + "cd" * 32})
    assert hr.recover(other, sig) != ADDR
