// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice TEE-signed claim about a source-chain block header. `rlpHeader` is
///         carried for on-chain integrity checks but is NOT part of the signed
///         digest (it is bound through `rlpHeaderHash`/`blockHash`).
struct HeaderReport {
    uint256 sourceChainId;
    uint256 blockNumber;
    bytes32 blockHash;
    bytes32 rlpHeaderHash;
    uint256 requiredConfirmations;
    uint256 observedConfirmations;
    uint256 quorumTip;
    bool requireFinalized;
    uint256 finalizedBlockNumber;
    bytes32 rpcVoteDigest;
    uint256 expiresAt;
    uint64 signerEpoch;
    bytes rlpHeader;
}

/// @notice Recomputes the signed report digest. Field order and types match the
///         Python reference (header_report.py) byte-for-byte: domain is a
///         bytes32 so every abi.encode slot is fixed-size.
library HeaderReportLib {
    bytes32 internal constant HEADER_REPORT_DOMAIN = keccak256("CROSSROADS_HEADER_REPORT_V1");

    function digest(
        uint256 sapphireChainId,
        address oracleContract,
        HeaderReport calldata r
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    HEADER_REPORT_DOMAIN,
                    sapphireChainId,
                    oracleContract,
                    r.sourceChainId,
                    r.blockNumber,
                    r.blockHash,
                    r.rlpHeaderHash,
                    r.requiredConfirmations,
                    r.observedConfirmations,
                    r.quorumTip,
                    r.requireFinalized,
                    r.finalizedBlockNumber,
                    r.rpcVoteDigest,
                    r.expiresAt,
                    r.signerEpoch
                )
            );
    }
}
