// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IBridgeOracle} from "./IBridgeOracle.sol";

contract MockBridgeOracle is IBridgeOracle {
    struct DepositRecord {
        address sender;
        bytes32 destination;
        uint256 amount;
        bool exists;
    }

    struct WithdrawalRecord {
        bytes32 account;
        address spender;
        uint256 amountSpent;
        uint256 epoch;
        bool exists;
    }

    mapping(bytes32 => DepositRecord) private deposits;
    mapping(bytes32 => WithdrawalRecord) private withdrawals;
    mapping(bytes32 => uint256) public currentEpoch;

    function setDeposit(bytes calldata txData, address sender, bytes32 destination, uint256 amount) external {
        deposits[getTransactionHash(txData)] = DepositRecord(sender, destination, amount, true);
    }

    function setWithdrawal(
        bytes calldata txData,
        bytes32 account,
        address spender,
        uint256 amountSpent,
        uint256 epoch
    ) external {
        withdrawals[getTransactionHash(txData)] = WithdrawalRecord(account, spender, amountSpent, epoch, true);
    }

    function setCurrentEpoch(bytes32 encAccount, uint256 epoch) external {
        currentEpoch[encAccount] = epoch;
    }

    function verifyDeposit(
        bytes calldata txData,
        bytes calldata
    ) external view override returns (address sender, bytes32 destination, uint256 amount, bytes32 txHash) {
        txHash = getTransactionHash(txData);
        DepositRecord memory record = deposits[txHash];
        require(record.exists, "Unknown deposit");
        return (record.sender, record.destination, record.amount, txHash);
    }

    function getDepositEpoch(
        bytes calldata,
        bytes calldata,
        bytes32 encAccount,
        uint256
    ) external view override returns (uint256 nextEpoch) {
        return currentEpoch[encAccount];
    }

    function verifyWithdrawal(
        bytes calldata txData,
        bytes calldata,
        bytes32,
        uint256 epoch
    ) external view override returns (bytes32 account, address spender, uint256 amountSpent, bytes32 txHash) {
        txHash = getTransactionHash(txData);
        WithdrawalRecord memory record = withdrawals[txHash];
        require(record.exists, "Unknown withdrawal");
        require(record.epoch == epoch, "Wrong epoch");
        return (record.account, record.spender, record.amountSpent, txHash);
    }

    function getWithdrawalEpoch(
        bytes calldata,
        bytes calldata,
        bytes32 encAccount,
        uint256 currentEpochHint
    ) external view override returns (uint256 nextEpoch) {
        uint256 stored = currentEpoch[encAccount];
        return stored > currentEpochHint ? stored : currentEpochHint + 1;
    }

    function buildTransaction(
        address,
        bytes32,
        bytes calldata txData
    ) external pure override returns (bytes memory finalTx) {
        return txData;
    }

    function getTransactionCost(bytes calldata unsignedTx) external pure override returns (uint256 maxCost) {
        (maxCost,,,) = abi.decode(unsignedTx, (uint256, uint256, address, bool));
    }

    function getTransactionHash(bytes calldata signedTx) public pure override returns (bytes32 txHash) {
        return keccak256(signedTx);
    }

    function isValidForEpoch(bytes calldata unsignedTx, bytes32, uint256 epoch, address spender)
        external
        pure
        override
        returns (bool)
    {
        (, uint256 txEpoch, address txSpender, bool valid) = abi.decode(unsignedTx, (uint256, uint256, address, bool));
        return valid && txEpoch == epoch && txSpender == spender;
    }
}
