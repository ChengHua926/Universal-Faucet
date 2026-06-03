import pytest

from app.oracle import OracleConfig


def test_source_confirmations_defaults_to_twelve(monkeypatch):
    monkeypatch.setenv("ORACLE_CONTRACT_ADDRESS", "0x0000000000000000000000000000000000000001")
    monkeypatch.delenv("SOURCE_CONFIRMATIONS", raising=False)

    config = OracleConfig.from_env()

    assert config.source_confirmations == 12


def test_source_confirmations_can_be_overridden(monkeypatch):
    monkeypatch.setenv("ORACLE_CONTRACT_ADDRESS", "0x0000000000000000000000000000000000000001")
    monkeypatch.setenv("SOURCE_CONFIRMATIONS", "24")

    config = OracleConfig.from_env()

    assert config.source_confirmations == 24


def test_source_confirmations_must_be_positive(monkeypatch):
    monkeypatch.setenv("ORACLE_CONTRACT_ADDRESS", "0x0000000000000000000000000000000000000001")
    monkeypatch.setenv("SOURCE_CONFIRMATIONS", "0")

    with pytest.raises(ValueError, match="SOURCE_CONFIRMATIONS must be positive"):
        OracleConfig.from_env()
