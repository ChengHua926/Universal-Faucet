// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IBridgeOracle
 * @dev Minimal interface for a bridge/oracle that can verify cross-chain
 * deposits and withdrawals.
 *
 * The transaction payloads are chain-specific opaque bytes. Each bridge oracle
 * is responsible for decoding those bytes into its own transaction format.
 * Encumbered account identifiers are exchanged as `bytes32`: chains whose
 * native account ID is shorter than 32 bytes left-pad with zeros (for example
 * Bitcoin uses `bytes20(hash160) ++ 12 zero bytes`); chains whose native ID
 * exceeds 32 bytes hash into 32 bytes inside the oracle.
 */
interface IBridgeOracle {
    /**
     * @notice Verify that a deposit transaction was confirmed on the source chain,
     *   has not been reverted, and transferred `amount` native tokens to
     *   the `destination` encumbered account.
     *
     * @return sender Crossroads account that should be credited
     * @return destination Destination account identifier on the source chain
     * @return amount Amount of native asset transferred
     * @return txHash Unique identifier of the source-chain transaction
     */
    function verifyDeposit(
        bytes calldata txData,
        bytes calldata proof
    ) external returns (address sender, bytes32 destination, uint256 amount, bytes32 txHash);

    /**
     * @notice Returns the next epoch/state hint after a deposit is processed.
     *
     * Different source chains evolve encumbered-account state differently.
     * For example, a Bitcoin deposit typically rolls the tracked UTXO lineage
     * forward, while an EVM deposit into the encumbered address does not change
     * the sender account's nonce.
     *
     * @param txData Confirmed source-chain deposit transaction
     * @param proof Source-chain confirmation proof
     * @param encAccount Destination encumbered account identifier
     * @param currentEpoch Current tracked epoch/state hint for that account
     *
     * @return nextEpoch Epoch/state hint the asset contract should persist
     */
    function getDepositEpoch(
        bytes calldata txData,
        bytes calldata proof,
        bytes32 encAccount,
        uint256 currentEpoch
    ) external view returns (uint256 nextEpoch);

    /**
     * @notice Verify that a withdrawal transaction was confirmed on the source
     *   chain.
     *
     * The `encAccount` and `accountEpoch` inputs are opaque chain-specific
     * hints supplied by the asset contract so the oracle can validate the
     * transaction against the currently tracked account state.
     *
     * @return account Source-chain account identifier that spent the funds
     * @return spender Crossroads account that initiated the withdrawal
     * @return amountSpent Amount of native asset actually spent on-chain
     * @return txHash Unique identifier of the source-chain transaction
     */
    function verifyWithdrawal(
        bytes calldata txData,
        bytes calldata proof,
        bytes32 encAccount,
        uint256 accountEpoch
    ) external returns (bytes32 account, address spender, uint256 amountSpent, bytes32 txHash);

    /**
     * @notice Returns the next epoch/state hint after a withdrawal is processed.
     *
     * @param txData Confirmed source-chain withdrawal transaction
     * @param proof Source-chain confirmation proof
     * @param encAccount Encumbered account identifier tracked by the asset
     * @param currentEpoch Current tracked epoch/state hint for that account
     *
     * @return nextEpoch Epoch/state hint the asset contract should persist
     */
    function getWithdrawalEpoch(
        bytes calldata txData,
        bytes calldata proof,
        bytes32 encAccount,
        uint256 currentEpoch
    ) external view returns (uint256 nextEpoch);

    /**
     * @notice Returns a transaction with the correct details for the supplied
     *         encumbered account.
     *
     * @param spender Crossroads account that will sign the transaction
     * @param encAccount Encumbered account identifier on the source chain
     * @param txData Chain-specific unsigned transaction payload
     *
     * @return finalTx The same transaction with withdrawal binding and
     *         other details (e.g., nonce) filled in.
     */
    function buildTransaction(
        address spender,
        bytes32 encAccount,
        bytes calldata txData
    ) external view returns (bytes memory finalTx);

    /**
     * @notice Returns the maximum cost indicated by a transaction.
     *
     * @param unsignedTx The chain-specific unsigned transaction payload
     *
     * @return maxCost The maximum possible transaction cost this transaction
     *                 can spend from the account.
     */
    function getTransactionCost(bytes calldata unsignedTx) external view returns (uint256 maxCost);

    /**
     * @notice Returns the unique identifier of a signed source-chain transaction.
     *
     * @param signedTx The signed transaction to examine
     *
     * @return txHash A unique identifier for the transaction.
     */
    function getTransactionHash(bytes calldata signedTx) external view returns (bytes32 txHash);

    /**
     * @notice Returns whether the transaction is valid for an account's current
     * state/epoch. The oracle may interpret `accountEpoch` however is
     * appropriate for the source chain (for example, an EVM nonce or a tracked
     * Bitcoin UTXO lineage epoch).
     *
     * @param unsignedTx The chain-specific unsigned transaction payload
     * @param encAccount The encumbered account identifier
     * @param accountEpoch Chain-specific epoch/state hint to consider
     * @param spender Crossroads account spending the funds
     *
     * @return bool Whether the transaction is valid for the supplied account state.
     */
    function isValidForEpoch(
        bytes calldata unsignedTx,
        bytes32 encAccount,
        uint256 accountEpoch,
        address spender
    ) external view returns (bool);
}
