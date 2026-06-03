"""Multi-chain Model B: one TEE container serving every EVM chain.

Instead of hardcoding one chain's RPC set at startup, each request names an
on-chain HeaderReportOracle contract. We read that contract's source config
(chain id, confirmations, finality, RPC URLs, quorum) and build a signed report
bound to THAT contract. Because the report digest already binds
oracleContractAddress + sourceChainId (see header_report.report_digest), a report
is only ever valid for the contract it was built for.

Two gates keep an attacker from conscripting the TEE into doing free work / SSRF:
  1. The contract's roflAppID must equal OUR app id, and its headerSigner must
     equal OUR signer address — i.e. it deliberately opted into this container.
     Checked before any source-RPC work.
  2. Every RPC URL is SSRF-guarded (url_guard) and the URL count is capped.

Per contract we cache a fully-wired HeaderReportService (which itself handles
report caching, re-signing, and the per-sign headerSigner re-check), refreshing
the resolved config on a TTL so URL/quorum edits via redeploy are picked up.
"""

import time
from dataclasses import dataclass
from typing import Any, Callable

from web3 import Web3

from contract_client import normalize_rofl_app_id_bytes
from rate_limit import FixedWindowRateLimiter
from report_cache import ReportCache
from server import HeaderReportService, HeaderReportServiceConfig
from source_rpc import SourceRpcClient, SourceRpcConfig, SourceRpcError
from url_guard import assert_safe_url

DEFAULT_MAX_SOURCE_RPC_URLS = 16
DEFAULT_CONFIG_TTL_SECONDS = 300


class OracleAppIdMismatchError(SourceRpcError):
    status_code = 403
    error_code = "oracle_app_id_mismatch"


class OracleSignerNotRegisteredError(SourceRpcError):
    status_code = 409
    error_code = "oracle_signer_not_registered"


class TooManyRpcUrlsError(SourceRpcError):
    status_code = 400
    error_code = "too_many_rpc_urls"


class InvalidOracleConfigError(SourceRpcError):
    status_code = 502
    error_code = "invalid_oracle_config"


@dataclass(frozen=True)
class ResolvedSourceConfig:
    oracle_contract_address: str
    source_chain_id: int
    min_confirmations: int
    mandate_finalized: bool
    rpc_urls: tuple[str, ...]
    rpc_quorum: int
    header_signer: str
    header_signer_epoch: int


def resolve_source_config(
    contract: Any,
    *,
    expected_app_id_bytes: bytes,
    signer_address: str,
    max_urls: int = DEFAULT_MAX_SOURCE_RPC_URLS,
) -> ResolvedSourceConfig:
    """Read + validate a contract's source config, enforcing the identity gate.

    Order matters: the app-id and signer gates run BEFORE the SSRF/URL checks so
    we never resolve DNS for a contract that hasn't opted into this container.
    """
    try:
        contract_app_id = normalize_rofl_app_id_bytes(contract.functions.roflAppID().call())
    except SourceRpcError:
        raise
    except Exception as exc:  # noqa: BLE001 - any read/ABI failure is a bad config
        raise InvalidOracleConfigError(f"failed reading oracle config: {exc}")

    if contract_app_id != expected_app_id_bytes:
        raise OracleAppIdMismatchError(
            "oracle roflAppID does not match this container's app id"
        )

    try:
        chain_header_signer = Web3.to_checksum_address(contract.functions.headerSigner().call())
        header_signer_epoch = int(contract.functions.headerSignerEpoch().call())
        source_chain_id = int(contract.functions.expectedSourceChainId().call())
        min_confirmations = int(contract.functions.minConfirmations().call())
        mandate_finalized = bool(contract.functions.mandateFinalized().call())
        raw_urls = list(contract.functions.sourceRpcUrls().call())
        rpc_quorum = int(contract.functions.sourceRpcQuorum().call())
    except Exception as exc:  # noqa: BLE001
        raise InvalidOracleConfigError(f"failed reading oracle config: {exc}")

    want = Web3.to_checksum_address(signer_address)
    if chain_header_signer != want:
        raise OracleSignerNotRegisteredError(
            f"oracle headerSigner {chain_header_signer} is not this container's signer {want}"
        )

    urls = tuple(u.strip() for u in raw_urls if isinstance(u, str) and u.strip())
    if not urls:
        raise InvalidOracleConfigError("oracle exposes no source RPC URLs")
    if len(urls) > max_urls:
        raise TooManyRpcUrlsError(f"oracle lists {len(urls)} RPC URLs; max is {max_urls}")
    if rpc_quorum <= 0:
        raise InvalidOracleConfigError("oracle sourceRpcQuorum must be positive")
    if len(urls) < rpc_quorum:
        raise InvalidOracleConfigError("oracle lists fewer RPC URLs than its quorum")
    for url in urls:
        assert_safe_url(url)  # raises UnsafeRpcUrlError

    return ResolvedSourceConfig(
        oracle_contract_address=Web3.to_checksum_address(contract.address),
        source_chain_id=source_chain_id,
        min_confirmations=min_confirmations,
        mandate_finalized=mandate_finalized,
        rpc_urls=urls,
        rpc_quorum=rpc_quorum,
        header_signer=chain_header_signer,
        header_signer_epoch=header_signer_epoch,
    )


