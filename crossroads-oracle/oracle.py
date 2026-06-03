import os
import time
from collections import Counter

from dotenv import load_dotenv
from web3 import Web3

from rofl_appd import RoflAppdClient

load_dotenv()

# --- Configuration ------------------------------------------------------------

ORACLE_MODE = os.environ.get("ORACLE_MODE", "local")

_DEFAULT_SOURCES = (
    "https://ethereum-sepolia-rpc.publicnode.com,"
    "https://sepolia.drpc.org,"
    "https://1rpc.io/sepolia"
)
SOURCE_RPC_URLS = [
    u.strip()
    for u in os.environ.get(
        "SOURCE_RPC_URLS", os.environ.get("SOURCE_RPC_URL", _DEFAULT_SOURCES)
    ).split(",")
    if u.strip()
]

TARGET_RPC_URL = os.environ.get("TARGET_RPC_URL", "https://testnet.sapphire.oasis.io")
ORACLE_CONTRACT_ADDRESS = os.environ["ORACLE_CONTRACT_ADDRESS"]
SAPPHIRE_TESTNET_CHAIN_ID = 23295  # 0x5aff

PUSH_INTERVAL = int(os.environ.get("PUSH_INTERVAL", "60"))
CONFIRMATIONS = int(os.environ.get("CONFIRMATIONS", "6"))

