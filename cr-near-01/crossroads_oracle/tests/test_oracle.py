"""Tests for the oracle's coverage logic: multi-RPC agreement + gap-free window."""

from web3 import Web3

import oracle


# --- Fake sources -------------------------------------------------------------


class FakeEth:
    def __init__(self, hashes_by_block, tip=None, fail=False):
        self._hashes = hashes_by_block
        self._tip = tip
        self._fail = fail

    @property
    def block_number(self):
        if self._fail:
            raise ConnectionError("source down")
        return self._tip

    def get_block(self, number, full_transactions=False):
        if self._fail:
            raise ConnectionError("source down")
        return {"hash": self._hashes[number]}  # KeyError if missing -> treated as error


class FakeW3:
    def __init__(self, hashes_by_block, tip=None, fail=False):
        self.eth = FakeEth(hashes_by_block, tip, fail)


def mksrc(name, hashes_by_block, fail=False):
    return (name, FakeW3(hashes_by_block, fail=fail))


H = "0x" + "aa" * 32
X = "0x" + "bb" * 32
Y = "0x" + "cc" * 32


def _b(hexstr):
    return Web3.to_bytes(hexstr=hexstr)


# --- majority_hash ------------------------------------------------------------


def test_majority_all_agree():
    assert oracle.majority_hash([H, H, H], 2) == H


def test_majority_two_of_three_wins():
    assert oracle.majority_hash([H, H, X], 2) == H


def test_majority_no_agreement_returns_none():
    assert oracle.majority_hash([H, X, Y], 2) is None


def test_majority_empty_returns_none():
    assert oracle.majority_hash([], 2) is None


# --- compute_window (the gap-free coverage planner) ---------------------------


def test_window_first_run_covers_trailing_batch():
    # min tip 100, conf 6 -> end 94; batch 16 -> start 79.
    assert oracle.compute_window({"a": 100, "b": 100}, 6, 16, None) == (79, 94)


def test_window_advances_forward_from_last_submitted():
    # end 94, last 90 -> fill 91..94 (no gap).
    assert oracle.compute_window({"a": 100}, 6, 16, 90) == (91, 94)


def test_window_caps_catchup_to_batch_size():
    # far behind: last 50, end 94 -> start 51, capped to batch 16 -> end 66.
    assert oracle.compute_window({"a": 100}, 6, 16, 50) == (51, 66)


def test_window_none_when_no_new_blocks():
    assert oracle.compute_window({"a": 100}, 6, 16, 94) is None  # end == last
    assert oracle.compute_window({"a": 100}, 6, 16, 200) is None  # end < last


def test_window_uses_min_tip_so_all_sources_have_the_block():
    # tips 100/98/102 -> min 98 -> end 92.
    assert oracle.compute_window({"a": 100, "b": 98, "c": 102}, 6, 16, 91) == (92, 92)


def test_window_none_when_chain_too_short():
    assert oracle.compute_window({"a": 3}, 6, 16, None) is None


# --- quorum_hash_for_block ----------------------------------------------------


def test_quorum_block_majority_wins_over_one_liar():
    sources = [
        mksrc("a", {10: _b(H)}),
        mksrc("b", {10: _b(H)}),
        mksrc("c", {10: _b(X)}),  # liar / out of sync
    ]
    assert oracle.quorum_hash_for_block(sources, 10, 2) == H


def test_quorum_block_tolerates_one_down_source():
    sources = [
        mksrc("a", {10: _b(H)}),
        mksrc("b", {10: _b(H)}),
        mksrc("c", {}, fail=True),
    ]
    assert oracle.quorum_hash_for_block(sources, 10, 2) == H


def test_quorum_block_none_when_all_disagree():
    sources = [mksrc("a", {10: _b(H)}), mksrc("b", {10: _b(X)}), mksrc("c", {10: _b(Y)})]
    assert oracle.quorum_hash_for_block(sources, 10, 2) is None


# --- collect_window (contiguity guarantee) ------------------------------------


def test_collect_window_all_agree_is_contiguous():
    H1, H2, H3 = _b("0x" + "01" * 32), _b("0x" + "02" * 32), _b("0x" + "03" * 32)
    sources = [mksrc(n, {10: H1, 11: H2, 12: H3}) for n in ("a", "b", "c")]
    pairs = oracle.collect_window(sources, 10, 12, 2)
    assert [b for b, _ in pairs] == [10, 11, 12]


def test_collect_window_stops_at_first_disagreement_no_gap():
    H1 = _b("0x" + "01" * 32)
    # block 11 disagrees everywhere -> stop after 10, do NOT skip to 12.
    sources = [
        mksrc("a", {10: H1, 11: _b("0x" + "a1" * 32), 12: H1}),
        mksrc("b", {10: H1, 11: _b("0x" + "b2" * 32), 12: H1}),
        mksrc("c", {10: H1, 11: _b("0x" + "c3" * 32), 12: H1}),
    ]
    pairs = oracle.collect_window(sources, 10, 12, 2)
    assert [b for b, _ in pairs] == [10]


# --- calldata -----------------------------------------------------------------


def test_storeblockhashes_calldata_encodes():
    w3 = Web3()
    c = w3.eth.contract(
        address="0xD22bcCbb387464dd99c573aBf583b00F55626552", abi=oracle.ORACLE_ABI
    )
    data = c.encode_abi("storeBlockHashes", [[10, 11], [b"\x01" * 32, b"\x02" * 32]])
    assert data.startswith("0x")
    # dynamic arrays -> offsets + lengths + 2 elems each; well over the single-call size.
    assert len(data) > 2 + (4 + 32) * 2
