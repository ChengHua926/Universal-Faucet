"""Legacy file-backed signer (development fallback only).

Production uses the ROFL KMS key (kms_key.py) so nothing is persisted. This
on-disk signer exists only for local runs outside a TEE where appd is absent;
it is gated behind ALLOW_LEGACY_FILE_SIGNER=1 and should stay disabled in prod.
"""

import json
import os
from dataclasses import dataclass
from pathlib import Path

from eth_account import Account

KEY_VERSION = 1
KEY_SCHEME = "secp256k1"
DEFAULT_SIGNING_KEY_PATH = "/storage/crossroads-header-signer.json"


@dataclass(frozen=True)
class SignerKey:
    private_key: str
    address: str


def load_or_create_signing_key(path: str | os.PathLike[str]) -> SignerKey:
    key_path = Path(path)
    if key_path.exists():
        return _load_signing_key(key_path)

    account = Account.create()
    private_key = "0x" + account.key.hex()
    signer = SignerKey(private_key=private_key, address=account.address)
    _write_signing_key(key_path, signer)
    return signer


def _load_signing_key(path: Path) -> SignerKey:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if data.get("version") != KEY_VERSION:
        raise ValueError(f"Unsupported signer key version in {path}")
    if data.get("scheme") != KEY_SCHEME:
        raise ValueError(f"Unsupported signer key scheme in {path}")

    private_key = data.get("private_key")
    if not isinstance(private_key, str) or not private_key.startswith("0x"):
        raise ValueError(f"Invalid private key encoding in {path}")

    account = Account.from_key(private_key)
    address = data.get("address")
    if not isinstance(address, str) or address.lower() != account.address.lower():
        raise ValueError(f"Signer address does not match private key in {path}")

    return SignerKey(private_key=private_key, address=account.address)


def _write_signing_key(path: Path, signer: SignerKey) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": KEY_VERSION,
        "scheme": KEY_SCHEME,
        "private_key": signer.private_key,
        "address": signer.address,
    }

    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
    finally:
        os.chmod(path, 0o600)
