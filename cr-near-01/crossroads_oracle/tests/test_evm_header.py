import pytest
from eth_utils import keccak

from app.evm_header import (
    HeaderCanonicalizationError,
    build_rlp_header,
    verify_block_hash,
)


EXPECTED_PECTRA_LIKE_RLP = (
    "0xf9025ba01111111111111111111111111111111111111111111111111111111111111111"
    "a02222222222222222222222222222222222222222222222222222222222222222"
    "943333333333333333333333333333333333333333"
    "a04444444444444444444444444444444444444444444444444444444444444444"
    "a05555555555555555555555555555555555555555555555555555555555555555"
    "a06666666666666666666666666666666666666666666666666666666666666666"
    "b90100"
    + ("00" * 256)
    + "80018401c9c38082520865821234"
    "a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    "88000000000000000007"
    "a07777777777777777777777777777777777777777777777777777777777777777"
    "8002"
    "a08888888888888888888888888888888888888888888888888888888888888888"
    "a09999999999999999999999999999999999999999999999999999999999999999"
)


def test_pectra_like_header_uses_protocol_field_order():
    block = _pectra_like_block()

    assert "0x" + build_rlp_header(block).hex() == EXPECTED_PECTRA_LIKE_RLP


def test_verify_block_hash_recomputes_json_hash():
    block = _with_hash(_pectra_like_block())

    rlp_header, recomputed = verify_block_hash(block)

    assert recomputed == block["hash"]
    assert "0x" + keccak(rlp_header).hex() == block["hash"]


def test_requests_hash_is_part_of_header_hash():
    with_requests = _with_hash(_pectra_like_block())
    without_requests = _pectra_like_block()
    without_requests.pop("requestsHash")

    assert "0x" + keccak(build_rlp_header(without_requests)).hex() != with_requests["hash"]


def test_cancun_fields_are_all_required_if_any_present():
    block = _pectra_like_block()
    block.pop("excessBlobGas")

    with pytest.raises(HeaderCanonicalizationError, match="excessBlobGas"):
        build_rlp_header(block)


def test_nonce_must_be_eight_bytes():
    block = _pectra_like_block()
    block["nonce"] = "0x00"

    with pytest.raises(HeaderCanonicalizationError, match="nonce must be 8 bytes"):
        build_rlp_header(block)


def _with_hash(block):
    block = dict(block)
    block["hash"] = "0x" + keccak(build_rlp_header(block)).hex()
    return block


def _hex(byte, count):
    return "0x" + byte * count


def _pectra_like_block():
    return {
        "parentHash": _hex("11", 32),
        "sha3Uncles": _hex("22", 32),
        "miner": _hex("33", 20),
        "stateRoot": _hex("44", 32),
        "transactionsRoot": _hex("55", 32),
        "receiptsRoot": _hex("66", 32),
        "logsBloom": _hex("00", 256),
        "difficulty": "0x0",
        "number": "0x1",
        "gasLimit": "0x1c9c380",
        "gasUsed": "0x5208",
        "timestamp": "0x65",
        "extraData": "0x1234",
        "mixHash": _hex("aa", 32),
        "nonce": _hex("00", 8),
        "baseFeePerGas": "0x7",
        "withdrawalsRoot": _hex("77", 32),
        "blobGasUsed": "0x0",
        "excessBlobGas": "0x2",
        "parentBeaconBlockRoot": _hex("88", 32),
        "requestsHash": _hex("99", 32),
    }
