"""Sapphire oracle contract client for header-signer registration.

Thin web3 wrapper over HeaderReportOracle's registration surface. Decides whether
to register (no signer yet), skip (chain already has our signer), or rotate
(different signer, only with explicit opt-in) and produces the calldata. The
actual signing/submission goes through appd so the tx carries the TEE-attested
origin that `onlyROFL` checks. The commitment binds (chainId, contract, appId,
signer, epoch) so a registration can't be replayed onto a different context.
"""

from dataclasses import dataclass
from typing import Any

from bech32 import bech32_decode, convertbits
from eth_abi import encode
from eth_utils import keccak, to_canonical_address
from web3 import Web3

HEADER_SIGNER_COMMITMENT_DOMAIN_TEXT = "CROSSROADS_HEADER_SIGNER_V1"
HEADER_SIGNER_COMMITMENT_DOMAIN = keccak(text=HEADER_SIGNER_COMMITMENT_DOMAIN_TEXT)
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

CROSSROADS_HEADER_ORACLE_ABI = [
    {"type": "function", "name": "roflAppID", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "bytes21"}]},
    {"type": "function", "name": "headerSigner", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "headerSignerEpoch", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "uint64"}]},
    {"type": "function", "name": "headerSignerCommitment", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "bytes32"}]},
    {"type": "function", "name": "expectedSourceChainId", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "minConfirmations", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "mandateFinalized", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "bool"}]},
    {"type": "function", "name": "sourceRpcUrls", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "string[]"}]},
    {"type": "function", "name": "sourceRpcQuorum", "stateMutability": "view", "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
    {
        "type": "function", "name": "registerHeaderSigner", "stateMutability": "nonpayable",
        "inputs": [{"name": "signer", "type": "address"}, {"name": "commitment", "type": "bytes32"}], "outputs": [],
    },
    {
        "type": "function", "name": "rotateHeaderSigner", "stateMutability": "nonpayable",
        "inputs": [{"name": "signer", "type": "address"}, {"name": "commitment", "type": "bytes32"}], "outputs": [],
    },
]


@dataclass(frozen=True)
class RegistrationAction:
    action: str
    calldata: str | None
    current_signer: str
    signer: str
    commitment: str


def normalize_address(address: str) -> str:
    return Web3.to_checksum_address(address)


def normalize_rofl_app_id_bytes(value: str | bytes | bytearray) -> bytes:
    if isinstance(value, (bytes, bytearray)):
        result = bytes(value)
    elif isinstance(value, str) and value.startswith("0x"):
        result = bytes.fromhex(value[2:])
    elif isinstance(value, str):
        hrp, words = bech32_decode(value)
        if hrp != "rofl" or words is None:
            raise ValueError("Expected ROFL app id as rofl1... or 0x bytes21")
        converted = convertbits(words, 5, 8, False)
        if converted is None:
            raise ValueError("Invalid ROFL app id bech32 payload")
        result = bytes(converted)
    else:
        raise TypeError("ROFL app id must be bytes or string")

    if len(result) != 21:
        raise ValueError(f"Expected 21-byte ROFL app id, got {len(result)} bytes")
    return result


def rofl_app_id_to_hex(value: str | bytes | bytearray) -> str:
    return "0x" + normalize_rofl_app_id_bytes(value).hex()


def build_header_signer_commitment(
    sapphire_chain_id: int,
    oracle_contract_address: str,
    rofl_app_id: str | bytes | bytearray,
    signer_address: str,
    signer_epoch_or_nonce: int,
) -> str:
    encoded = encode(
        ["bytes32", "uint256", "address", "bytes21", "address", "uint64"],
        [
            HEADER_SIGNER_COMMITMENT_DOMAIN,
            int(sapphire_chain_id),
            to_canonical_address(normalize_address(oracle_contract_address)),
            normalize_rofl_app_id_bytes(rofl_app_id),
            to_canonical_address(normalize_address(signer_address)),
            int(signer_epoch_or_nonce),
        ],
    )
    return "0x" + keccak(encoded).hex()


def create_contract(w3: Web3, address: str):
    return w3.eth.contract(address=normalize_address(address), abi=CROSSROADS_HEADER_ORACLE_ABI)


def encode_registration_calldata(contract: Any, action: str, signer: str, commitment: str) -> str:
    if action == "register":
        fn = contract.functions.registerHeaderSigner(normalize_address(signer), commitment)
    elif action == "rotate":
        fn = contract.functions.rotateHeaderSigner(normalize_address(signer), commitment)
    else:
        raise ValueError(f"Unknown registration action: {action}")
    return fn._encode_transaction_data()


def plan_header_signer_registration(
    contract: Any, signer: str, commitment: str, allow_rotation: bool
) -> RegistrationAction:
    signer = normalize_address(signer)
    current_signer = normalize_address(contract.functions.headerSigner().call())

    if current_signer == ZERO_ADDRESS:
        calldata = encode_registration_calldata(contract, "register", signer, commitment)
        return RegistrationAction("register", calldata, current_signer, signer, commitment)

    if current_signer.lower() == signer.lower():
        return RegistrationAction("skip", None, current_signer, signer, commitment)

    if not allow_rotation:
        raise RuntimeError(
            "Chain headerSigner differs from local signer; set "
            "ALLOW_SIGNER_ROTATION=1 to rotate explicitly"
        )

    calldata = encode_registration_calldata(contract, "rotate", signer, commitment)
    return RegistrationAction("rotate", calldata, current_signer, signer, commitment)


def submit_registration_action(
    rofl_client: Any, oracle_contract_address: str, action: RegistrationAction, gas_limit: int = 300_000
) -> Any:
    if action.action == "skip":
        return None
    if action.calldata is None:
        raise ValueError("Registration action is missing calldata")
    return rofl_client.submit_tx(
        to=oracle_contract_address, data=action.calldata, gas_limit=gas_limit
    )
