"""SSRF guard for attacker-influenceable source-RPC URLs.

In the multi-chain design the RPC URL list comes from an on-chain config contract
that ANYONE can deploy, so the TEE container must never be tricked into fetching
from internal/metadata/loopback targets. This module is the allowlist:

  - scheme must be http/https (no file://, gopher://, unix sockets, ...)
  - host must resolve, and EVERY resolved IP must be a global/public address
    (blocks loopback, private RFC1918, link-local incl. 169.254.169.254 cloud
    metadata, unique-local, multicast, reserved, and the unspecified address).

`assert_safe_url` is called both when resolving a config (fail fast) and right
before each request in source_rpc (re-resolution narrows the DNS-rebinding
window). Resolution is best-effort hardening, not a substitute for the TEE only
serving contracts that already registered its own app id + signer.
"""

import ipaddress
import socket
from urllib.parse import urlsplit

from source_rpc import SourceRpcError

ALLOWED_SCHEMES = ("http", "https")


class UnsafeRpcUrlError(SourceRpcError):
    status_code = 400
    error_code = "unsafe_rpc_url"


def _resolve_ips(host: str) -> list[ipaddress._BaseAddress]:
    # A bare IP literal needs no DNS; parse it directly (also handles [v6]).
    stripped = host.strip("[]")
    try:
        return [ipaddress.ip_address(stripped)]
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeRpcUrlError(f"could not resolve host {host!r}: {exc}")

    ips: list[ipaddress._BaseAddress] = []
    for info in infos:
        sockaddr = info[4]
        try:
            ips.append(ipaddress.ip_address(sockaddr[0]))
        except ValueError:
            continue
    if not ips:
        raise UnsafeRpcUrlError(f"host {host!r} resolved to no usable IP addresses")
    return ips


def _is_public(ip: ipaddress._BaseAddress) -> bool:
    # is_global is the cleanest single check, but be explicit about the common
    # SSRF targets so the intent (and any odd platform behavior) is unambiguous.
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return False
    # IPv4-mapped IPv6 (::ffff:a.b.c.d) must be judged on the embedded v4 address.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return _is_public(mapped)
    return ip.is_global


def assert_safe_url(url: str) -> None:
    """Raise UnsafeRpcUrlError unless url is http(s) and resolves only to public IPs."""
    if not isinstance(url, str) or not url.strip():
        raise UnsafeRpcUrlError("RPC URL must be a non-empty string")

    parts = urlsplit(url.strip())
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise UnsafeRpcUrlError(f"scheme {parts.scheme!r} is not allowed (use http/https)")
    host = parts.hostname
    if not host:
        raise UnsafeRpcUrlError("RPC URL has no host")

    for ip in _resolve_ips(host):
        if not _is_public(ip):
            raise UnsafeRpcUrlError(f"host {host!r} resolves to non-public address {ip}")
