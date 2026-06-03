import pytest

from contract_client import (
    ZERO_ADDRESS,
    build_header_signer_commitment,
    plan_header_signer_registration,
)

APP_ID = "0x002339e39056f12efc2e8f1476a871e22555bc4e49"
ORACLE = "0x1111111111111111111111111111111111111111"
SIGNER = "0x2222222222222222222222222222222222222222"
OTHER_SIGNER = "0x3333333333333333333333333333333333333333"


class FakeFunction:
    def __init__(self, value=None, calldata=None):
        self.value = value
        self.calldata = calldata

    def call(self):
        return self.value

    def _encode_transaction_data(self):
        return self.calldata


class FakeFunctions:
    def __init__(self, current_signer):
        self.current_signer = current_signer

    def headerSigner(self):
        return FakeFunction(self.current_signer)

    def registerHeaderSigner(self, signer, commitment):
        return FakeFunction(calldata=f"register:{signer}:{commitment}")

    def rotateHeaderSigner(self, signer, commitment):
        return FakeFunction(calldata=f"rotate:{signer}:{commitment}")


class FakeContract:
    def __init__(self, current_signer):
        self.functions = FakeFunctions(current_signer)


def test_commitment_is_stable_for_same_inputs():
    first = build_header_signer_commitment(23295, ORACLE, APP_ID, SIGNER, 1)
    second = build_header_signer_commitment(23295, ORACLE, APP_ID, SIGNER, 1)

    assert first == second
    assert first.startswith("0x")
    assert len(first) == 66


def test_no_chain_signer_generates_register_calldata():
    commitment = build_header_signer_commitment(23295, ORACLE, APP_ID, SIGNER, 1)

    action = plan_header_signer_registration(
        FakeContract(ZERO_ADDRESS), SIGNER, commitment, allow_rotation=False
    )

    assert action.action == "register"
    assert action.calldata.startswith("register:")
    assert action.current_signer == ZERO_ADDRESS


def test_same_chain_signer_skips():
    commitment = build_header_signer_commitment(23295, ORACLE, APP_ID, SIGNER, 1)

    action = plan_header_signer_registration(
        FakeContract(SIGNER), SIGNER, commitment, allow_rotation=False
    )

    assert action.action == "skip"
    assert action.calldata is None


def test_different_chain_signer_fails_without_rotation():
    commitment = build_header_signer_commitment(23295, ORACLE, APP_ID, SIGNER, 1)

    with pytest.raises(RuntimeError, match="ALLOW_SIGNER_ROTATION=1"):
        plan_header_signer_registration(
            FakeContract(OTHER_SIGNER), SIGNER, commitment, allow_rotation=False
        )
