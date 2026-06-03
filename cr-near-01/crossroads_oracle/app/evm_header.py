from typing import Any, Iterable

from eth_utils import keccak


class HeaderCanonicalizationError(ValueError):
    pass


BASE_HEADER_FIELDS = (
    ("parentHash", "hash32"),
    (("sha3Uncles", "ommersHash"), "hash32"),
    (("miner", "beneficiary"), "address"),
    ("stateRoot", "hash32"),
    ("transactionsRoot", "hash32"),
    ("receiptsRoot", "hash32"),
    ("logsBloom", "bloom"),
    ("difficulty", "quantity"),
    ("number", "quantity"),
    ("gasLimit", "quantity"),
    ("gasUsed", "quantity"),
    ("timestamp", "quantity"),
    ("extraData", "bytes"),
    (("mixHash", "prevRandao"), "hash32"),
    ("nonce", "nonce"),
)

LONDON_FIELDS = (("baseFeePerGas", "quantity"),)
SHANGHAI_FIELDS = (("withdrawalsRoot", "hash32"),)
CANCUN_FIELDS = (
    ("blobGasUsed", "quantity"),
    ("excessBlobGas", "quantity"),
    ("parentBeaconBlockRoot", "hash32"),
)
PRAGUE_FIELDS = (("requestsHash", "hash32"),)


def build_rlp_header(block: dict[str, Any]) -> bytes:
    values: list[bytes] = []
    for names, kind in BASE_HEADER_FIELDS:
        values.append(_encode_field(block, names, kind, required=True))

    _append_fork_fields(values, block, LONDON_FIELDS)
    _append_fork_fields(values, block, SHANGHAI_FIELDS)
    _append_fork_fields(values, block, CANCUN_FIELDS)
    _append_fork_fields(values, block, PRAGUE_FIELDS)

    return rlp_encode(values)


def recompute_block_hash(block: dict[str, Any]) -> str:
    return "0x" + keccak(build_rlp_header(block)).hex()


def verify_block_hash(block: dict[str, Any]) -> tuple[bytes, str]:
    rlp_header = build_rlp_header(block)
    recomputed = "0x" + keccak(rlp_header).hex()
    block_hash = _get_field(block, "hash", required=True)
    if not isinstance(block_hash, str):
        raise HeaderCanonicalizationError("hash must be a hex string")
    if recomputed.lower() != block_hash.lower():
        raise HeaderCanonicalizationError(
            f"recomputed block hash {recomputed} does not match JSON hash {block_hash}"
        )
    return rlp_header, recomputed


def rlp_encode(value: bytes | list[bytes]) -> bytes:
    if isinstance(value, list):
        payload = b"".join(rlp_encode(item) for item in value)
        return _rlp_prefix(len(payload), 0xC0) + payload

    if len(value) == 1 and value[0] < 0x80:
        return value
    return _rlp_prefix(len(value), 0x80) + value


def _append_fork_fields(
    values: list[bytes],
    block: dict[str, Any],
    fields: Iterable[tuple[str, str]],
) -> None:
    fields = tuple(fields)
    if not any(_has_field(block, name) for name, _ in fields):
        return
    for name, kind in fields:
        values.append(_encode_field(block, name, kind, required=True))


def _encode_field(
    block: dict[str, Any],
    names: str | tuple[str, ...],
    kind: str,
    required: bool,
) -> bytes:
    value = _get_field(block, names, required=required)
    if value is None:
        return b""
    if kind == "quantity":
        return _int_to_big_endian(_parse_quantity(value, _field_label(names)))
    if kind == "hash32":
        return _parse_hex_bytes(value, _field_label(names), expected_len=32)
    if kind == "address":
        return _parse_hex_bytes(value, _field_label(names), expected_len=20)
    if kind == "bloom":
        return _parse_hex_bytes(value, _field_label(names), expected_len=256)
    if kind == "nonce":
        return _parse_hex_bytes(value, _field_label(names), expected_len=8)
    if kind == "bytes":
        return _parse_hex_bytes(value, _field_label(names), expected_len=None)
    raise HeaderCanonicalizationError(f"Unknown header field kind: {kind}")


def _get_field(
    block: dict[str, Any],
    names: str | tuple[str, ...],
    required: bool,
) -> Any:
    if isinstance(names, str):
        names = (names,)
    for name in names:
        if name in block and block[name] is not None:
            return block[name]
    if required:
        raise HeaderCanonicalizationError(f"Missing required header field: {names[0]}")
    return None


def _has_field(block: dict[str, Any], name: str) -> bool:
    return name in block and block[name] is not None


def _field_label(names: str | tuple[str, ...]) -> str:
    if isinstance(names, str):
        return names
    return "/".join(names)


def _parse_quantity(value: Any, field_name: str) -> int:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise HeaderCanonicalizationError(f"{field_name} must be a hex quantity")
    try:
        parsed = int(value, 16)
    except ValueError as exc:
        raise HeaderCanonicalizationError(
            f"{field_name} must be a valid hex quantity"
        ) from exc
    if parsed < 0:
        raise HeaderCanonicalizationError(f"{field_name} must be non-negative")
    return parsed


def _parse_hex_bytes(value: Any, field_name: str, expected_len: int | None) -> bytes:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise HeaderCanonicalizationError(f"{field_name} must be hex bytes")
    raw = value[2:]
    if len(raw) % 2 != 0:
        raise HeaderCanonicalizationError(f"{field_name} has odd-length hex")
    try:
        parsed = bytes.fromhex(raw)
    except ValueError as exc:
        raise HeaderCanonicalizationError(f"{field_name} must be valid hex") from exc
    if expected_len is not None and len(parsed) != expected_len:
        raise HeaderCanonicalizationError(
            f"{field_name} must be {expected_len} bytes, got {len(parsed)}"
        )
    return parsed


def _int_to_big_endian(value: int) -> bytes:
    if value == 0:
        return b""
    return value.to_bytes((value.bit_length() + 7) // 8, "big")


def _rlp_prefix(length: int, offset: int) -> bytes:
    if length < 56:
        return bytes([offset + length])
    encoded_length = _int_to_big_endian(length)
    return bytes([offset + 55 + len(encoded_length)]) + encoded_length
