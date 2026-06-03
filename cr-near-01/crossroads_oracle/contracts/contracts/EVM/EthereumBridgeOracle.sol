// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IBridgeOracle} from "../IBridgeOracle.sol";
import {IBlockHashOracle} from "./IBlockHashOracle.sol";
import {ProvethVerifier, TransactionProof} from "./proveth/ProvethVerifier.sol";
import {TransactionSerializer} from "./TransactionSerializer.sol";
import {Type2TxMessage, Type2TxMessageSigned} from "./EthereumTransaction.sol";

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {RLPReader} from "solidity-rlp/contracts/RLPReader.sol";

contract BridgeOracle is IBridgeOracle {
    using RLPReader for bytes;
    using RLPReader for RLPReader.RLPItem;

    // Immutable references to the external helpers that the oracle needs to validate inclusion proofs and block hashes.
    IBlockHashOracle public immutable blockHashOracle;
    ProvethVerifier public immutable stateVerifier;

    constructor(IBlockHashOracle _blockHashOracle, ProvethVerifier _stateVerifier) {
        blockHashOracle = _blockHashOracle;
        stateVerifier = _stateVerifier;
    }

    /// @dev Returns the hash of a signed transaction. The v value is 27/28.
    /// TODO: Should we just make the v value 0/1? What do most Ethereum libraries use?
    function _signedTxHash(bytes calldata signedTx) internal pure returns (bytes32) {
        return keccak256(signedTx);
    }

    /// @dev Recovers the address that signed `signedTx`.
    function _recoverSigner(Type2TxMessageSigned memory signedTx) internal pure returns (address) {
        bytes memory unsignedTxData = TransactionSerializer.serializeTransaction(signedTx.transaction);
        bytes32 unsignedTxHash = keccak256(unsignedTxData);
        bytes memory signature = bytes.concat(bytes32(signedTx.r), bytes32(signedTx.s), bytes1(uint8(signedTx.v)));
        (address recovered, ECDSA.RecoverError err, bytes32 errArg) = ECDSA.tryRecover(unsignedTxHash, signature);
        // Silence unused argument warning
        errArg;
        require(err == ECDSA.RecoverError.NoError, "Invalid signature");
        return recovered;
    }

    /// @dev Extracts the spender address from the first 20 bytes of the payload.
    /// This is the withdrawal binding for Ethereum transactions.
    /// TODO: We can use the access list as another place to inject a withdrawal binding.
    function _extractSpender(bytes memory payload) internal pure returns (address) {
        require(payload.length >= 20, "Payload too short");
        return address(uint160(bytes20(payload)));
    }

    function _accountIdFromAddress(address nativeAddress) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(nativeAddress)));
    }

    function _addressFromAccountId(bytes32 accountId) internal pure returns (address) {
        return address(uint160(uint256(accountId)));
    }

    /// @dev Parses the block number from an RLP-encoded block header.
    function _blockNumberFromHeader(bytes memory rlpHeader) internal pure returns (uint256) {
        RLPReader.RLPItem memory headerItem = rlpHeader.toRlpItem();
        RLPReader.RLPItem[] memory headerList = headerItem.toList();
        // Block number is the 9th element (index 8) of the header.
        require(headerList.length > 8, "Malformed block header");
        return uint256(headerList[8].toUint());
    }

    /// @dev Validates the inclusion proof, checks the block hash against the oracle,
    /// and returns the transaction hash.
    function _verifyProof(
        bytes calldata signedTx,
        bytes calldata proof
    ) internal view returns (bytes32 txHash) {
        // Decode the generic `bytes` into the concrete `TransactionProof` struct.
        // TODO: Receipt proof also needs to be included here!
        TransactionProof memory txProof = abi.decode(proof, (TransactionProof));

        // Verify the transaction is included in the supplied block.
        bytes memory includedTx = stateVerifier.validateTxProof(txProof);

        // Compute the hash of the signed transaction
        bytes32 signedTxHash = _signedTxHash(signedTx);
        require(keccak256(includedTx) == signedTxHash, "Inclusion proof mismatch");

        // Verify that the block header's hash matches the oracle's value
        bytes32 blockHash = keccak256(txProof.rlpBlockHeader);
        uint256 blockNumber = _blockNumberFromHeader(txProof.rlpBlockHeader);
        require(blockHash == blockHashOracle.getBlockHash(blockNumber), "Block hash mismatch");

        return signedTxHash;
    }

    function verifyDeposit(
        bytes calldata txData,
        bytes calldata proof
    ) external override returns (address sender, bytes32 destination, uint256 amount, bytes32 txHash) {
        txHash = _verifyProof(txData, proof);
        Type2TxMessageSigned memory signedTx = _decodeSignedTx(txData);
        sender = _recoverSigner(signedTx);

        // Extract the destination (the encumbered address on the source chain) and amount.
        destination = _accountIdFromAddress(address(bytes20(signedTx.transaction.destination)));
        amount = signedTx.transaction.amount;
    }

    function getDepositEpoch(
        bytes calldata,
        bytes calldata,
        bytes32,
        uint256 currentEpochHint
    ) external pure override returns (uint256 nextEpoch) {
        // EVM deposits don't change the destination address's outgoing nonce.
        return currentEpochHint;
    }

    function verifyWithdrawal(
        bytes calldata txData,
        bytes calldata proof,
        bytes32,
        uint256 epoch
    ) external override returns (bytes32 account, address spender, uint256 amountSpent, bytes32 txHash) {
        // Verify inclusion proof and block hash
        txHash = _verifyProof(txData, proof);

        // Find which encumbered account this transaction came from
        Type2TxMessageSigned memory signedTx = _decodeSignedTx(txData);
        address acct = _recoverSigner(signedTx);
        account = _accountIdFromAddress(acct);
        require(signedTx.transaction.nonce == epoch, "Nonce invalid for epoch");

        // The spender is embedded in the calldata
        spender = _extractSpender(signedTx.transaction.payload);

        // Amount actually spent (the value transferred by the transaction).
        // TODO: THIS NEEDS TO BE THE ACTUAL GAS PRICE PAID
        amountSpent = signedTx.transaction.amount + signedTx.transaction.maxFeePerGas * signedTx.transaction.gasLimit;
    }

    function getWithdrawalEpoch(
        bytes calldata,
        bytes calldata,
        bytes32,
        uint256 currentEpochHint
    ) external pure override returns (uint256 nextEpoch) {
        // A withdrawal advances the EVM nonce by exactly one.
        return currentEpochHint + 1;
    }

    function buildTransaction(
        address,
        bytes32,
        bytes calldata txData
    ) external pure override returns (bytes memory finalTx) {
        return txData;
    }

    function getTransactionCost(bytes calldata unsignedTxData) external pure override returns (uint256 maxCost) {
        Type2TxMessage memory unsignedTx = _decodeType2Tx(unsignedTxData);
        maxCost = unsignedTx.amount + unsignedTx.gasLimit * unsignedTx.maxFeePerGas;
    }

    function getTransactionHash(
        bytes calldata signedTx
    ) external pure override returns (bytes32 txHash) {
        txHash = _signedTxHash(signedTx);
    }

    function isValidForEpoch(bytes calldata unsignedTxData, bytes32, uint256 epoch, address spender)
        external
        pure
        override
        returns (bool)
    {
        Type2TxMessage memory unsignedTx = _decodeType2Tx(unsignedTxData);
        // TODO: Add feedback mechanism in case something is wrong

        // Check nonce matches current epoch
        if (unsignedTx.nonce != epoch) {
            return false;
        }

        // Verify payload structure: must start with spender address
        if (unsignedTx.payload.length < 20) {
            return false;
        }
        address extractedSpender = _extractSpender(unsignedTx.payload);
        if (extractedSpender != spender) {
            return false;
        }

        return true;
    }

    function _decodeType2Tx(bytes calldata txData) internal pure returns (Type2TxMessage memory decoded) {
        require(txData.length > 0 && txData[0] == 0x02, "Unsupported tx type");
        RLPReader.RLPItem[] memory items = bytes(txData[1:]).toRlpItem().toList();
        require(items.length == 9, "Malformed type-2 tx");

        decoded = Type2TxMessage({
            chainId: items[0].toUint(),
            nonce: items[1].toUint(),
            maxPriorityFeePerGas: items[2].toUint(),
            maxFeePerGas: items[3].toUint(),
            gasLimit: items[4].toUint(),
            destination: items[5].toBytes(),
            amount: items[6].toUint(),
            payload: items[7].toBytes()
        });
    }

    function _decodeSignedTx(bytes calldata txData) internal pure returns (Type2TxMessageSigned memory decoded) {
        require(txData.length > 0 && txData[0] == 0x02, "Unsupported tx type");
        RLPReader.RLPItem[] memory items = bytes(txData[1:]).toRlpItem().toList();
        require(items.length == 12, "Malformed signed type-2 tx");

        uint256 v = items[9].toUint();
        if (v < 27) {
            v += 27;
        }

        decoded = Type2TxMessageSigned({
            transaction: Type2TxMessage({
                chainId: items[0].toUint(),
                nonce: items[1].toUint(),
                maxPriorityFeePerGas: items[2].toUint(),
                maxFeePerGas: items[3].toUint(),
                gasLimit: items[4].toUint(),
                destination: items[5].toBytes(),
                amount: items[6].toUint(),
                payload: items[7].toBytes()
            }),
            r: items[10].toUint(),
            s: items[11].toUint(),
            v: v
        });
    }
}
