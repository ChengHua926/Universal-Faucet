import json
import stat

from app.signer_key import load_or_create_signing_key


def test_key_is_generated_when_missing(tmp_path):
    key_path = tmp_path / "crossroads-header-signer.json"

    signer = load_or_create_signing_key(key_path)

    assert key_path.exists()
    assert signer.address.startswith("0x")
    assert signer.private_key.startswith("0x")
    assert stat.S_IMODE(key_path.stat().st_mode) == 0o600

    data = json.loads(key_path.read_text())
    assert data["version"] == 1
    assert data["scheme"] == "secp256k1"
    assert data["private_key"] == signer.private_key
    assert data["address"] == signer.address


def test_existing_key_loads_same_signer(tmp_path):
    key_path = tmp_path / "crossroads-header-signer.json"

    first = load_or_create_signing_key(key_path)
    second = load_or_create_signing_key(key_path)

    assert second.private_key == first.private_key
    assert second.address == first.address
