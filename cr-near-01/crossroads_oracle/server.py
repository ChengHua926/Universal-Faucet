"""HTTP API that serves TEE-signed header reports on demand.

Endpoints:
  GET /                             service index; lists endpoints, no RPC/contract calls
  GET /healthz                      cheap liveness; no RPC/contract calls
  GET /v1/header?block_number=N     signed report for block N once quorum-confirmed
  GET /v1/header/latest-confirmed   signed report for the newest quorum-confirmed block

Before signing, it re-reads the on-chain headerSigner and REFUSES to sign if the
chain's signer no longer matches our local one (503) — so a rotated-away enclave
can't keep minting reports the contract would reject anyway. Fresh cache hits skip
both the source RPCs and re-signing.
"""

import json
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from web3 import Web3

from rate_limit import FixedWindowRateLimiter
from report_builder import build_signed_header_report
from report_cache import ReportCache, ReportCacheKey
from source_rpc import SourceRpcClient, SourceRpcError


class SignerMismatchError(RuntimeError):
    pass


@dataclass(frozen=True)
class HeaderReportServiceConfig:
    source_chain_id: int
    require_finalized: bool
    sapphire_chain_id: int
    oracle_contract_address: str
    ttl_seconds: int


class HeaderReportService:
    def __init__(
        self,
        config: HeaderReportServiceConfig,
        source_client: SourceRpcClient,
        contract: Any,
        signer_private_key: str,
        signer_address: str,
        signer_epoch: int,
        cache: ReportCache,
    ) -> None:
        self.config = config
        self.source_client = source_client
        self.contract = contract
        self.signer_private_key = signer_private_key
        self.signer_address = Web3.to_checksum_address(signer_address)
        self.signer_epoch = int(signer_epoch)
        self.cache = cache

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "sourceChainId": self.config.source_chain_id,
            "sourceRpcQuorum": self.source_client.config.quorum,
            "requiredConfirmations": self.source_client.config.confirmations,
            "requireFinalized": self.config.require_finalized,
            "signer": self.signer_address,
            "signerEpoch": self.signer_epoch,
        }

    def index(self) -> dict[str, Any]:
        """Human-friendly landing page for the root path. Cheap: no RPC/contract calls."""
        return {
            "ok": True,
            "service": "crossroads-oracle",
            "description": "TEE-signed Ethereum block header reports (Model B).",
            "sourceChainId": self.config.source_chain_id,
            "sapphireChainId": self.config.sapphire_chain_id,
            "oracleContract": Web3.to_checksum_address(self.config.oracle_contract_address),
            "signer": self.signer_address,
            "signerEpoch": self.signer_epoch,
            "endpoints": {
                "GET /healthz": "liveness; no RPC/contract calls",
                "GET /v1/header/latest-confirmed": "signed report for the newest quorum-confirmed block",
                "GET /v1/header?block_number=N": "signed report for block N once quorum-confirmed",
            },
        }

    def get_header_report(self, block_number: int) -> dict[str, Any]:
        cached = self._get_cached(block_number)
        if cached is not None and not self.cache.should_refresh(cached):
            return cached
        result = self.source_client.get_confirmed_header(block_number)
        return self._sign_or_cache_result(result)

    def get_latest_confirmed_report(self) -> dict[str, Any]:
        result = self.source_client.get_latest_confirmed_header()
        cached = self._get_cached(result.block_number)
        if cached is not None and not self.cache.should_refresh(cached):
            return cached
        return self._sign_or_cache_result(result)

    def _sign_or_cache_result(self, result: Any) -> dict[str, Any]:
        self._refresh_chain_signer_state()
        key = self._cache_key(result.block_number)
        cached = self.cache.get(key)
        if cached is not None and not self.cache.should_refresh(cached):
            return cached

        report = build_signed_header_report(
            result=result,
            private_key=self.signer_private_key,
            signer_address=self.signer_address,
            signer_epoch=self.signer_epoch,
            oracle_contract_address=self.config.oracle_contract_address,
            sapphire_chain_id=self.config.sapphire_chain_id,
            ttl_seconds=self.config.ttl_seconds,
        )
        self.cache.set(key, report)
        return report

    def _get_cached(self, block_number: int) -> dict[str, Any] | None:
        return self.cache.get(self._cache_key(block_number))

    def _cache_key(self, block_number: int) -> ReportCacheKey:
        return (
            int(self.config.source_chain_id),
            int(block_number),
            int(self.signer_epoch),
            Web3.to_checksum_address(self.config.oracle_contract_address),
            int(self.config.sapphire_chain_id),
            bool(self.config.require_finalized),
        )

    def _refresh_chain_signer_state(self) -> None:
        chain_signer = Web3.to_checksum_address(self.contract.functions.headerSigner().call())
        chain_epoch = int(self.contract.functions.headerSignerEpoch().call())
        if chain_signer.lower() != self.signer_address.lower():
            raise SignerMismatchError(
                f"signer_mismatch: chain has {chain_signer}, local signer is {self.signer_address}"
            )
        self.signer_epoch = chain_epoch


def run_http_server(
    host: str, port: int, service: HeaderReportService, limiter: FixedWindowRateLimiter
) -> None:
    handler = _make_handler(service, limiter)
    server = ThreadingHTTPServer((host, int(port)), handler)
    print(f"[http]  listening on {host}:{port}", flush=True)
    server.serve_forever()


def _make_handler(
    service: HeaderReportService, limiter: FixedWindowRateLimiter
) -> type[BaseHTTPRequestHandler]:
    class HeaderRequestHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            try:
                if parsed.path in ("/", ""):
                    self._send_json(200, service.index())
                    return

                if parsed.path == "/healthz":
                    self._send_json(200, service.health())
                    return

                if not limiter.allow():
                    self._send_json(429, {"ok": False, "error": "rate_limited"})
                    return

                if parsed.path == "/v1/header/latest-confirmed":
                    self._send_json(200, service.get_latest_confirmed_report())
                    return

                if parsed.path == "/v1/header":
                    query = parse_qs(parsed.query)
                    block_values = query.get("block_number")
                    if not block_values:
                        self._send_json(400, {"ok": False, "error": "missing block_number"})
                        return
                    block_number = _parse_block_number(block_values[0])
                    self._send_json(200, service.get_header_report(block_number))
                    return

                self._send_json(404, {"ok": False, "error": "not_found"})
            except SourceRpcError as exc:
                self._send_json(exc.status_code, {"ok": False, "error": exc.error_code, "message": exc.message})
            except SignerMismatchError as exc:
                self._send_json(503, {"ok": False, "error": "signer_mismatch", "message": str(exc)})
            except ValueError as exc:
                self._send_json(400, {"ok": False, "error": "bad_request", "message": str(exc)})
            except Exception as exc:  # noqa: BLE001
                print(f"[http]  unhandled error: {exc}", flush=True)
                self._send_json(500, {"ok": False, "error": "internal_error", "message": str(exc)})

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[http]  {self.address_string()} - {fmt % args}", flush=True)

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return HeaderRequestHandler


def _parse_block_number(value: str) -> int:
    value = value.strip()
    block_number = int(value, 16) if value.startswith("0x") else int(value, 10)
    if block_number < 0:
        raise ValueError("block_number must be non-negative")
    return block_number
