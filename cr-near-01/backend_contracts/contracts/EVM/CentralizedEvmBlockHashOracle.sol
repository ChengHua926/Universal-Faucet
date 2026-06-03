// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IBlockHashOracle.sol";

/// @notice Owner-operated block hash oracle for public EVM source testnets.
contract CentralizedEvmBlockHashOracle is IBlockHashOracle, Ownable {
    mapping(uint256 => bytes32) public blockHashes;

    event BlockHashSet(uint256 indexed blockNumber, bytes32 indexed blockHash);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setBlockHash(uint256 blockNumber, bytes32 blockHash) external onlyOwner {
        _setBlockHash(blockNumber, blockHash);
    }

    function setBlockHashes(uint256[] calldata blockNumbers, bytes32[] calldata hashes) external onlyOwner {
        require(blockNumbers.length == hashes.length, "Length mismatch");
        for (uint256 i = 0; i < blockNumbers.length; i++) {
            _setBlockHash(blockNumbers[i], hashes[i]);
        }
    }

    function getBlockHash(uint256 blockNumber) external view override returns (bytes32) {
        bytes32 blockHash = blockHashes[blockNumber];
        require(blockHash != bytes32(0), "No header found for this block");
        return blockHash;
    }

    function _setBlockHash(uint256 blockNumber, bytes32 blockHash) private {
        require(blockHash != bytes32(0), "Zero block hash");
        blockHashes[blockNumber] = blockHash;
        emit BlockHashSet(blockNumber, blockHash);
    }
}
