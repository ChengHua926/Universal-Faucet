#!/usr/bin/env python3
"""Create Crossroads signing requests.

Requires: pip install eth-account eth-utils
"""
import argparse
import json
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import to_checksum_address


def normalize_hex(value: str, expected_len: int | None = None) -> str:
    value = value.strip()
    if value.startswith(("0x", "0X")):
        value = value[2:]
    if len(value) % 2:
        raise SystemExit("hex values must have an even number of nibbles")
    bytes.fromhex(value)
    if expected_len is not None and len(value) != expected_len * 2:
        raise SystemExit(f"expected {expected_len} bytes, got {len(value)//2}")
    return "0x" + value.lower()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--private-key", required=True, help="spender EVM private key")
    ap.add_argument("--asset-contract", required=True)
    ap.add_argument("--encumbered-account", required=True, help="bytes32 hex")
    ap.add_argument("--message", required=True, help="transaction/signing payload bytes as hex")
    args = ap.parse_args()

    payload = {
        "asset_contract": to_checksum_address(args.asset_contract).lower(),
        "encumbered_account": normalize_hex(args.encumbered_account, 32),
        "message": normalize_hex(args.message),
    }
    canonical = json.dumps(payload, separators=(",", ":")).encode()
    signed = Account.sign_message(encode_defunct(canonical), args.private_key)
    payload["user_signature"] = signed.signature.hex()
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
