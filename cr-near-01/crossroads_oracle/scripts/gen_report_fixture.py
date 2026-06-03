"""Generate a cross-language fixture: build a HeaderReport from a real Sepolia
block, compute the digest + sign it in Python, and write everything to JSON so a
Hardhat test can assert the Solidity side recomputes the same digest and recovers
the same signer. Run: .venv/bin/python scripts/gen_report_fixture.py
"""

import json
import os

import evm_header
import header_report as hr

# Hardhat account #0 — test key only.
PRIV = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOCK = os.path.join(ROOT, "tests", "fixtures", "sepolia_block.json")
OUT_DIR = os.path.join(ROOT, "contracts", "test", "fixtures")
OUT = os.path.join(OUT_DIR, "header_report_fixture.json")


def main() -> None:
    blk = json.load(open(BLOCK))
    block_number = int(blk["number"], 16)
    block_hash = blk["hash"]
    rlp_header = "0x" + evm_header.build_rlp_header(blk).hex()
    rlp_header_hash = evm_header.header_hash(blk)  # == block_hash
    assert rlp_header_hash == block_hash

    sapphire_chain_id = 23295
    oracle_contract = "0xD22bcCbb387464dd99c573aBf583b00F55626552"
    source_chain_id = 11155111
    quorum_tip = block_number + 14

    votes = [
        {"sourceIndex": 0, "url": "https://ethereum-sepolia-rpc.publicnode.com", "tip": quorum_tip,
         "finalizedBlockNumber": block_number, "blockHash": block_hash,
         "recomputedBlockHash": block_hash, "ok": True, "error": None},
        {"sourceIndex": 1, "url": "https://sepolia.drpc.org", "tip": quorum_tip,
         "finalizedBlockNumber": block_number, "blockHash": block_hash,
         "recomputedBlockHash": block_hash, "ok": True, "error": None},
        {"sourceIndex": 2, "url": "https://1rpc.io/sepolia", "tip": quorum_tip - 2,
         "finalizedBlockNumber": block_number, "blockHash": block_hash,
         "recomputedBlockHash": block_hash, "ok": True, "error": None},
    ]
    vote_digest = hr.rpc_vote_digest(votes)

    report = dict(
        sourceChainId=source_chain_id,
        blockNumber=block_number,
        blockHash=block_hash,
        rlpHeaderHash=rlp_header_hash,
        requiredConfirmations=12,
        observedConfirmations=14,
        quorumTip=quorum_tip,
        requireFinalized=False,
        finalizedBlockNumber=0,
        rpcVoteDigest="0x" + vote_digest.hex(),
        expiresAt=4102444800,  # year 2100
        signerEpoch=1,
        rlpHeader=rlp_header,
    )

    digest = hr.report_digest(
        sapphire_chain_id=sapphire_chain_id,
        oracle_contract=oracle_contract,
        source_chain_id=source_chain_id,
        block_number=block_number,
        block_hash=block_hash,
        rlp_header_hash=rlp_header_hash,
        required_confirmations=12,
        observed_confirmations=14,
        quorum_tip=quorum_tip,
        require_finalized=False,
        finalized_block_number=0,
        rpc_vote_digest_value=vote_digest,
        expires_at=4102444800,
        signer_epoch=1,
    )
    signature = hr.sign_digest(digest, PRIV)

    fixture = dict(
        sapphireChainId=sapphire_chain_id,
        oracleContract=oracle_contract,
        report=report,
        reportDigest="0x" + digest.hex(),
        signature="0x" + signature.hex(),
        signer=hr.address_from_private_key(PRIV),
        votes=votes,
    )

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {OUT}")
    print(f"  block {block_number}  digest {fixture['reportDigest']}  signer {fixture['signer']}")


if __name__ == "__main__":
    main()
