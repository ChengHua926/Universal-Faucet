from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx
from eth_utils import keccak

from .evm_header import HeaderCanonicalizationError, build_rlp_header


class SourceRpcError(Exception):
    status_code = 500
    error_code = "source_rpc_error"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class BlockTooNewError(SourceRpcError):
    status_code = 400
    error_code = "block_too_new"


class SourceUnavailableError(SourceRpcError):
    status_code = 503
    error_code = "source_unavailable"


class HeaderQuorumError(SourceRpcError):
    status_code = 409
    error_code = "header_quorum_failure"


@dataclass(frozen=True)
class SourceRpcConfig:
    urls: tuple[str, ...]
    quorum: int
    confirmations: int
    chain_id: int
    require_finalized: bool = False
    timeout_seconds: float = 10.0


@dataclass(frozen=True)
class SourceEndpoint:
    source_index: int
    url: str


@dataclass(frozen=True)
class RpcVote:
    source_index: int
    url: str
    tip: int | None
    finalized_block_number: int | None
    block_hash: str | None
    recomputed_block_hash: str | None
    ok: bool
    error: str | None
    rlp_header: bytes | None = field(default=None, repr=False, compare=False)

    def to_json(self) -> dict[str, Any]:
        return {
            "sourceIndex": self.source_index,
            "url": self.url,
            "tip": self.tip,
            "finalizedBlockNumber": self.finalized_block_number,
            "blockHash": self.block_hash,
            "recomputedBlockHash": self.recomputed_block_hash,
            "ok": self.ok,
            "error": self.error,
        }


@dataclass(frozen=True)
class SourceStatus:
    tips: dict[int, int]
    finalized_numbers: dict[int, int]
    quorum_tip: int
    quorum_finalized_block_number: int | None


@dataclass(frozen=True)
class ConfirmedHeaderResult:
    source_chain_id: int
    block_number: int
    block_hash: str
    rlp_header: bytes
    votes: tuple[RpcVote, ...]
    required_confirmations: int
    observed_confirmations: int
    quorum_tip: int
    require_finalized: bool
    finalized_block_number: int | None


RpcCall = Callable[[str, str, list[Any]], Any]


