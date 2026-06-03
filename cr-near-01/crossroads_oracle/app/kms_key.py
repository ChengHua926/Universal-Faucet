from dataclasses import dataclass
from typing import Any

from eth_account import Account


@dataclass(frozen=True)
class KmsSignerKey:
    private_key: str
    address: str


def fetch_or_derive_secp256k1_key(rofl_client: Any, key_id: str) -> KmsSignerKey:
    response = rofl_client.generate_key(key_id=key_id, kind="secp256k1")
    private_key = _normalize_private_key(_extract_private_key(response))
    account = Account.from_key(private_key)
    return KmsSignerKey(private_key=private_key, address=account.address)


def _extract_private_key(response: Any) -> str:
    if isinstance(response, str):
        return response

    if isinstance(response, dict):
        for key in (
            "private_key",
            "privateKey",
            "key",
            "key_hex",
            "secret",
            "data",
        ):
            if key not in response:
                continue
            value = response[key]
            if isinstance(value, dict):
                return _extract_private_key(value)
            if isinstance(value, str):
                return value

    raise ValueError("ROFL KMS response did not contain a secp256k1 private key")


def _normalize_private_key(private_key: str) -> str:
    private_key = private_key.strip()
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key

    raw = private_key[2:]
    if len(raw) != 64:
        raise ValueError("ROFL KMS secp256k1 private key must be 32 bytes")
    try:
        int(raw, 16)
    except ValueError as exc:
        raise ValueError("ROFL KMS secp256k1 private key must be hex") from exc
    return "0x" + raw.lower()
