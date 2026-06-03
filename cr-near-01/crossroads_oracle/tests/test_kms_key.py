from eth_account import Account

from app.kms_key import fetch_or_derive_secp256k1_key


PRIVATE_KEY = "0x" + "11" * 32


class FakeRofl:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def generate_key(self, key_id, kind):
        self.calls.append((key_id, kind))
        return self.response


def test_kms_key_derives_expected_ethereum_address(capsys):
    signer = fetch_or_derive_secp256k1_key(FakeRofl({"key": PRIVATE_KEY}), "key-v1")

    assert signer.private_key == PRIVATE_KEY
    assert signer.address == Account.from_key(PRIVATE_KEY).address
    assert capsys.readouterr().out == ""


def test_kms_key_requests_secp256k1_kind():
    rofl = FakeRofl(PRIVATE_KEY)

    fetch_or_derive_secp256k1_key(rofl, "crossroads-header-signer-v1")

    assert rofl.calls == [("crossroads-header-signer-v1", "secp256k1")]
