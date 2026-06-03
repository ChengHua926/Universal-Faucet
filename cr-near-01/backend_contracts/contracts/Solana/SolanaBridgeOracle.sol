// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IBridgeOracle} from "../IBridgeOracle.sol";
import {SolanaTransactionLib} from "./SolanaTransactionLib.sol";

/**
 * @title SolanaBridgeOracle
 * @notice Solana bridge finality/policy oracle.
 *
 * Transaction parsing and byte-level v0 decoding live in SolanaTransactionLib
 * and are exposed independently through SolanaTransactionCodec. This contract
 * keeps the bridge-specific state and rules:
 * - finalized Solana transaction signatures reported by the TEE/RPC oracle;
 * - durable nonce account and current nonce values per primary Solana account;
 * - IBridgeOracle deposit/withdrawal verification adapters.
 *
 * Account model used by Crossroads:
 * - encAccount is the 32-byte Solana primary account controlled by the signing committee.
 * - A durable nonce account is registered per primary account. Withdrawals must use the
 *   current registered durable nonce as the v0 message recent_blockhash.
 * - Deposit attribution and withdrawal spender binding are encoded as lowercase
 *   UTF-8 hex EVM addresses in an SPL Memo instruction.
 */
contract SolanaBridgeOracle is IBridgeOracle, Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    mapping(bytes32 => bool) public finalizedTransactions;
    mapping(address => bool) public oracleReportSigners;
    uint256 public oracleThreshold;

    // Primary Solana account => durable nonce account and currently spendable nonce value.
    mapping(bytes32 => bytes32) public durableNonceAccountForPrimary;
    mapping(bytes32 => bytes32) public currentDurableNonceForPrimary;

    /// @notice Solana protocol base fee per required signature, in lamports.
    /// Owner-settable so the bridge can track validator-set fee changes
    /// without redeploying. Folded into withdrawal `amountSpent`.
    uint64 public lamportsPerSignature;

    event OracleReportSignerChanged(address indexed signer, bool enabled);
    event OracleThresholdChanged(uint256 threshold);
    event SolanaTransactionFinalized(bytes32 indexed txHash, bytes transactionSignature);
    event DurableNonceConfigured(bytes32 indexed primaryAccount, bytes32 indexed nonceAccount, bytes32 currentNonce);
    event DurableNonceAdvanced(bytes32 indexed primaryAccount, bytes32 previousNonce, bytes32 currentNonce);
    event LamportsPerSignatureUpdated(uint64 newValue);

    constructor(address[] memory initialReportSigners, uint256 initialThreshold) Ownable(msg.sender) {
        oracleThreshold = initialThreshold;
        for (uint256 i = 0; i < initialReportSigners.length; i++) {
            oracleReportSigners[initialReportSigners[i]] = true;
            emit OracleReportSignerChanged(initialReportSigners[i], true);
        }
        require(initialThreshold <= initialReportSigners.length, "Threshold too high");
        lamportsPerSignature = 5_000;
        emit LamportsPerSignatureUpdated(5_000);
    }

    function setLamportsPerSignature(uint64 newValue) external onlyOwner {
        lamportsPerSignature = newValue;
        emit LamportsPerSignatureUpdated(newValue);
    }

    function setOracleReportSigner(address signer, bool enabled) external onlyOwner {
        oracleReportSigners[signer] = enabled;
        emit OracleReportSignerChanged(signer, enabled);
    }

    function setOracleThreshold(uint256 threshold) external onlyOwner {
        oracleThreshold = threshold;
        emit OracleThresholdChanged(threshold);
    }

    function setDurableNonce(
        bytes32 primaryAccount,
        bytes32 nonceAccount,
        bytes32 currentNonce
    ) external onlyOwner {
        require(primaryAccount != bytes32(0), "Primary account required");
        require(nonceAccount != bytes32(0), "Nonce account required");
        require(nonceAccount != primaryAccount, "Nonce account must differ");
        durableNonceAccountForPrimary[primaryAccount] = nonceAccount;
        currentDurableNonceForPrimary[primaryAccount] = currentNonce;
        emit DurableNonceConfigured(primaryAccount, nonceAccount, currentNonce);
    }

    function advanceDurableNonce(bytes32 primaryAccount, bytes32 currentNonce) external onlyOwner {
        bytes32 previous = currentDurableNonceForPrimary[primaryAccount];
        require(durableNonceAccountForPrimary[primaryAccount] != bytes32(0), "Nonce account not configured");
        require(currentNonce != bytes32(0), "Nonce required");
        require(currentNonce != previous, "Nonce unchanged");
        currentDurableNonceForPrimary[primaryAccount] = currentNonce;
        emit DurableNonceAdvanced(primaryAccount, previous, currentNonce);
    }

    function submitFinalizedTransaction(
        bytes calldata transactionSignature,
        bytes[] calldata reportSignatures
    ) external returns (bytes32 txHash) {
        txHash = _submitFinalizedTransaction(transactionSignature, reportSignatures);
    }

    function submitFinalizedTransactionBytes(
        bytes calldata signedTx,
        bytes[] calldata reportSignatures
    ) external returns (bytes32 txHash) {
        bytes memory sig = SolanaTransactionLib.getPrimarySignature(signedTx);
        txHash = _submitFinalizedTransaction(sig, reportSignatures);
    }

    function _submitFinalizedTransaction(
        bytes memory transactionSignature,
        bytes[] calldata reportSignatures
    ) internal returns (bytes32 txHash) {
        require(transactionSignature.length == 64, "Solana signature must be 64 bytes");
        txHash = keccak256(transactionSignature);
        if (oracleThreshold > 0) {
            bytes32 reportDigest = _oracleReportDigest(transactionSignature);
            uint256 valid;
            address lastSigner = address(0);
            for (uint256 i = 0; i < reportSignatures.length; i++) {
                address signer = reportDigest.toEthSignedMessageHash().recover(reportSignatures[i]);
                require(oracleReportSigners[signer], "Invalid oracle signer");
                require(signer > lastSigner, "Duplicate or unsorted signer");
                lastSigner = signer;
                valid += 1;
            }
            require(valid >= oracleThreshold, "Oracle threshold not met");
        } else {
            require(msg.sender == owner(), "Owner only when threshold is zero");
        }
        finalizedTransactions[txHash] = true;
        emit SolanaTransactionFinalized(txHash, transactionSignature);
    }

    function oracleReportDigest(bytes calldata transactionSignature) external view returns (bytes32) {
        return _oracleReportDigest(transactionSignature);
    }

    function _oracleReportDigest(bytes memory transactionSignature) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked("CROSSROADS_SOLANA_FINALIZED_TX_V1", block.chainid, address(this), transactionSignature)
        );
    }

    function verifyDeposit(
        bytes calldata txData,
        bytes calldata proof
    ) external override returns (address sender, bytes32 destination, uint256 amount, bytes32 txHash) {
        txHash = _verifyFinalized(txData, proof);
        (sender, destination, amount) =
            SolanaTransactionLib.extractMemoBoundTransfer(txData, false, bytes32(0));
    }

    function getDepositEpoch(
        bytes calldata,
        bytes calldata,
        bytes32,
        uint256 currentEpochHint
    ) external pure override returns (uint256 nextEpoch) {
        // Solana epoch evolution is driven by the durable-nonce account, not by
        // the asset's epoch counter. The asset just persists what the oracle
        // returns; deposits don't advance it.
        return currentEpochHint;
    }

    function verifyWithdrawal(
        bytes calldata txData,
        bytes calldata proof,
        bytes32 encAccount,
        uint256
    ) external override returns (bytes32 account, address spender, uint256 amountSpent, bytes32 txHash) {
        txHash = _verifyFinalized(txData, proof);
        (spender, amountSpent) = _verifyDurableNonceWithdrawal(txData, encAccount);
        account = encAccount;
    }

    function getWithdrawalEpoch(
        bytes calldata,
        bytes calldata,
        bytes32,
        uint256 currentEpochHint
    ) external pure override returns (uint256 nextEpoch) {
        // Withdrawal lineage on Solana is tracked through the durable-nonce
        // account on-chain. The asset's epoch counter mirrors this by
        // advancing once per successful withdrawal.
        return currentEpochHint + 1;
    }

    function buildTransaction(
        address,
        bytes32,
        bytes calldata txData
    ) external pure override returns (bytes memory finalTx) {
        return txData;
    }

    function getTransactionCost(bytes calldata unsignedTx) external pure override returns (uint256 maxCost) {
        (, , maxCost) = SolanaTransactionLib.extractMemoBoundTransfer(unsignedTx, false, bytes32(0));
    }

    function getTransactionCostForAccount(
        bytes calldata unsignedTx,
        bytes32 encAccount
    ) external view returns (uint256 maxCost) {
        (, maxCost) = _verifyDurableNonceWithdrawalSyntax(unsignedTx, encAccount, false, bytes32(0));
    }

    function getTransactionHash(bytes calldata signedTx) public pure override returns (bytes32 txHash) {
        return SolanaTransactionLib.getTransactionHash(signedTx);
    }

    function getTransactionWireHash(bytes calldata signedTx) external pure returns (bytes32) {
        return SolanaTransactionLib.getTransactionWireHash(signedTx);
    }

    function getMessageHash(bytes calldata signedOrUnsignedTx) external pure returns (bytes32) {
        return SolanaTransactionLib.getMessageHash(signedOrUnsignedTx);
    }

    function getPrimarySignature(bytes calldata signedTx) public pure returns (bytes memory) {
        return SolanaTransactionLib.getPrimarySignature(signedTx);
    }

    function isValidForEpoch(
        bytes calldata unsignedTx,
        bytes32 encAccount,
        uint256 epoch,
        address spender
    ) external view override returns (bool) {
        bytes32 requiredNonce = currentDurableNonceForPrimary[encAccount];
        if (requiredNonce == bytes32(0) && epoch != 0) {
            requiredNonce = bytes32(epoch);
        }
        try this.decodeWithdrawal(unsignedTx, encAccount, requiredNonce) returns (address decodedSpender, uint256) {
            return decodedSpender == spender;
        } catch {
            return false;
        }
    }

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

    function decodeWithdrawal(
        bytes calldata txData,
        bytes32 encAccount,
        bytes32 requiredNonce
    ) external view returns (address spender, uint256 amountSpent) {
        bytes32 nonceAccount = durableNonceAccountForPrimary[encAccount];
        return SolanaTransactionLib.decodeWithdrawal(
            txData,
            encAccount,
            nonceAccount,
            true,
            requiredNonce,
            lamportsPerSignature
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

    function _verifyFinalized(bytes calldata txData, bytes calldata proof) internal view returns (bytes32 txHash) {
        txHash = SolanaTransactionLib.getTransactionHash(txData);
        if (proof.length > 0) {
            bytes memory provedSignature = abi.decode(proof, (bytes));
            require(keccak256(provedSignature) == txHash, "Proof signature mismatch");
        }
        require(finalizedTransactions[txHash], "Solana tx not finalized");
    }

    function _verifyDurableNonceWithdrawal(
        bytes calldata txData,
        bytes32 encAccount
    ) internal view returns (address spender, uint256 amountSpent) {
        bytes32 requiredNonce = currentDurableNonceForPrimary[encAccount];
        require(requiredNonce != bytes32(0), "Current durable nonce unknown");
        return _verifyDurableNonceWithdrawalSyntax(txData, encAccount, true, requiredNonce);
    }

    function _verifyDurableNonceWithdrawalSyntax(
        bytes calldata txData,
        bytes32 encAccount,
        bool enforceNonce,
        bytes32 requiredNonce
    ) internal view returns (address spender, uint256 amountSpent) {
        bytes32 nonceAccount = durableNonceAccountForPrimary[encAccount];
        return SolanaTransactionLib.decodeWithdrawal(
            txData,
            encAccount,
            nonceAccount,
            enforceNonce,
            requiredNonce,
            lamportsPerSignature
        );
    }
}
