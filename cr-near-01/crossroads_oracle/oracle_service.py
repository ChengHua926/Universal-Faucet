"""Model B oracle entrypoint (request-driven, signed reports).

Startup:
  1. Read our ROFL app id from appd; derive a deterministic secp256k1 header
     signer from ROFL KMS (never written to disk).
  2. Confirm the app id matches the oracle contract's roflAppID.
  3. register/skip/rotate the headerSigner on Sapphire via appd (TEE-attested,
     so the contract's onlyROFL passes).
  4. Validate source RPCs (chain id), require >= quorum usable.
  5. Serve TEE-signed HeaderReports over HTTP.

This does NOT push block hashes on-chain; it signs reports a client later relays
to HeaderReportOracle.submitSignedHeader.
"""

import os
from dataclasses import dataclass
from typing import Any

from dotenv import load_dotenv
from web3 import Web3

from contract_client import (
    build_header_signer_commitment,
    create_contract,
    normalize_rofl_app_id_bytes,
    plan_header_signer_registration,
    submit_registration_action,
)
from kms_key import fetch_or_derive_secp256k1_key
from multi_chain import (
    DEFAULT_CONFIG_TTL_SECONDS,
    DEFAULT_MAX_SOURCE_RPC_URLS,
    MultiChainHeaderReportService,
)
from rate_limit import FixedWindowRateLimiter
from report_cache import ReportCache
from rofl_appd import RoflAppdClient
from server import HeaderReportService, HeaderReportServiceConfig, run_http_server
from source_rpc import SourceRpcClient, SourceRpcConfig

DEFAULT_TARGET_RPC_URL = "https://testnet.sapphire.oasis.io"
DEFAULT_SAPPHIRE_CHAIN_ID = 23295
DEFAULT_SOURCE_RPC_URLS = (
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.drpc.org",
    "https://1rpc.io/sepolia",
)
DEFAULT_SOURCE_RPC_QUORUM = 2
DEFAULT_SOURCE_CONFIRMATIONS = 12
DEFAULT_SOURCE_CHAIN_ID = 11155111
DEFAULT_HEADER_REPORT_TTL_SECONDS = 1800
DEFAULT_HEADER_REPORT_CACHE_SIZE = 512
DEFAULT_HEADER_REPORT_CACHE_REFRESH_SECONDS = 120
DEFAULT_HTTP_HOST = "0.0.0.0"
DEFAULT_HTTP_PORT = 8080
DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE = 60
DEFAULT_ROFL_KMS_KEY_ID = "crossroads-header-signer-v1"


