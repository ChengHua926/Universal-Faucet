from eth_account import Account
from eth_utils import keccak

from app.report_cache import ReportCache
from app.server import HeaderReportService, HeaderReportServiceConfig
from app.source_rpc import ConfirmedHeaderResult, RpcVote


PRIVATE_KEY = "0x" + "11" * 32
SIGNER = Account.from_key(PRIVATE_KEY).address
ORACLE = "0x1111111111111111111111111111111111111111"


def test_health_does_not_call_rpc_or_contract():
    source = _FakeSource()
    contract = _FakeContract(SIGNER, 1)
    service = _service(source, contract)

    health = service.health()

    assert health["ok"] is True
    assert source.calls == 0
    assert contract.calls == 0


def test_specific_block_cache_hit_skips_rpc_and_resign():
    source = _FakeSource()
    contract = _FakeContract(SIGNER, 1)
    service = _service(source, contract, refresh_seconds=0)

    first = service.get_header_report(187)
    second = service.get_header_report(187)

    assert second == first
    assert source.calls == 1
    assert contract.calls == 2


def test_cache_refreshes_when_report_is_near_expiry():
    source = _FakeSource()
    contract = _FakeContract(SIGNER, 1)
    service = _service(source, contract, ttl_seconds=100, refresh_seconds=200)

    first = service.get_header_report(187)
    second = service.get_header_report(187)

    assert first["expiresAt"] <= second["expiresAt"]
    assert source.calls == 2


class _FakeSource:
    def __init__(self):
        self.calls = 0
        self.config = type("Config", (), {"quorum": 2, "confirmations": 12})()

    def get_confirmed_header(self, block_number):
        self.calls += 1
        return _result(block_number)


class _FakeFunction:
    def __init__(self, contract, value):
        self.contract = contract
        self.value = value

    def call(self):
        self.contract.calls += 1
        return self.value


class _FakeFunctions:
    def __init__(self, contract):
        self.contract = contract

    def headerSigner(self):
        return _FakeFunction(self.contract, self.contract.signer)

    def headerSignerEpoch(self):
        return _FakeFunction(self.contract, self.contract.epoch)


class _FakeContract:
    def __init__(self, signer, epoch):
        self.signer = signer
        self.epoch = epoch
        self.calls = 0
        self.functions = _FakeFunctions(self)


def _service(source, contract, ttl_seconds=1800, refresh_seconds=120):
    return HeaderReportService(
        config=HeaderReportServiceConfig(
            source_chain_id=11155111,
            require_finalized=False,
            sapphire_chain_id=23295,
            oracle_contract_address=ORACLE,
            ttl_seconds=ttl_seconds,
        ),
        source_client=source,
        contract=contract,
        signer_private_key=PRIVATE_KEY,
        signer_address=SIGNER,
        signer_epoch=1,
        cache=ReportCache(max_size=10, refresh_seconds=refresh_seconds),
    )


def _result(block_number):
    rlp_header = b"\xc0"
    block_hash = "0x" + keccak(rlp_header).hex()
    return ConfirmedHeaderResult(
        source_chain_id=11155111,
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
