// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IBitcoinBlockHashOracle} from "./IBitcoinBlockHashOracle.sol";

contract TrivialBitcoinBlockHashOracle is IBitcoinBlockHashOracle {
    mapping(uint256 => bytes32) public blockHashes;

    event BlockHashSet(uint256 indexed blockHeight, bytes32 indexed blockHash);

    function setBlockHash(uint256 blockHeight, bytes32 blockHash) external {
        blockHashes[blockHeight] = blockHash;
        emit BlockHashSet(blockHeight, blockHash);
    }

    function getBlockHash(uint256 blockHeight) external view returns (bytes32) {
        return blockHashes[blockHeight];
    }
}
