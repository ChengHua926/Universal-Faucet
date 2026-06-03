// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Subcall} from "@oasisprotocol/sapphire-contracts/contracts/Subcall.sol";
import {IBlockHashOracle} from "./EVM/IBlockHashOracle.sol";

/**
 * @title BlockHashOracle
 * @notice Phase 2: stores external-chain block hashes, but ONLY accepts writes
 *         that originate from our attested ROFL app. The single line
 *         Subcall.roflEnsureAuthorizedOrigin(roflAppID) is the entire trust
 *         anchor: Sapphire's runtime verifies (via a precompile) that the
 *         transaction came from a live, TEE-attested instance of exactly the
 *         app whose ID we pinned at deploy time. Any other sender reverts.
 */
contract BlockHashOracle is IBlockHashOracle {
    /// @notice The ROFL app authorized to write. Pinned once at deployment and
    ///         immutable thereafter. This is the 21-byte form of our rofl1... ID.
    bytes21 public immutable roflAppID;

    /// @notice block number => reported block hash for the external chain.
    mapping(uint256 => bytes32) public blockHashes;

    /// @notice The highest block number stored so far.
    uint256 public latestBlockNumber;

    event BlockHashStored(uint256 indexed number, bytes32 hash);

    constructor(bytes21 _roflAppID) {
        roflAppID = _roflAppID;
    }

    /**
     * @dev Reverts unless the current transaction originates from a live,
     *      attested instance of our exact ROFL app. The check is performed by
     *      a Sapphire precompile; we don't verify signatures or attestations
     *      in Solidity ourselves.
     */
    modifier onlyROFL() {
        Subcall.roflEnsureAuthorizedOrigin(roflAppID);
        _;
    }

    /**
     * @notice Record the canonical hash of an external-chain block.
     *         Now gated by onlyROFL — only our TEE app can call it.
     */
    function storeBlockHash(uint256 number, bytes32 hash) external onlyROFL {
        blockHashes[number] = hash;

        if (number > latestBlockNumber) {
            latestBlockNumber = number;
        }

        emit BlockHashStored(number, hash);
    }

    /**
     * @notice Batch variant: store many block hashes in one transaction so the
     *         oracle can fill a CONTIGUOUS window of blocks (gap-free coverage
     *         for the bridge) without paying for one transaction per block.
     */
    function storeBlockHashes(uint256[] calldata numbers, bytes32[] calldata hashes)
        external
        onlyROFL
    {
        require(numbers.length == hashes.length, "Length mismatch");
        for (uint256 i = 0; i < numbers.length; i++) {
            blockHashes[numbers[i]] = hashes[i];
            if (numbers[i] > latestBlockNumber) {
                latestBlockNumber = numbers[i];
            }
            emit BlockHashStored(numbers[i], hashes[i]);
        }
    }

    /**
     * @notice IBlockHashOracle: read a stored block hash. Reverts if we never
     *         recorded that block, so consumers (e.g. the bridge) fail closed
     *         rather than treating an unknown block as hash 0x0.
     */
    function getBlockHash(uint256 blockNumber) external view override returns (bytes32) {
        bytes32 h = blockHashes[blockNumber];
        require(h != bytes32(0), "No header found for this block");
        return h;
    }
}
