// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {SolanaTransactionLib} from "./SolanaTransactionLib.sol";

/**
 * @title SolanaTransactionCodec
 * @notice Thin deployable facade over SolanaTransactionLib for direct tests,
 * manual tooling, and future chain modules that only need parsing/codec logic.
 */
contract SolanaTransactionCodec {
    function decodeV0MessageHeader(
        bytes calldata signedOrUnsignedTx
    ) external pure returns (SolanaTransactionLib.MessageHeaderView memory) {
        return SolanaTransactionLib.decodeV0MessageHeader(signedOrUnsignedTx);
    }

    function decodeInstruction(
        bytes calldata signedOrUnsignedTx,
        uint256 instructionIndex
    )
        external
        pure
        returns (SolanaTransactionLib.InstructionView memory ix, bytes32 programId, bytes memory accounts, bytes memory data)
    {
        return SolanaTransactionLib.decodeInstruction(signedOrUnsignedTx, instructionIndex);
    }

    function decodeDeposit(bytes calldata txData) external pure returns (address sender, bytes32 destination, uint256 amount) {
        return SolanaTransactionLib.extractMemoBoundTransfer(txData, false, bytes32(0));
    }

    function decodeWithdrawalSyntax(
        bytes calldata txData,
        bytes32 encAccount,
        bytes32 nonceAccount,
        bytes32 requiredNonce,
        uint256 baseFeePerSignature
    ) external pure returns (address spender, uint256 amountSpent) {
        return SolanaTransactionLib.decodeWithdrawal(
            txData,
            encAccount,
            nonceAccount,
            true,
            requiredNonce,
            baseFeePerSignature
        );
    }

    function decodeNonceInitialization(
        bytes calldata txData,
        bytes32 expectedPrimary,
        bytes32 expectedNonceAccount
    ) external pure returns (SolanaTransactionLib.NonceInitializationView memory init) {
        init = SolanaTransactionLib.decodeNonceInitialization(txData);
        if (expectedPrimary != bytes32(0)) {
            require(init.authority == expectedPrimary, "Unexpected nonce authority");
        }
        if (expectedNonceAccount != bytes32(0)) {
            require(init.nonceAccount == expectedNonceAccount, "Unexpected nonce account");
        }
    }

    function getTransactionHash(bytes calldata signedTx) external pure returns (bytes32) {
        return SolanaTransactionLib.getTransactionHash(signedTx);
    }

    function getTransactionWireHash(bytes calldata signedTx) external pure returns (bytes32) {
        return SolanaTransactionLib.getTransactionWireHash(signedTx);
    }

    function getMessageHash(bytes calldata signedOrUnsignedTx) external pure returns (bytes32) {
        return SolanaTransactionLib.getMessageHash(signedOrUnsignedTx);
    }

    function getPrimarySignature(bytes calldata signedTx) external pure returns (bytes memory) {
        return SolanaTransactionLib.getPrimarySignature(signedTx);
    }
}
