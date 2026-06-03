import pytest

import url_guard
from url_guard import UnsafeRpcUrlError, assert_safe_url


def test_public_https_url_is_allowed(monkeypatch):
    monkeypatch.setattr(url_guard, "_resolve_ips", lambda host: [_ip("93.184.216.34")])
    assert_safe_url("https://rpc.example.com/path")  # no raise


def test_public_ip_literal_is_allowed():
    assert_safe_url("https://93.184.216.34:8545")  # no raise, no DNS


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8545",          # loopback
        "https://localhost",              # loopback name resolved below
        "http://10.0.0.5",                # RFC1918
        "http://192.168.1.1:8545",        # RFC1918
        "http://169.254.169.254/latest",  # cloud metadata (link-local)
        "http://[::1]:8545",              # ipv6 loopback
    ],
)
def test_private_and_metadata_targets_are_blocked(url):
    with pytest.raises(UnsafeRpcUrlError):
        assert_safe_url(url)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "gopher://x", "unix:/var/run/appd.sock", "ftp://h/x"])
def test_non_http_schemes_are_blocked(url):
    with pytest.raises(UnsafeRpcUrlError):
        assert_safe_url(url)


def test_empty_or_hostless_is_blocked():
    with pytest.raises(UnsafeRpcUrlError):
        assert_safe_url("")
    with pytest.raises(UnsafeRpcUrlError):
        assert_safe_url("https://")


def test_domain_resolving_to_private_ip_is_blocked(monkeypatch):
    # DNS-rebinding shape: a public-looking name that resolves to a private IP.
    monkeypatch.setattr(url_guard, "_resolve_ips", lambda host: [_ip("10.1.2.3")])
    with pytest.raises(UnsafeRpcUrlError):
        assert_safe_url("https://sneaky.example.com")


def test_mixed_public_and_private_resolution_is_blocked(monkeypatch):
    monkeypatch.setattr(
        url_guard, "_resolve_ips", lambda host: [_ip("93.184.216.34"), _ip("127.0.0.1")]
    )
    with pytest.raises(UnsafeRpcUrlError):
        assert_safe_url("https://partly.example.com")


def _ip(addr):
    import ipaddress

    return ipaddress.ip_address(addr)
