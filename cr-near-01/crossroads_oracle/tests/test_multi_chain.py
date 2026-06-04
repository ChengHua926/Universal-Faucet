import pytest
from eth_account import Account
from eth_utils import keccak

import header_report
from multi_chain import (
    MultiChainHeaderReportService,
    OracleAppIdMismatchError,
    OracleSignerNotRegisteredError,
    TooManyRpcUrlsError,
    resolve_source_config,
)
from source_rpc import ConfirmedHeaderResult, RpcVote
from url_guard import UnsafeRpcUrlError

PRIVATE_KEY = "0x" + "11" * 32
SIGNER = Account.from_key(PRIVATE_KEY).address
APP_ID = bytes.fromhex("00" + "23" * 20)  # 21 bytes
OTHER_APP_ID = bytes.fromhex("00" + "99" * 20)
ORACLE_A = "0x000000000000000000000000000000000000aAaA"
ORACLE_B = "0x000000000000000000000000000000000000bBbB"
SAPPHIRE_CHAIN_ID = 23295
ZERO = "0x" + "00" * 20
# Public IP literals so url_guard needs no real DNS.
PUBLIC_URLS = ["https://93.184.216.34", "https://93.184.216.35"]


# --- resolver gate ----------------------------------------------------------


def test_resolve_happy_path():
    contract = _FakeContract(ORACLE_A)
    resolved = resolve_source_config(
        contract, expected_app_id_bytes=APP_ID, signer_address=SIGNER
    )
    assert resolved.source_chain_id == 11155111
    assert resolved.rpc_urls == tuple(PUBLIC_URLS)
    assert resolved.rpc_quorum == 2
    assert resolved.header_signer == SIGNER


def test_resolve_rejects_wrong_app_id():
    contract = _FakeContract(ORACLE_A)
    with pytest.raises(OracleAppIdMismatchError):
        resolve_source_config(contract, expected_app_id_bytes=OTHER_APP_ID, signer_address=SIGNER)


def test_resolve_rejects_foreign_signer():
    # headerSigner set to a DIFFERENT non-zero address (another oracle) -> reject.
    contract = _FakeContract(ORACLE_A, header_signer="0x" + "22" * 20)
    with pytest.raises(OracleSignerNotRegisteredError):
        resolve_source_config(contract, expected_app_id_bytes=APP_ID, signer_address=SIGNER)


def test_resolve_flags_unset_signer_for_registration():
    # headerSigner == address(0): freshly deployed, opted-in -> flag for Option A,
    # don't reject.
    contract = _FakeContract(ORACLE_A, header_signer=ZERO, epoch=0)
    resolved = resolve_source_config(
        contract, expected_app_id_bytes=APP_ID, signer_address=SIGNER
    )
    assert resolved.needs_registration is True
    assert resolved.rpc_urls == tuple(PUBLIC_URLS)


def test_resolve_blocks_ssrf_url():
    # One public + one cloud-metadata URL (count satisfies quorum so the guard,
    # not the quorum check, is what rejects it).
    contract = _FakeContract(ORACLE_A, urls=[PUBLIC_URLS[0], "http://169.254.169.254/latest"])
    with pytest.raises(UnsafeRpcUrlError):
        resolve_source_config(contract, expected_app_id_bytes=APP_ID, signer_address=SIGNER)


def test_resolve_caps_url_count():
    contract = _FakeContract(ORACLE_A, urls=PUBLIC_URLS + ["https://1.1.1.1"])
    with pytest.raises(TooManyRpcUrlsError):
        resolve_source_config(
            contract, expected_app_id_bytes=APP_ID, signer_address=SIGNER, max_urls=2
        )


def test_resolve_app_id_gate_runs_before_url_resolution():
    # Bad app id AND an SSRF url: must fail on app id, never touching the url.
    contract = _FakeContract(ORACLE_A, urls=["http://127.0.0.1"])
    with pytest.raises(OracleAppIdMismatchError):
        resolve_source_config(contract, expected_app_id_bytes=OTHER_APP_ID, signer_address=SIGNER)


# --- service ----------------------------------------------------------------


def test_service_signs_report_bound_to_requested_contract():
    svc, factory = _service()
    report = svc.get_header_report(ORACLE_A, 187)

    assert report["oracleContractAddress"].lower() == ORACLE_A.lower()
    assert report["sourceChainId"] == 11155111
    assert report["signer"] == SIGNER
    recovered = header_report.recover(
        bytes.fromhex(report["reportDigest"][2:]), bytes.fromhex(report["signature"][2:])
    )
    assert recovered == SIGNER


def test_service_caches_resolution_within_ttl():
    svc, factory = _service()
    svc.get_header_report(ORACLE_A, 187)
    svc.get_header_report(ORACLE_A, 188)
    assert factory.calls[ORACLE_A.lower()] == 1  # resolved once, reused


def test_service_isolates_two_contracts():
    svc, factory = _service()
    a = svc.get_header_report(ORACLE_A, 187)
    b = svc.get_header_report(ORACLE_B, 187)
    assert a["oracleContractAddress"].lower() == ORACLE_A.lower()
    assert b["oracleContractAddress"].lower() == ORACLE_B.lower()


def test_service_per_config_rate_limit():
    svc, _ = _service(per_config_rate_limit=1)
    svc.get_header_report(ORACLE_A, 187)
    with pytest.raises(Exception) as exc:
        svc.get_header_report(ORACLE_A, 188)
    assert getattr(exc.value, "error_code", "") == "rate_limited"


