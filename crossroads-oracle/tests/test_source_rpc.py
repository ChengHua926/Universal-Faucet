import pytest
from eth_utils import keccak

from evm_header import build_rlp_header
from source_rpc import (
    BlockTooNewError,
    HeaderQuorumError,
    SourceRpcClient,
    SourceRpcConfig,
    SourceUnavailableError,
)

URLS = ("rpc0", "rpc1", "rpc2")
CHAIN_ID = 11155111


def test_two_of_three_hash_quorum_accepts_one_disagreement():
    common = _block(187, "11")
    other = _block(187, "aa")
    rpc = _FakeRpc(tips=(200, 199, 199), blocks=(common, common, other))
    client = _client(rpc)
    client.validate_sources()

    result = client.get_confirmed_header(187)

    assert result.block_number == 187
    assert result.block_hash == common["hash"]
    assert result.quorum_tip == 199
    assert result.observed_confirmations == 12


def test_lagging_rpc_does_not_hold_back_latest_confirmed():
    block = _block(187, "11")
    rpc = _FakeRpc(tips=(200, 199, 120), blocks=(block, block, block))
    client = _client(rpc)
    client.validate_sources()

    result = client.get_latest_confirmed_header()

    assert result.block_number == 187
    assert result.quorum_tip == 199


def test_block_too_new_when_depth_quorum_is_missing():
    block = _block(188, "11")
    rpc = _FakeRpc(tips=(200, 199, 120), blocks=(block, block, block))
    client = _client(rpc)
    client.validate_sources()

    with pytest.raises(BlockTooNewError):
        client.get_confirmed_header(188)


def test_all_different_hashes_fail_quorum():
    rpc = _FakeRpc(
        tips=(200, 200, 200),
        blocks=(_block(187, "11"), _block(187, "22"), _block(187, "33")),
    )
    client = _client(rpc)
    client.validate_sources()

    with pytest.raises(HeaderQuorumError):
        client.get_confirmed_header(187)


def test_chain_id_mismatch_is_rejected_at_startup():
    rpc = _FakeRpc(tips=(200, 200, 200), chain_ids=(CHAIN_ID, CHAIN_ID, 1))
    client = SourceRpcClient(
        SourceRpcConfig(URLS, quorum=3, confirmations=12, chain_id=CHAIN_ID), rpc.call
    )

    with pytest.raises(SourceUnavailableError):
        client.validate_sources()


def test_finalized_quorum_is_enforced():
    block = _block(187, "11")
    rpc = _FakeRpc(tips=(220, 220, 220), finalized=(190, 188, 120), blocks=(block, block, block))
    client = SourceRpcClient(
        SourceRpcConfig(URLS, quorum=2, confirmations=12, chain_id=CHAIN_ID, require_finalized=True),
        rpc.call,
    )
    client.validate_sources()

    result = client.get_confirmed_header(187)

    assert result.finalized_block_number == 188
    assert result.require_finalized is True


class _FakeRpc:
    def __init__(self, tips=(200, 200, 200), finalized=(0, 0, 0), blocks=None, chain_ids=None):
        self.tips = dict(zip(URLS, tips))
        self.finalized = dict(zip(URLS, finalized))
        self.blocks = dict(zip(URLS, blocks or (_block(187, "11"),) * 3))
        self.chain_ids = dict(zip(URLS, chain_ids or (CHAIN_ID,) * 3))

    def call(self, url, method, params):
        if method == "eth_chainId":
            return hex(self.chain_ids[url])
        if method == "eth_blockNumber":
            return hex(self.tips[url])
        if method == "eth_getBlockByNumber" and params[0] == "finalized":
            return {"number": hex(self.finalized[url])}
        if method == "eth_getBlockByNumber":
            return self.blocks[url]
        raise AssertionError(method)


def _client(rpc):
    return SourceRpcClient(
        SourceRpcConfig(URLS, quorum=2, confirmations=12, chain_id=CHAIN_ID), rpc.call
    )


def _block(number, parent_byte):
    block = {
        "parentHash": "0x" + parent_byte * 32,
        "sha3Uncles": "0x" + "22" * 32,
        "miner": "0x" + "33" * 20,
        "stateRoot": "0x" + "44" * 32,
        "transactionsRoot": "0x" + "55" * 32,
        "receiptsRoot": "0x" + "66" * 32,
        "logsBloom": "0x" + "00" * 256,
        "difficulty": "0x0",
        "number": hex(number),
        "gasLimit": "0x1c9c380",
        "gasUsed": "0x5208",
        "timestamp": "0x65",
        "extraData": "0x",
        "mixHash": "0x" + "aa" * 32,
        "nonce": "0x" + "00" * 8,
        "baseFeePerGas": "0x7",
        "withdrawalsRoot": "0x" + "77" * 32,
        "blobGasUsed": "0x0",
        "excessBlobGas": "0x2",
        "parentBeaconBlockRoot": "0x" + "88" * 32,
        "requestsHash": "0x" + "99" * 32,
    }
    block["hash"] = "0x" + keccak(build_rlp_header(block)).hex()
    return block