@dataclass(frozen=True)
class OracleConfig:
    mode: str
    target_rpc_url: str
    oracle_contract_address: str
    allow_signer_rotation: bool
    sapphire_chain_id: int
    source_rpc_urls: tuple[str, ...]
    source_rpc_quorum: int
    source_confirmations: int
    source_chain_id: int
    source_require_finalized: bool
    header_report_ttl_seconds: int
    header_report_cache_size: int
    header_report_cache_refresh_seconds: int
    http_host: str
    http_port: int
    http_rate_limit_per_minute: int
    rofl_kms_key_id: str
    multi_chain_max_source_rpc_urls: int
    multi_chain_config_ttl_seconds: int
    multi_chain_per_config_rate_limit_per_minute: int

    @classmethod
    def from_env(cls) -> "OracleConfig":
        contract_address = os.environ.get("ORACLE_CONTRACT_ADDRESS", "")
        if not contract_address:
            raise ValueError("Set ORACLE_CONTRACT_ADDRESS")

        source_confirmations = _int_env("SOURCE_CONFIRMATIONS", DEFAULT_SOURCE_CONFIRMATIONS)
        if source_confirmations <= 0:
            raise ValueError("SOURCE_CONFIRMATIONS must be positive")

        source_rpc_urls = _csv_env("SOURCE_RPC_URLS", DEFAULT_SOURCE_RPC_URLS)
        source_rpc_quorum = _int_env("SOURCE_RPC_QUORUM", DEFAULT_SOURCE_RPC_QUORUM)
        if source_rpc_quorum <= 0:
            raise ValueError("SOURCE_RPC_QUORUM must be positive")
        if len(source_rpc_urls) < source_rpc_quorum:
            raise ValueError("SOURCE_RPC_URLS must contain at least SOURCE_RPC_QUORUM URLs")

        ttl_seconds = _int_env("HEADER_REPORT_TTL_SECONDS", DEFAULT_HEADER_REPORT_TTL_SECONDS)
        if ttl_seconds <= 0:
            raise ValueError("HEADER_REPORT_TTL_SECONDS must be positive")

        return cls(
            mode=os.environ.get("ORACLE_MODE", "rofl"),
            target_rpc_url=os.environ.get("TARGET_RPC_URL", DEFAULT_TARGET_RPC_URL),
            oracle_contract_address=contract_address,
            allow_signer_rotation=os.environ.get("ALLOW_SIGNER_ROTATION", "0") == "1",
            sapphire_chain_id=_int_env("SAPPHIRE_CHAIN_ID", DEFAULT_SAPPHIRE_CHAIN_ID),
            source_rpc_urls=source_rpc_urls,
            source_rpc_quorum=source_rpc_quorum,
            source_confirmations=source_confirmations,
            source_chain_id=_int_env("SOURCE_CHAIN_ID", DEFAULT_SOURCE_CHAIN_ID),
            source_require_finalized=_bool_env("SOURCE_REQUIRE_FINALIZED", False),
            header_report_ttl_seconds=ttl_seconds,
            header_report_cache_size=_int_env("HEADER_REPORT_CACHE_SIZE", DEFAULT_HEADER_REPORT_CACHE_SIZE),
            header_report_cache_refresh_seconds=_int_env(
                "HEADER_REPORT_CACHE_REFRESH_SECONDS", DEFAULT_HEADER_REPORT_CACHE_REFRESH_SECONDS
            ),
            http_host=os.environ.get("HTTP_HOST", DEFAULT_HTTP_HOST),
            http_port=_int_env("HTTP_PORT", DEFAULT_HTTP_PORT),
            http_rate_limit_per_minute=_int_env("HTTP_RATE_LIMIT_PER_MINUTE", DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE),
            rofl_kms_key_id=os.environ.get("ROFL_KMS_KEY_ID", DEFAULT_ROFL_KMS_KEY_ID),
            multi_chain_max_source_rpc_urls=_int_env(
                "MULTI_CHAIN_MAX_SOURCE_RPC_URLS", DEFAULT_MAX_SOURCE_RPC_URLS
            ),
            multi_chain_config_ttl_seconds=_int_env(
                "MULTI_CHAIN_CONFIG_TTL_SECONDS", DEFAULT_CONFIG_TTL_SECONDS
            ),
            multi_chain_per_config_rate_limit_per_minute=_int_env(
                "MULTI_CHAIN_PER_CONFIG_RATE_LIMIT_PER_MINUTE", 0
            ),
        )

    def source_rpc_config(self) -> SourceRpcConfig:
        return SourceRpcConfig(
            urls=self.source_rpc_urls,
            quorum=self.source_rpc_quorum,
            confirmations=self.source_confirmations,
            chain_id=self.source_chain_id,
            require_finalized=self.source_require_finalized,
        )


@dataclass(frozen=True)
class HeaderSignerStartup:
    signer_key: Any
    signer_epoch: int
    contract: Any
    rofl_app_id: str


def register_header_signer(config: OracleConfig, rofl: RoflAppdClient) -> HeaderSignerStartup:
    if config.mode != "rofl":
        raise ValueError("Header signer registration must run with ORACLE_MODE=rofl")

    app_id = rofl.get_app_id()
    print(f"[rofl]  appd reports app id: {app_id}", flush=True)

    signer_key = _load_header_signer(config, rofl)
    print(f"[signer] header signer address: {signer_key.address}", flush=True)

    w3 = Web3(Web3.HTTPProvider(config.target_rpc_url))
    contract = create_contract(w3, config.oracle_contract_address)

    contract_rofl_app_id = contract.functions.roflAppID().call()
    if normalize_rofl_app_id_bytes(app_id) != normalize_rofl_app_id_bytes(contract_rofl_app_id):
        raise RuntimeError("ROFL app id reported by appd does not match the oracle contract")

    current_epoch = int(contract.functions.headerSignerEpoch().call())
    next_epoch = current_epoch + 1
    commitment = build_header_signer_commitment(
        config.sapphire_chain_id,
        config.oracle_contract_address,
        contract_rofl_app_id,
        signer_key.address,
        next_epoch,
    )
    print(f"[signer] registration commitment for epoch {next_epoch}: {commitment}", flush=True)

    action = plan_header_signer_registration(
        contract, signer_key.address, commitment, config.allow_signer_rotation
    )

    if action.action == "skip":
        print("[signer] chain already has this header signer; skipping", flush=True)
        return HeaderSignerStartup(signer_key, current_epoch, contract, app_id)

    print(f"[signer] submitting {action.action}HeaderSigner via ROFL appd", flush=True)
    submit_registration_action(rofl, config.oracle_contract_address, action)
    print("[signer] registration transaction submitted", flush=True)
    return HeaderSignerStartup(signer_key, next_epoch, contract, app_id)


