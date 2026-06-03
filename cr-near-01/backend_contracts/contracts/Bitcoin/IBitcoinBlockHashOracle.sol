// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IBitcoinBlockHashOracle {
    function getBlockHash(uint256 blockHeight) external view returns (bytes32);
}
