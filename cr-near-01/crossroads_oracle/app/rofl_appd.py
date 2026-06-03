import codecs
from typing import Any

import cbor2
import httpx

ROFL_SOCKET_PATH = "/run/rofl-appd.sock"


def build_tx_payload(
    to: str,
    data: str,
    gas_limit: int,
    value: int = 0,
    encrypt: bool = False,
) -> dict[str, Any]:
    return {
        "tx": {
            "kind": "eth",
            "data": {
                "gas_limit": int(gas_limit),
                "to": to.removeprefix("0x"),
                "value": str(int(value)),
                "data": data.removeprefix("0x"),
            },
        },
        "encrypt": encrypt,
    }


def interpret_response(response_hex: str) -> Any:
    decoded = cbor2.loads(codecs.decode(response_hex, "hex"))
    if isinstance(decoded, dict) and "fail" in decoded:
        raise RuntimeError(f"ROFL tx failed: {decoded['fail']}")
    if isinstance(decoded, dict) and "ok" in decoded:
        return decoded["ok"]
    return decoded


class RoflAppdClient:
    def __init__(self, socket_path: str = ROFL_SOCKET_PATH) -> None:
        self.socket_path = socket_path

    def _client(self) -> httpx.Client:
        transport = httpx.HTTPTransport(uds=self.socket_path)
        return httpx.Client(transport=transport, base_url="http://localhost")

    def get_app_id(self) -> str:
        with self._client() as client:
            resp = client.get("/rofl/v1/app/id", timeout=30.0)
            resp.raise_for_status()
            return resp.text.strip()

    def generate_key(self, key_id: str, kind: str = "secp256k1") -> Any:
        payload = {"key_id": key_id, "kind": kind}
        with self._client() as client:
            resp = client.post("/rofl/v1/keys/generate", json=payload, timeout=60.0)
            resp.raise_for_status()
            try:
                return resp.json()
            except ValueError:
                return resp.text.strip()

    def submit_tx(
        self,
        to: str,
        data: str,
        gas_limit: int = 300_000,
        value: int = 0,
        encrypt: bool = False,
    ) -> Any:
        payload = build_tx_payload(to, data, gas_limit, value, encrypt)
        with self._client() as client:
            resp = client.post("/rofl/v1/tx/sign-submit", json=payload, timeout=60.0)
            resp.raise_for_status()
            result = resp.json()
        return interpret_response(result["data"])
