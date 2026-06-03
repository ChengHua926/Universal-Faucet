// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Subcall} from "@oasisprotocol/sapphire-contracts/contracts/Subcall.sol";

/**
 * @title CrossroadsHeaderOracle
 * @notice Registers the TEE-owned key that will sign external-chain header
 *         reports in the next phase. Authorization is anchored in Sapphire's
 *         ROFL origin check; this contract does not push or store block hashes.
 */
contract CrossroadsHeaderOracle {
    string public constant HEADER_SIGNER_COMMITMENT_DOMAIN =
        "CROSSROADS_HEADER_SIGNER_V1";

    bytes21 public immutable roflAppID;

    address public headerSigner;
    uint64 public headerSignerEpoch;
    bytes32 public headerSignerCommitment;

    event HeaderSignerRegistered(
        address indexed signer,
        uint64 indexed epoch,
        bytes32 commitment
    );
    event HeaderSignerRotated(
        address indexed previousSigner,
        address indexed signer,
        uint64 indexed epoch,
        bytes32 commitment
    );

    constructor(bytes21 _roflAppID) {
        roflAppID = _roflAppID;
    }

    modifier onlyROFL() {
        Subcall.roflEnsureAuthorizedOrigin(roflAppID);
        _;
    }

    function registerHeaderSigner(
        address signer,
        bytes32 commitment
    ) external onlyROFL {
        require(headerSigner == address(0), "header signer already registered");
        uint64 nextEpoch = headerSignerEpoch + 1;
        _setHeaderSigner(signer, commitment, nextEpoch);

        emit HeaderSignerRegistered(signer, nextEpoch, commitment);
    }

    function rotateHeaderSigner(
        address signer,
        bytes32 commitment
    ) external onlyROFL {
        address previousSigner = headerSigner;
        uint64 nextEpoch = headerSignerEpoch + 1;
        _setHeaderSigner(signer, commitment, nextEpoch);

        emit HeaderSignerRotated(previousSigner, signer, nextEpoch, commitment);
    }

    function computeHeaderSignerCommitment(
        uint256 sapphireChainId,
        address oracleContractAddress,
        bytes21 appID,
        address signer,
        uint64 signerEpochOrNonce
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    HEADER_SIGNER_COMMITMENT_DOMAIN,
                    sapphireChainId,
                    oracleContractAddress,
                    appID,
                    signer,
                    signerEpochOrNonce
                )
            );
    }

    function _setHeaderSigner(
        address signer,
        bytes32 commitment,
        uint64 nextEpoch
    ) internal {
        require(signer != address(0), "invalid signer");
        require(commitment != bytes32(0), "invalid commitment");

        headerSigner = signer;
        headerSignerEpoch = nextEpoch;
        headerSignerCommitment = commitment;
    }
}
