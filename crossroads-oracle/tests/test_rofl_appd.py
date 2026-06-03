"""Tests for the ROFL appd client's pure helpers (payload + response)."""

import codecs

import cbor2
import pytest

import rofl_appd


def test_build_tx_payload_strips_0x_and_stringifies_value():
    payload = rofl_appd.build_tx_payload(
        to="0xD22bcCbb387464dd99c573aBf583b00F55626552",
        data="0x15bf8212abcdef",
        gas_limit=300_000,
        value=0,
    )

    tx = payload["tx"]
    assert tx["kind"] == "eth"
    # appd wants hex WITHOUT 0x for both `to` and `data`.
    assert tx["data"]["to"] == "D22bcCbb387464dd99c573aBf583b00F55626552"
    assert tx["data"]["data"] == "15bf8212abcdef"
    # value must be a STRING.
    assert tx["data"]["value"] == "0"
    assert isinstance(tx["data"]["value"], str)
    assert tx["data"]["gas_limit"] == 300_000
    # We submit in the clear by default (origin auth is independent of this).
    assert payload["encrypt"] is False


def test_build_tx_payload_handles_already_unprefixed_hex():
    payload = rofl_appd.build_tx_payload(to="abcd", data="", gas_limit=21000)
    assert payload["tx"]["data"]["to"] == "abcd"
    assert payload["tx"]["data"]["data"] == ""


def test_interpret_response_ok_does_not_raise():
    ok_hex = codecs.encode(cbor2.dumps({"ok": ""}), "hex").decode()
    # Should simply return None.
    assert rofl_appd.interpret_response(ok_hex) is None


def test_interpret_response_fail_raises():
    fail_hex = codecs.encode(
        cbor2.dumps({"fail": {"module": "evm", "code": 8, "message": "reverted"}}),
        "hex",
    ).decode()

    with pytest.raises(RuntimeError, match="ROFL tx failed"):
        rofl_appd.interpret_response(fail_hex)