def main() -> None:
    load_dotenv()
    config = OracleConfig.from_env()
    rofl = RoflAppdClient()
    startup = register_header_signer(config, rofl)

    source_client = SourceRpcClient(config.source_rpc_config())
    valid_sources = source_client.validate_sources()
    print(
        f"[source-rpc] {len(valid_sources)} RPCs usable; quorum is {config.source_rpc_quorum}",
        flush=True,
    )

    service = HeaderReportService(
        config=HeaderReportServiceConfig(
            source_chain_id=config.source_chain_id,
            require_finalized=config.source_require_finalized,
            sapphire_chain_id=config.sapphire_chain_id,
            oracle_contract_address=config.oracle_contract_address,
            ttl_seconds=config.header_report_ttl_seconds,
        ),
        source_client=source_client,
        contract=startup.contract,
        signer_private_key=startup.signer_key.private_key,
        signer_address=startup.signer_key.address,
        signer_epoch=startup.signer_epoch,
        cache=ReportCache(config.header_report_cache_size, config.header_report_cache_refresh_seconds),
    )

    # Same container, every chain: requests carrying ?config=0x... are served from
    # the named oracle contract's own source config (one container, no per-chain
    # deploy). The primary contract above is just the default when ?config is absent.
    w3_target = Web3(Web3.HTTPProvider(config.target_rpc_url))
    multi_service = MultiChainHeaderReportService(
        contract_factory=lambda addr: create_contract(w3_target, addr),
        signer_private_key=startup.signer_key.private_key,
        signer_address=startup.signer_key.address,
        sapphire_chain_id=config.sapphire_chain_id,
        expected_app_id_bytes=normalize_rofl_app_id_bytes(startup.rofl_app_id),
        ttl_seconds=config.header_report_ttl_seconds,
        cache_size=config.header_report_cache_size,
        cache_refresh_seconds=config.header_report_cache_refresh_seconds,
        rofl_client=rofl,
        max_urls=config.multi_chain_max_source_rpc_urls,
        config_ttl_seconds=config.multi_chain_config_ttl_seconds,
        per_config_rate_limit_per_minute=config.multi_chain_per_config_rate_limit_per_minute,
    )
    print(
        f"[start] MODEL B mode={config.mode} sources={len(valid_sources)} "
        f"quorum={config.source_rpc_quorum} confirmations={config.source_confirmations} "
        f"contract={config.oracle_contract_address} multi_chain=on",
        flush=True,
    )
    run_http_server(
        config.http_host,
        config.http_port,
        service,
        FixedWindowRateLimiter(config.http_rate_limit_per_minute),
        multi_service=multi_service,
    )


def _load_header_signer(config: OracleConfig, rofl: RoflAppdClient) -> Any:
    # The TEE (ROFL KMS) is the only signer: the key is derived in-enclave and
    # never persisted. No file-backed / non-TEE fallback exists.
    signer = fetch_or_derive_secp256k1_key(rofl, config.rofl_kms_key_id)
    print(f"[signer] using ROFL KMS key id {config.rofl_kms_key_id}", flush=True)
    return signer


def _int_env(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def _bool_env(name: str, default: bool) -> bool:
    if name not in os.environ:
        return default
    return os.environ[name] == "1"


def _csv_env(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    value = os.environ.get(name)
    if value is None:
        return default
    items = tuple(item.strip() for item in value.split(",") if item.strip())
    if not items:
        raise ValueError(f"{name} must contain at least one URL")
    return items


if __name__ == "__main__":
    main()