# Agreement rule: how many sources must report the same hash before we sign.
QUORUM = int(os.environ.get("QUORUM", str(len(SOURCE_RPC_URLS) // 2 + 1)))

# Max blocks to cover per cycle. The bridge needs the hash of the SPECIFIC block
# holding a deposit tx, so we fill EVERY block contiguously rather than only the
# latest. If we fall behind, we catch up BATCH_SIZE blocks per cycle.
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "16"))

LOCAL_PRIVATE_KEY = os.environ.get("LOCAL_PRIVATE_KEY", "")

ORACLE_ABI = [
    {
        "type": "function",
        "name": "storeBlockHash",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "number", "type": "uint256"},
            {"name": "hash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "storeBlockHashes",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "numbers", "type": "uint256[]"},
            {"name": "hashes", "type": "bytes32[]"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "blockHashes",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "latestBlockNumber",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]


# --- Pure logic (unit-tested) -------------------------------------------------


def majority_hash(values: list[str], quorum: int) -> str | None:
    """Return the hash with >= quorum identical votes, else None."""
    counts = Counter(values)
    if not counts:
        return None
    value, count = counts.most_common(1)[0]
    return value if count >= quorum else None


def compute_window(
    tips: dict[str, int], confirmations: int, batch_size: int, last_submitted: int | None
):
    """Decide which contiguous block range [start, end] to cover this cycle.

    end = min(tip across sources) - confirmations (reorg-safe, all sources have it).
    First run covers a trailing batch; afterwards we fill forward from
    last_submitted + 1, capped to batch_size so catch-up is bounded. Returns
    None when there's nothing new (or the chain is shorter than the depth).
    """
    if not tips:
        return None
    end = min(tips.values()) - confirmations
    if end < 0:
        return None
    if last_submitted is None:
        start = max(0, end - batch_size + 1)
    else:
        if end <= last_submitted:
            return None
        start = last_submitted + 1
        if end - start + 1 > batch_size:
            end = start + batch_size - 1
    return (start, end)


def quorum_hash_for_block(sources, block_number: int, quorum: int) -> str | None:
    """Query every source for one block's hash and apply the agreement rule."""
    values: list[str] = []
    for name, w3 in sources:
        try:
            values.append(
                Web3.to_hex(w3.eth.get_block(block_number, full_transactions=False)["hash"])
            )
        except Exception as exc:
            print(f"[src]   {name} block {block_number} error: {exc}", flush=True)
    return majority_hash(values, quorum)


def collect_window(sources, start: int, end: int, quorum: int) -> list[tuple[int, str]]:
    """Gather agreed (block, hash) from start upward, STOPPING at the first block
    that fails quorum — so what we store is always contiguous (no gaps). The
    disputed block is retried next cycle."""
    pairs: list[tuple[int, str]] = []
    for block_number in range(start, end + 1):
        winner = quorum_hash_for_block(sources, block_number, quorum)
        if winner is None:
            print(f"[no-quorum] block {block_number}: sources disagree, stopping here", flush=True)
            break
        pairs.append((block_number, winner))
    return pairs


# --- Submission ---------------------------------------------------------------


def _batch_gas(n: int) -> int:
    return 150_000 + 60_000 * n


def submit_batch_local(w3_target, contract, numbers, hashes_bytes) -> str:
    account = w3_target.eth.account.from_key(LOCAL_PRIVATE_KEY)
    tx = contract.functions.storeBlockHashes(numbers, hashes_bytes).build_transaction(
        {
            "from": account.address,
            "nonce": w3_target.eth.get_transaction_count(account.address),
            "gas": _batch_gas(len(numbers)),
            "gasPrice": w3_target.eth.gas_price,
            "chainId": SAPPHIRE_TESTNET_CHAIN_ID,
        }
    )
    signed = account.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
    tx_hash = w3_target.eth.send_raw_transaction(raw)
    w3_target.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    return Web3.to_hex(tx_hash)


def submit_batch_rofl(rofl, contract, numbers, hashes_bytes) -> str:
    calldata = contract.encode_abi("storeBlockHashes", [numbers, hashes_bytes])
    rofl.submit_tx(to=ORACLE_CONTRACT_ADDRESS, data=calldata, gas_limit=_batch_gas(len(numbers)))
    return "(signed & submitted by ROFL TEE)"


def main() -> None:
    sources = [(url, Web3(Web3.HTTPProvider(url))) for url in SOURCE_RPC_URLS]
    w3_target = Web3(Web3.HTTPProvider(TARGET_RPC_URL))
    contract = w3_target.eth.contract(
        address=Web3.to_checksum_address(ORACLE_CONTRACT_ADDRESS), abi=ORACLE_ABI
    )

    rofl = None
    if ORACLE_MODE == "rofl":
        rofl = RoflAppdClient()
        print(f"[rofl]  appd reports app id: {rofl.get_app_id()}", flush=True)
    print(
        f"[start] mode={ORACLE_MODE} sources={len(sources)} quorum={QUORUM} "
        f"confirmations={CONFIRMATIONS} batch={BATCH_SIZE} contract={ORACLE_CONTRACT_ADDRESS}",
        flush=True,
    )

    last_submitted: int | None = None
    while True:
        try:
            tips: dict[str, int] = {}
            for name, w3 in sources:
                try:
                    tips[name] = w3.eth.block_number
                except Exception as exc:
                    print(f"[src]   {name} tip error: {exc}", flush=True)

            if len(tips) < QUORUM:
                print("[wait]  fewer than quorum sources reachable", flush=True)
            else:
                window = compute_window(tips, CONFIRMATIONS, BATCH_SIZE, last_submitted)
                if window is None:
                    print("[skip]  no new confirmed blocks", flush=True)
                else:
                    start, end = window
                    print(f"[read]  covering blocks {start}..{end} (tip-{CONFIRMATIONS})", flush=True)
                    pairs = collect_window(sources, start, end, QUORUM)

                    if not pairs:
                        print("[skip]  no agreed blocks this cycle", flush=True)
                    else:
                        numbers = [b for b, _ in pairs]
                        hashes_bytes = [Web3.to_bytes(hexstr=h) for _, h in pairs]
                        if ORACLE_MODE == "rofl":
                            res = submit_batch_rofl(rofl, contract, numbers, hashes_bytes)
                        else:
                            res = submit_batch_local(w3_target, contract, numbers, hashes_bytes)
                        print(
                            f"[write] stored {len(numbers)} blocks {numbers[0]}..{numbers[-1]} {res}",
                            flush=True,
                        )

                        stored = contract.functions.blockHashes(numbers[-1]).call()
                        ok = "✅" if Web3.to_hex(stored) == pairs[-1][1] else "❌"
                        print(f"[check] {ok} blockHashes({numbers[-1]}) = {Web3.to_hex(stored)}", flush=True)
                        last_submitted = numbers[-1]
        except Exception as exc:
            print(f"[error] {exc}", flush=True)

        time.sleep(PUSH_INTERVAL)


if __name__ == "__main__":
    main()
