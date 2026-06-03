"""Canonical EVM block-header RLP reconstruction.

Rebuilds the exact RLP-encoded block header from an eth_getBlockByNumber JSON
result, so that keccak256(rlpHeader) == block.hash. Data-driven by which fork
fields are present (so it follows the chain through London -> Shanghai ->
Cancun -> Prague/Pectra without hardcoding fork block numbers). The "real recent
block -> keccak == hash" test is the canonicalizer's acceptance gate: when a
future fork adds a header field, that test fails first and tells us to update
the table below.
"""

from typing import Any

import rlp
from eth_utils import keccak


class HeaderCanonicalizationError(ValueError):
    """Raised when a block JSON cannot be turned into a canonical RLP header.
    Subclasses ValueError so existing `except ValueError` paths still catch it."""

# (json_field_name, is_quantity) in canonical Ethereum header order.
# Quantity fields are RLP integers (hex -> int -> minimal big-endian, 0 -> b"").
# The rest are byte strings (hex -> bytes).
_BASE_FIELDS: list[tuple[str, bool]] = [
    ("parentHash", False),
    ("sha3Uncles", False),
    ("miner", False),
    ("stateRoot", False),
    ("transactionsRoot", False),
    ("receiptsRoot", False),
    ("logsBloom", False),
    ("difficulty", True),
    ("number", True),
    ("gasLimit", True),
    ("gasUsed", True),
    ("timestamp", True),
    ("extraData", False),
    ("mixHash", False),
    ("nonce", False),
]

# Optional fork fields, appended in protocol order. Grouped per fork so we can
# enforce all-or-none within a fork and "no later fork without earlier forks".
_FORK_GROUPS: list[tuple[str, list[tuple[str, bool]]]] = [
    ("london", [("baseFeePerGas", True)]),
    ("shanghai", [("withdrawalsRoot", False)]),
    ("cancun", [("blobGasUsed", True), ("excessBlobGas", True), ("parentBeaconBlockRoot", False)]),
    ("prague", [("requestsHash", False)]),  # EIP-7685
]


def _to_bytes(hexstr: str) -> bytes:
    return bytes.fromhex(hexstr[2:] if hexstr.startswith("0x") else hexstr)


def _qty_to_bytes(hexstr: str) -> bytes:
    n = int(hexstr, 16)
    return n.to_bytes((n.bit_length() + 7) // 8, "big")  # canonical RLP integer; 0 -> b""


def _encode_field(block: dict[str, Any], name: str, is_qty: bool) -> bytes:
    val = block.get(name)
    if val is None:  # treat null exactly like absent
        raise ValueError(f"missing required header field: {name}")
    return _qty_to_bytes(val) if is_qty else _to_bytes(val)


def build_rlp_header(block: dict[str, Any]) -> bytes:
    """Reconstruct the canonical RLP-encoded header from a block JSON result."""
    items: list[bytes] = [_encode_field(block, name, q) for (name, q) in _BASE_FIELDS]

    if len(items[14]) != 8:  # nonce is always 8 bytes
        raise ValueError("nonce must be 8 bytes")

    seen_absent = False
    for fork, fields in _FORK_GROUPS:
        present = [block.get(name) is not None for (name, _) in fields]
        if all(present):
            if seen_absent:
                raise ValueError(f"fork '{fork}' fields present after an earlier fork was absent")
            for name, q in fields:
                items.append(_encode_field(block, name, q))
        elif any(present):
            raise ValueError(f"fork '{fork}' is partially present (all-or-none required)")
        else:
            seen_absent = True

    return rlp.encode(items)


def header_hash(block: dict[str, Any]) -> str:
    """keccak256 of the reconstructed RLP header, as a 0x-prefixed hex string."""
    return "0x" + keccak(build_rlp_header(block)).hex()
