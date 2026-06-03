"""Canonical RLP header tests — gated on a real recent Sepolia (Pectra) block."""

import json
import os

import pytest

import evm_header

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "sepolia_block.json")


def _block():
    with open(FIXTURE) as f:
        return json.load(f)


def test_real_block_keccak_matches_hash():
    blk = _block()
    assert evm_header.header_hash(blk) == blk["hash"]


def test_requests_hash_is_actually_in_the_rlp():
    # The fixture is post-Pectra, so it has requestsHash. Removing it must change
    # the reconstructed hash — proving the field is included in the RLP.
    blk = _block()
    assert blk.get("requestsHash") is not None  # fixture sanity

    without = dict(blk)
    without["requestsHash"] = None  # null == absent
    assert evm_header.header_hash(without) != blk["hash"]


def test_null_field_treated_as_absent_and_gap_errors():
    # withdrawalsRoot (Shanghai) absent while Cancun fields present => illegal gap.
    blk = _block()
    broken = dict(blk)
    broken["withdrawalsRoot"] = None
    with pytest.raises(ValueError, match="after an earlier fork was absent"):
        evm_header.build_rlp_header(broken)


def test_missing_required_base_field_errors():
    blk = _block()
    broken = dict(blk)
    broken["stateRoot"] = None
    with pytest.raises(ValueError, match="missing required header field: stateRoot"):
        evm_header.build_rlp_header(broken)


def test_quantity_canonicalization():
    # RLP integers: 0 -> empty byte string, no leading zeros otherwise.
    assert evm_header._qty_to_bytes("0x0") == b""
    assert evm_header._qty_to_bytes("0x00") == b""
    assert evm_header._qty_to_bytes("0x10") == b"\x10"
    assert evm_header._qty_to_bytes("0x0100") == b"\x01\x00"