class SourceRpcClient:
    def __init__(
        self,
        config: SourceRpcConfig,
        rpc_call: RpcCall | None = None,
    ) -> None:
        if config.quorum <= 0:
            raise ValueError("SOURCE_RPC_QUORUM must be positive")
        if not config.urls:
            raise ValueError("SOURCE_RPC_URLS must not be empty")
        self.config = config
        self._rpc_call = rpc_call
        self._valid_sources: tuple[SourceEndpoint, ...] = ()

    @property
    def valid_sources(self) -> tuple[SourceEndpoint, ...]:
        return self._valid_sources

    def validate_sources(self) -> tuple[SourceEndpoint, ...]:
        valid: list[SourceEndpoint] = []
        for index, url in enumerate(self.config.urls):
            try:
                chain_id = _parse_quantity(self._rpc(url, "eth_chainId", []))
            except Exception as exc:
                print(f"[source-rpc] rejected {url}: eth_chainId failed: {exc}", flush=True)
                continue
            if chain_id != self.config.chain_id:
                print(
                    f"[source-rpc] rejected {url}: chainId {chain_id} != "
                    f"{self.config.chain_id}",
                    flush=True,
                )
                continue
            valid.append(SourceEndpoint(index, url))

        if len(valid) < self.config.quorum:
            raise SourceUnavailableError(
                f"only {len(valid)} source RPCs matched chainId; "
                f"quorum is {self.config.quorum}"
            )

        self._valid_sources = tuple(valid)
        return self._valid_sources

    def get_latest_confirmed_header(self) -> ConfirmedHeaderResult:
        status = self._fetch_status()
        block_number = status.quorum_tip - self.config.confirmations
        if self.config.require_finalized:
            if status.quorum_finalized_block_number is None:
                raise SourceUnavailableError("finalized quorum is unavailable")
            block_number = min(block_number, status.quorum_finalized_block_number)
        if block_number < 0:
            raise SourceUnavailableError("no confirmed source block is available")
        return self._fetch_confirmed_header(block_number, status)

    def get_confirmed_header(self, block_number: int) -> ConfirmedHeaderResult:
        if block_number < 0:
            raise BlockTooNewError("block_number must be non-negative")
        return self._fetch_confirmed_header(block_number, self._fetch_status())

    def _fetch_status(self) -> SourceStatus:
        self._require_valid_sources()
        tip_results = self._call_sources("eth_blockNumber", [])
        tips: dict[int, int] = {}
        for source, result in tip_results.items():
            if result.ok:
                tips[source.source_index] = _parse_quantity(result.value)

        quorum_tip = _quorum_threshold(tips.values(), self.config.quorum, "tip")

        finalized_numbers: dict[int, int] = {}
        quorum_finalized: int | None = None
        if self.config.require_finalized:
            finalized_results = self._call_sources(
                "eth_getBlockByNumber", ["finalized", False]
            )
            for source, result in finalized_results.items():
                if not result.ok:
                    continue
                block = result.value
                if not isinstance(block, dict) or block.get("number") is None:
                    continue
                finalized_numbers[source.source_index] = _parse_quantity(block["number"])
            quorum_finalized = _quorum_threshold(
                finalized_numbers.values(), self.config.quorum, "finalized block"
            )

        return SourceStatus(
            tips=tips,
            finalized_numbers=finalized_numbers,
            quorum_tip=quorum_tip,
            quorum_finalized_block_number=quorum_finalized,
        )

    def _fetch_confirmed_header(
        self, block_number: int, status: SourceStatus
    ) -> ConfirmedHeaderResult:
        required_tip = block_number + self.config.confirmations
        confirmed_tip_count = sum(1 for tip in status.tips.values() if tip >= required_tip)
        if confirmed_tip_count < self.config.quorum:
            raise BlockTooNewError(
                f"block {block_number} requires quorum tip >= {required_tip}; "
                f"only {confirmed_tip_count} source RPCs satisfy it"
            )

        finalized_block_number: int | None = None
        if self.config.require_finalized:
            finalized_block_number = status.quorum_finalized_block_number
            if finalized_block_number is None:
                raise SourceUnavailableError("finalized quorum is unavailable")
            finalized_count = sum(
                1
                for finalized in status.finalized_numbers.values()
                if finalized >= block_number
            )
            if finalized_count < self.config.quorum:
                raise BlockTooNewError(
                    f"block {block_number} is not finalized by source RPC quorum"
                )

        block_tag = hex(block_number)
        block_results = self._call_sources("eth_getBlockByNumber", [block_tag, False])
        votes = self._build_votes(block_number, block_results, status)

        winner_hash = _find_quorum_hash(votes, self.config.quorum)
        winner_vote = next(
            (vote for vote in votes if vote.recomputed_block_hash == winner_hash and vote.rlp_header),
            None,
        )
        if winner_vote is None or winner_vote.rlp_header is None:
            raise HeaderQuorumError("winning header quorum had no usable RLP header")

        return ConfirmedHeaderResult(
            source_chain_id=self.config.chain_id,
            block_number=block_number,
            block_hash=winner_hash,
            rlp_header=winner_vote.rlp_header,
            votes=tuple(votes),
            required_confirmations=self.config.confirmations,
            observed_confirmations=status.quorum_tip - block_number,
            quorum_tip=status.quorum_tip,
            require_finalized=self.config.require_finalized,
            finalized_block_number=finalized_block_number,
        )

    def _build_votes(
        self,
        block_number: int,
        block_results: dict[SourceEndpoint, "_RpcResult"],
        status: SourceStatus,
    ) -> list[RpcVote]:
        votes: list[RpcVote] = []
        for source in self._valid_sources:
            tip = status.tips.get(source.source_index)
            finalized = status.finalized_numbers.get(source.source_index)
            result = block_results[source]
            if not result.ok:
                votes.append(
                    RpcVote(
                        source.source_index,
                        source.url,
                        tip,
                        finalized,
                        None,
                        None,
                        False,
                        result.error,
                    )
                )
                continue

            block = result.value
            if block is None:
                votes.append(
                    RpcVote(
                        source.source_index,
                        source.url,
                        tip,
                        finalized,
                        None,
                        None,
                        False,
                        "eth_getBlockByNumber returned null",
                    )
                )
                continue
            if not isinstance(block, dict):
                votes.append(
                    RpcVote(
                        source.source_index,
                        source.url,
                        tip,
                        finalized,
                        None,
                        None,
                        False,
                        "eth_getBlockByNumber returned a non-object result",
                    )
                )
                continue

            block_hash = block.get("hash")
            try:
                number = _parse_quantity(block.get("number"))
                if number != block_number:
                    raise HeaderCanonicalizationError(
                        f"returned block number {number} != requested {block_number}"
                    )
                rlp_header = build_rlp_header(block)
                recomputed = "0x" + keccak(rlp_header).hex()
                if not isinstance(block_hash, str):
                    raise HeaderCanonicalizationError("hash must be a hex string")
                if recomputed.lower() != block_hash.lower():
                    votes.append(
                        RpcVote(
                            source.source_index,
                            source.url,
                            tip,
                            finalized,
                            block_hash,
                            recomputed,
                            False,
                            f"recomputed block hash {recomputed} does not match "
                            f"JSON hash {block_hash}",
                        )
                    )
                    continue
                votes.append(
                    RpcVote(
                        source.source_index,
                        source.url,
                        tip,
                        finalized,
                        block_hash,
                        recomputed,
                        True,
                        None,
                        rlp_header,
                    )
                )
            except (HeaderCanonicalizationError, ValueError, TypeError) as exc:
                votes.append(
                    RpcVote(
                        source.source_index,
                        source.url,
                        tip,
                        finalized,
                        block_hash if isinstance(block_hash, str) else None,
                        None,
                        False,
                        str(exc),
                    )
                )
        return votes

    def _call_sources(
        self,
        method: str,
        params: list[Any],
    ) -> dict[SourceEndpoint, "_RpcResult"]:
        self._require_valid_sources()
        results: dict[SourceEndpoint, _RpcResult] = {}
        with ThreadPoolExecutor(max_workers=len(self._valid_sources)) as executor:
            futures = {
                executor.submit(self._rpc, source.url, method, params): source
                for source in self._valid_sources
            }
            for future in as_completed(futures):
                source = futures[future]
                try:
                    results[source] = _RpcResult(True, future.result(), None)
                except Exception as exc:
                    results[source] = _RpcResult(False, None, str(exc))
        return results

    def _rpc(self, url: str, method: str, params: list[Any]) -> Any:
        if self._rpc_call is not None:
            return self._rpc_call(url, method, params)

        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        with httpx.Client(timeout=self.config.timeout_seconds) as client:
            response = client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()
        if "error" in data:
            raise RuntimeError(data["error"])
        if "result" not in data:
            raise RuntimeError("JSON-RPC response missing result")
        return data["result"]

    def _require_valid_sources(self) -> None:
        if len(self._valid_sources) < self.config.quorum:
            raise SourceUnavailableError(
                "source RPC client has not been validated with enough usable RPCs"
            )


@dataclass(frozen=True)
class _RpcResult:
    ok: bool
    value: Any
    error: str | None


def _parse_quantity(value: Any) -> int:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise ValueError("expected hex quantity")
    return int(value, 16)


def _quorum_threshold(values: Any, quorum: int, label: str) -> int:
    sorted_values = sorted((int(value) for value in values), reverse=True)
    if len(sorted_values) < quorum:
        raise SourceUnavailableError(
            f"only {len(sorted_values)} source RPCs returned {label}; quorum is {quorum}"
        )
    return sorted_values[quorum - 1]


def _find_quorum_hash(votes: list[RpcVote], quorum: int) -> str:
    counts: dict[str, int] = {}
    for vote in votes:
        if not vote.ok or vote.recomputed_block_hash is None:
            continue
        normalized = vote.recomputed_block_hash.lower()
        counts[normalized] = counts.get(normalized, 0) + 1

    for block_hash, count in counts.items():
        if count >= quorum:
            return block_hash
    raise HeaderQuorumError("source RPC block header hash did not reach quorum")