class MultiChainHeaderReportService:
    """Serves /v1/header for any opted-in HeaderReportOracle, keyed by address."""

    def __init__(
        self,
        *,
        contract_factory: Callable[[str], Any],
        signer_private_key: str,
        signer_address: str,
        sapphire_chain_id: int,
        expected_app_id_bytes: bytes,
        ttl_seconds: int,
        cache_size: int,
        cache_refresh_seconds: int,
        source_client_factory: Callable[[SourceRpcConfig], SourceRpcClient] | None = None,
        max_urls: int = DEFAULT_MAX_SOURCE_RPC_URLS,
        config_ttl_seconds: int = DEFAULT_CONFIG_TTL_SECONDS,
        per_config_rate_limit_per_minute: int = 0,
        source_rpc_timeout_seconds: float = 10.0,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._contract_factory = contract_factory
        self._signer_private_key = signer_private_key
        self._signer_address = Web3.to_checksum_address(signer_address)
        self._sapphire_chain_id = int(sapphire_chain_id)
        self._expected_app_id_bytes = expected_app_id_bytes
        self._ttl_seconds = int(ttl_seconds)
        self._cache_size = int(cache_size)
        self._cache_refresh_seconds = int(cache_refresh_seconds)
        self._source_client_factory = source_client_factory or self._default_source_client
        self._max_urls = int(max_urls)
        self._config_ttl_seconds = int(config_ttl_seconds)
        self._per_config_rate_limit = int(per_config_rate_limit_per_minute)
        self._source_rpc_timeout = float(source_rpc_timeout_seconds)
        self._now = now
        # address(lower) -> (HeaderReportService, resolved_at_ts)
        self._services: dict[str, tuple[HeaderReportService, float]] = {}
        self._limiters: dict[str, FixedWindowRateLimiter] = {}

    def _default_source_client(self, config: SourceRpcConfig) -> SourceRpcClient:
        client = SourceRpcClient(config)
        client.validate_sources()
        return client

    def get_header_report(self, oracle_contract_address: str, block_number: int) -> dict[str, Any]:
        self._enforce_rate_limit(oracle_contract_address)
        return self._service_for(oracle_contract_address).get_header_report(block_number)

    def get_latest_confirmed_report(self, oracle_contract_address: str) -> dict[str, Any]:
        self._enforce_rate_limit(oracle_contract_address)
        return self._service_for(oracle_contract_address).get_latest_confirmed_report()

    def _enforce_rate_limit(self, oracle_contract_address: str) -> None:
        if self._per_config_rate_limit <= 0:
            return
        key = Web3.to_checksum_address(oracle_contract_address).lower()
        limiter = self._limiters.get(key)
        if limiter is None:
            limiter = FixedWindowRateLimiter(self._per_config_rate_limit)
            self._limiters[key] = limiter
        if not limiter.allow():
            raise _RateLimitedError(f"rate limit exceeded for oracle {oracle_contract_address}")

    def _service_for(self, oracle_contract_address: str) -> HeaderReportService:
        key = Web3.to_checksum_address(oracle_contract_address).lower()
        cached = self._services.get(key)
        if cached is not None and (self._now() - cached[1]) < self._config_ttl_seconds:
            return cached[0]

        contract = self._contract_factory(oracle_contract_address)
        resolved = resolve_source_config(
            contract,
            expected_app_id_bytes=self._expected_app_id_bytes,
            signer_address=self._signer_address,
            max_urls=self._max_urls,
        )

        source_config = SourceRpcConfig(
            urls=resolved.rpc_urls,
            quorum=resolved.rpc_quorum,
            confirmations=resolved.min_confirmations,
            chain_id=resolved.source_chain_id,
            require_finalized=resolved.mandate_finalized,
            timeout_seconds=self._source_rpc_timeout,
            guard_urls=True,
        )
        source_client = self._source_client_factory(source_config)

        service = HeaderReportService(
            config=HeaderReportServiceConfig(
                source_chain_id=resolved.source_chain_id,
                require_finalized=resolved.mandate_finalized,
                sapphire_chain_id=self._sapphire_chain_id,
                oracle_contract_address=resolved.oracle_contract_address,
                ttl_seconds=self._ttl_seconds,
            ),
            source_client=source_client,
            contract=contract,
            signer_private_key=self._signer_private_key,
            signer_address=self._signer_address,
            signer_epoch=resolved.header_signer_epoch,
            cache=ReportCache(self._cache_size, self._cache_refresh_seconds),
        )
        self._services[key] = (service, self._now())
        return service


class _RateLimitedError(SourceRpcError):
    status_code = 429
    error_code = "rate_limited"
