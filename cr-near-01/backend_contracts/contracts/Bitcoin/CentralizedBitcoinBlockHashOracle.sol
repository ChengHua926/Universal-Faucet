// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/Ownable.sol";
import {IBitcoinBlockHashOracle} from "./IBitcoinBlockHashOracle.sol";

/// @notice Owner-operated Bitcoin block hash oracle for public Bitcoin testnet.
contract CentralizedBitcoinBlockHashOracle is IBitcoinBlockHashOracle, Ownable {
    mapping(uint256 => bytes32) public blockHashes;

    event BlockHashSet(uint256 indexed blockHeight, bytes32 indexed blockHash);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setBlockHash(uint256 blockHeight, bytes32 blockHash) external onlyOwner {
        _setBlockHash(blockHeight, blockHash);
    }

    function setBlockHashes(uint256[] calldata blockHeights, bytes32[] calldata hashes) external onlyOwner {
        require(blockHeights.length == hashes.length, "Length mismatch");
        for (uint256 i = 0; i < blockHeights.length; i++) {
            _setBlockHash(blockHeights[i], hashes[i]);
        }
    }

    function getBlockHash(uint256 blockHeight) external view returns (bytes32) {
        return blockHashes[blockHeight];
    }

    function _setBlockHash(uint256 blockHeight, bytes32 blockHash) private {
        require(blockHash != bytes32(0), "Zero block hash");
        blockHashes[blockHeight] = blockHash;
        emit BlockHashSet(blockHeight, blockHash);
    }
}
