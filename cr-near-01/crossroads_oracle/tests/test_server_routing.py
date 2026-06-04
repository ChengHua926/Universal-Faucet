"""HTTP-level tests for ?config= routing between the single and multi services."""

import threading
from http.server import ThreadingHTTPServer

import httpx
import pytest

from multi_chain import OracleAppIdMismatchError
from rate_limit import FixedWindowRateLimiter
from server import _make_handler

CONFIG = "0x00000000000000000000000000000000deadbeef"


@pytest.fixture
def base_url():
    single = _FakeSingle()
    multi = _FakeMulti()
    handler = _make_handler(single, FixedWindowRateLimiter(0), multi)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        yield f"http://{host}:{port}", multi
    finally:
        server.shutdown()
        server.server_close()


def test_no_config_uses_single_service(base_url):
    url, _ = base_url
    r = httpx.get(f"{url}/v1/header?block_number=5")
    assert r.status_code == 200
    assert r.json() == {"src": "single", "block": 5}


def test_config_routes_to_multi_service(base_url):
    url, _ = base_url
    r = httpx.get(f"{url}/v1/header?block_number=7&config={CONFIG}")
    assert r.status_code == 200
    body = r.json()
    assert body["src"] == "multi"
    assert body["block"] == 7
    assert body["config"].lower() == CONFIG.lower()


def test_latest_confirmed_with_config(base_url):
    url, _ = base_url
    r = httpx.get(f"{url}/v1/header/latest-confirmed?config={CONFIG}")
    assert r.status_code == 200
    assert r.json()["src"] == "multi-latest"


def test_malformed_config_is_400(base_url):
    url, _ = base_url
    r = httpx.get(f"{url}/v1/header?block_number=1&config=0x123")
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_multi_service_error_is_mapped(base_url):
    url, multi = base_url
    multi.raise_app_id = True
    r = httpx.get(f"{url}/v1/header?block_number=1&config={CONFIG}")
    assert r.status_code == 403
    assert r.json()["error"] == "oracle_app_id_mismatch"


def test_cors_header_on_responses(base_url):
    url, _ = base_url
    r = httpx.get(f"{url}/v1/header?block_number=5")
    assert r.headers.get("access-control-allow-origin") == "*"


def test_options_preflight_is_204_with_cors(base_url):
    url, _ = base_url
    r = httpx.request("OPTIONS", f"{url}/v1/header")
    assert r.status_code == 204
    assert r.headers.get("access-control-allow-origin") == "*"
    assert "GET" in r.headers.get("access-control-allow-methods", "")


def test_post_with_contract_and_block(base_url):
    url, _ = base_url
    r = httpx.post(f"{url}/v1/header", json={"oracle_contract": CONFIG, "block_number": 9})
    assert r.status_code == 200
    body = r.json()
    assert body["src"] == "multi"
    assert body["block"] == 9
    assert body["config"].lower() == CONFIG.lower()


def test_post_without_block_is_latest(base_url):
    url, _ = base_url
    r = httpx.post(f"{url}/v1/header", json={"oracle_contract": CONFIG})
    assert r.status_code == 200
    assert r.json()["src"] == "multi-latest"


def test_post_missing_contract_is_400(base_url):
    url, _ = base_url
    r = httpx.post(f"{url}/v1/header", json={"block_number": 5})
    assert r.status_code == 400
    assert r.json()["error"] == "missing_oracle_contract"


def test_post_bad_json_is_400(base_url):
    url, _ = base_url
    r = httpx.post(
        f"{url}/v1/header", content=b"not json", headers={"content-type": "application/json"}
    )
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_post_error_is_mapped(base_url):
    url, multi = base_url
    multi.raise_app_id = True
    r = httpx.post(f"{url}/v1/header", json={"oracle_contract": CONFIG, "block_number": 1})
    assert r.status_code == 403
    assert r.json()["error"] == "oracle_app_id_mismatch"


def test_post_without_multi_service_is_501():
    single = _FakeSingle()
    handler = _make_handler(single, FixedWindowRateLimiter(0), None)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    try:
        r = httpx.post(f"http://{host}:{port}/v1/header", json={"oracle_contract": CONFIG})
        assert r.status_code == 501
        assert r.json()["error"] == "multi_chain_disabled"
    finally:
        server.shutdown()
        server.server_close()


def test_config_without_multi_service_is_501():
    single = _FakeSingle()
    handler = _make_handler(single, FixedWindowRateLimiter(0), None)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    try:
        r = httpx.get(f"http://{host}:{port}/v1/header?block_number=1&config={CONFIG}")
        assert r.status_code == 501
        assert r.json()["error"] == "multi_chain_disabled"
    finally:
        server.shutdown()
        server.server_close()


class _FakeSingle:
    def index(self):
        return {"ok": True}

    def health(self):
        return {"ok": True}

    def get_header_report(self, block_number):
        return {"src": "single", "block": block_number}

    def get_latest_confirmed_report(self):
        return {"src": "single-latest"}


class _FakeMulti:
    def __init__(self):
        self.raise_app_id = False

    def get_header_report(self, config, block_number):
        if self.raise_app_id:
            raise OracleAppIdMismatchError("nope")
        return {"src": "multi", "block": block_number, "config": config}

    def get_latest_confirmed_report(self, config):
        return {"src": "multi-latest", "config": config}