def test_service_auto_registers_unset_signer_then_serves():
    # Fresh contract: signer unset. First request should auto-register via appd,
    # then serve a report bound to the contract.
    contract = _FakeContract(ORACLE_A, header_signer=ZERO, epoch=0)
    rofl = _FakeRofl(contract)
    svc = MultiChainHeaderReportService(
        contract_factory=lambda addr: contract,
        signer_private_key=PRIVATE_KEY,
        signer_address=SIGNER,
        sapphire_chain_id=SAPPHIRE_CHAIN_ID,
        expected_app_id_bytes=APP_ID,
        ttl_seconds=1800,
        cache_size=16,
        cache_refresh_seconds=120,
        source_client_factory=lambda cfg: _FakeSourceClient(cfg),
        rofl_client=rofl,
    )

    report = svc.get_header_report(ORACLE_A, 187)
    assert report["oracleContractAddress"].lower() == ORACLE_A.lower()
    assert report["signer"] == SIGNER
    assert rofl.calls == 1                      # registered exactly once
    assert contract.header_signer == SIGNER     # registration took effect

    svc.get_header_report(ORACLE_A, 188)        # cached service -> no re-register
    assert rofl.calls == 1


def test_service_unset_signer_without_appd_raises():
    contract = _FakeContract(ORACLE_A, header_signer=ZERO, epoch=0)
    svc = MultiChainHeaderReportService(
        contract_factory=lambda addr: contract,
        signer_private_key=PRIVATE_KEY,
        signer_address=SIGNER,
        sapphire_chain_id=SAPPHIRE_CHAIN_ID,
        expected_app_id_bytes=APP_ID,
        ttl_seconds=1800,
        cache_size=16,
        cache_refresh_seconds=120,
        source_client_factory=lambda cfg: _FakeSourceClient(cfg),
        rofl_client=None,
    )
    with pytest.raises(OracleSignerNotRegisteredError):
        svc.get_header_report(ORACLE_A, 187)


def _service(per_config_rate_limit=0):
    factory = _FakeContractFactory()
    svc = MultiChainHeaderReportService(
        contract_factory=factory,
        signer_private_key=PRIVATE_KEY,
        signer_address=SIGNER,
        sapphire_chain_id=SAPPHIRE_CHAIN_ID,
        expected_app_id_bytes=APP_ID,
        ttl_seconds=1800,
        cache_size=16,
        cache_refresh_seconds=120,
        source_client_factory=lambda cfg: _FakeSourceClient(cfg),
        per_config_rate_limit_per_minute=per_config_rate_limit,
    )
    return svc, factory


# --- fakes ------------------------------------------------------------------


class _FakeFn:
    def __init__(self, value):
        self._value = value

    def call(self):
        return self._value


class _FakeFunctions:
    def __init__(self, c):
        self._c = c

    def roflAppID(self):
        return _FakeFn(self._c.app_id)

    def headerSigner(self):
        return _FakeFn(self._c.header_signer)

    def headerSignerEpoch(self):
        return _FakeFn(self._c.epoch)

    def expectedSourceChainId(self):
        return _FakeFn(self._c.source_chain_id)

    def minConfirmations(self):
        return _FakeFn(self._c.min_confirmations)

    def mandateFinalized(self):
        return _FakeFn(self._c.mandate_finalized)

    def sourceRpcUrls(self):
        return _FakeFn(list(self._c.urls))

    def sourceRpcQuorum(self):
        return _FakeFn(self._c.quorum)

    def registerHeaderSigner(self, signer, commitment):
        return _FakeTxData()


class _FakeContract:
    def __init__(
        self,
        address,
        *,
        app_id=APP_ID,
        header_signer=SIGNER,
        urls=None,
        quorum=2,
        source_chain_id=11155111,
        min_confirmations=12,
        mandate_finalized=False,
        epoch=1,
    ):
        self.address = address
        self.app_id = app_id
        self.header_signer = header_signer
        self.urls = urls if urls is not None else PUBLIC_URLS
        self.quorum = quorum
        self.source_chain_id = source_chain_id
        self.min_confirmations = min_confirmations
        self.mandate_finalized = mandate_finalized
        self.epoch = epoch
        self.functions = _FakeFunctions(self)


class _FakeContractFactory:
    def __init__(self):
        self.calls: dict[str, int] = {}

    def __call__(self, address):
        self.calls[address.lower()] = self.calls.get(address.lower(), 0) + 1
        return _FakeContract(address)


class _FakeTxData:
    def _encode_transaction_data(self):
        return "0x" + "ab" * 4


class _FakeRofl:
    def __init__(self, contract):
        self.contract = contract
        self.calls = 0

    def submit_tx(self, to, data, gas_limit=300_000, value=0, encrypt=False):
        self.calls += 1
        # registration takes effect on-chain: signer set, epoch 0 -> 1.
        self.contract.header_signer = SIGNER
        self.contract.epoch = 1


class _FakeSourceClient:
    def __init__(self, config):
        self.config = config

    def get_confirmed_header(self, block_number):
        return _result(block_number, self.config.chain_id)

    def get_latest_confirmed_header(self):
        return _result(199, self.config.chain_id)


def _result(block_number, chain_id):
    rlp_header = b"\xc0"
    block_hash = "0x" + keccak(rlp_header).hex()
    return ConfirmedHeaderResult(
        source_chain_id=chain_id,
        block_number=block_number,
        block_hash=block_hash,
        rlp_header=rlp_header,
        votes=(
            RpcVote(0, "rpc0", 200, None, block_hash, block_hash, True, None, rlp_header),
            RpcVote(1, "rpc1", 199, None, block_hash, block_hash, True, None, rlp_header),
        ),
        required_confirmations=12,
        observed_confirmations=12,
        quorum_tip=199,
        require_finalized=False,
        finalized_block_number=None,
    )
