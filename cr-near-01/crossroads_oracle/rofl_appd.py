"""Client for the ROFL app daemon (appd).

Inside a ROFL container, a local daemon listens on the Unix socket
/run/rofl-appd.sock. It can sign and submit transactions on behalf of THIS app
using a key that is endorsed by the TEE. That endorsement is what lets a
Sapphire contract later verify (via roflEnsureAuthorizedOrigin) that a
transaction genuinely came from our attested app and nothing else.

We never see or handle a private key here: we hand appd the call (to + calldata)
and it does the signing inside the trusted environment.

Docs: https://docs.oasis.io/build/rofl/features/appd
"""

import codecs
from typing import Any

import cbor2
import httpx

# Default Unix socket path where appd listens inside a ROFL container.
ROFL_SOCKET_PATH = "/run/rofl-appd.sock"


def build_tx_payload(
    to: str,
    data: str,
    gas_limit: int,
    value: int = 0,
    encrypt: bool = False,
) -> dict[str, Any]:
    """Build the JSON body for POST /rofl/v1/tx/sign-submit.

    appd wants `to` and `data` as hex WITHOUT the 0x prefix, and `value` as a
    string. We deliberately omit from/nonce/gasPrice: appd fills those using the
    app's endorsed signing key. Pure function -> easy to unit test.
    """
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


def interpret_response(response_hex: str) -> None:
    """Decode appd's hex-CBOR result; raise on failure, return None on success.

    Success decodes to {"ok": ...}; failure to {"fail": {...}}. Pure function.
    """
    decoded = cbor2.loads(codecs.decode(response_hex, "hex"))
    if isinstance(decoded, dict) and "fail" in decoded:
        raise RuntimeError(f"ROFL tx failed: {decoded['fail']}")


class RoflAppdClient:
    def __init__(self, socket_path: str = ROFL_SOCKET_PATH) -> None:
        self.socket_path = socket_path

    def _client(self) -> httpx.Client:
        # httpx can speak HTTP over a Unix domain socket via this transport.
        # The host part of the URL ("localhost") is ignored; routing is the socket.
        transport = httpx.HTTPTransport(uds=self.socket_path)
        return httpx.Client(transport=transport, base_url="http://localhost")

    def get_app_id(self) -> str:
        """GET /rofl/v1/app/id -> our registered rofl1... app identifier."""
        with self._client() as client:
            resp = client.get("/rofl/v1/app/id", timeout=30.0)
            resp.raise_for_status()
            return resp.text.strip()

    def generate_key(self, key_id: str, kind: str = "secp256k1") -> Any:
        """POST /rofl/v1/keys/generate -> a deterministic key bound to THIS app.

        The TEE derives the same key every time for a given (app, key_id, kind),
        so our header-signer survives restarts/updates without persisting a key to
        disk. We ask for `secp256k1` so the derived key is Ethereum-compatible.
        Returns whatever appd sends (JSON object or raw string); kms_key.py pulls
        the private key out of it.
        """
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
    ) -> None:
        """POST /rofl/v1/tx/sign-submit: have the TEE sign + submit an eth tx."""
        payload = build_tx_payload(to, data, gas_limit, value, encrypt)
        with self._client() as client:
            resp = client.post("/rofl/v1/tx/sign-submit", json=payload, timeout=60.0)
            resp.raise_for_status()
            result = resp.json()
        interpret_response(result["data"])
