// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IBridgeOracle} from "../IBridgeOracle.sol";
import {IBitcoinBlockHashOracle} from "./IBitcoinBlockHashOracle.sol";

contract BitcoinBridgeOracle is IBridgeOracle {
    /// @notice Sats burned (locked) into the encumbered UTXO at initial deposit.
    /// Held forever so the canonical Crossroads UTXO marker always exists
    /// AND is always above Bitcoin's standard P2WPKH dust threshold (~294 sats
    /// at default `dustrelayfee=3000 sat/kvB`), so a maximum-drain withdrawal
    /// always leaves a relayable change output. 546 matches the legacy P2PKH
    /// dust floor, which is the value the Bitcoin ecosystem treats as
    /// "definitely not dust" under all standard policies.
    uint64 public constant INITIAL_DEPOSIT_BURN_SATS = 546;

    IBitcoinBlockHashOracle public immutable blockHashOracle;

    /// @notice The single outstanding Bitcoin UTXO that backs each encumbered
    /// account at a particular epoch, tracked as (txid, vout, value). The
    /// protocol invariant is that every encumbered account has at most one
    /// Crossroads UTXO at any time: an initial deposit creates it at the
    /// account's current epoch, every subsequent deposit must spend it (and
    /// produce a strictly-larger replacement at the SAME epoch), and every
    /// withdrawal must spend it (advancing the epoch by one and producing at
    /// most one change UTXO at the NEW epoch). `value == 0` means no
    /// Crossroads UTXO is currently outstanding for this encumbered account
    /// at this epoch.
    struct CrossroadsUtxo {
        bytes32 txid;   // internal-byte-order, matches outpoint serialization
        uint32 vout;
        uint64 value;   // sats
    }
    mapping(bytes32 => mapping(uint256 => CrossroadsUtxo)) public crossroadsUtxoByEpoch;

    /// @notice The oracle's view of where each encumbered account is in its
    /// withdrawal/deposit lineage. Deposits do NOT advance this counter (they
    /// only mutate the UTXO at the current epoch). Withdrawals always
    /// advance it, even on full drain.
    mapping(bytes32 => uint256) public currentEpoch;

    /// @notice Reverse map from a specific outpoint
    /// (`keccak256(abi.encode(txid, vout))`) back to the encumbered account
    /// that the UTXO at that outpoint belongs to. Maintained alongside
    /// `crossroadsUtxoByEpoch` so subsequent deposits can identify their
    /// destination by which UTXO they consume, independent of output
    /// ordering. The sentinel `bytes32(0)` means "no tracked owner" — a real
    /// encAccount derived from a hash160 is statistically guaranteed to be
    /// non-zero.
    mapping(bytes32 => bytes32) public utxoOwner;

    /// @notice Txids already processed in either the deposit or withdrawal role.
    /// A single mapping (rather than two role-specific ones) prevents the same
    /// signed Bitcoin transaction from being submitted to both `asset.deposit`
    /// and `asset.finalizeWithdrawal` and corrupting `crossroadsUtxoByEpoch`.
    mapping(bytes32 => bool) public processedTransaction;

    struct BitcoinTxProof {
        uint256 blockHeight;
        bytes blockHeader;
        bytes32[] merkleProof;
        uint256 txIndex;
    }

    constructor(IBitcoinBlockHashOracle _blockHashOracle) {
        blockHashOracle = _blockHashOracle;
    }

    function verifyDeposit(
        bytes calldata txData,
        bytes calldata proof
    ) external override returns (address sender, bytes32 destination, uint256 amount, bytes32 txHash) {
        txHash = _verifyProof(txData, proof);
        require(!processedTransaction[txHash], "Transaction already processed");
        bytes memory txBytes = txData;
        sender = _extractSpender(txBytes);

        // Determine destination via the consumed Crossroads UTXO if any (so
        // subsequent deposits identify their target encAccount unambiguously,
        // regardless of where the wallet places its own change output).
        (bytes32 consumedTxid, uint32 consumedVout, bool isSubsequent) =
            _findConsumedCrossroadsUtxoMemory(txBytes);

        CrossroadsUtxo memory cur;
        uint256 destEpoch;
        if (isSubsequent) {
            destination = utxoOwner[_utxoKey(consumedTxid, consumedVout)];
            destEpoch = currentEpoch[destination];
            cur = crossroadsUtxoByEpoch[destination][destEpoch];
            require(cur.value > 0, "Consumed UTXO is not the current Crossroads UTXO");
            require(
                cur.txid == consumedTxid && cur.vout == consumedVout,
                "Consumed UTXO is not the current Crossroads UTXO"
            );
        } else {
            // Initial deposit: destination is dictated by the first P2WPKH
            // output's hash. Any tx that creates a Crossroads UTXO without
            // consuming an existing one is an initial deposit. Solidity
            // left-aligns `bytes20` into `bytes32`, producing the canonical
            // `hash160 ++ 12 zero bytes` encumbered-account form.
            (bytes20 firstHash, ) = _firstP2wpkhOutputMemory(txBytes);
            require(firstHash != bytes20(0), "No P2WPKH output");
            destination = bytes32(firstHash);
            destEpoch = currentEpoch[destination];
            require(
                crossroadsUtxoByEpoch[destination][destEpoch].value == 0,
                "Initial deposit requires no existing Crossroads UTXO"
            );
        }

        // Find the (unique) new Crossroads UTXO output for the destination.
        (uint32 newVout, uint64 newValue, uint256 outputCount) =
            _findEncumberedOutput(txBytes, _hash160FromAccount(destination));
        require(outputCount == 1, "Deposit must have exactly one encumbered output");

        if (isSubsequent) {
            require(newValue > cur.value, "Subsequent deposit must increase Crossroads UTXO value");
            amount = uint256(newValue) - uint256(cur.value);
        } else {
            // Initial deposit: burn `INITIAL_DEPOSIT_BURN_SATS` so the encumbered
            // UTXO is *permanently* above Bitcoin's standard dust threshold —
            // ensuring (a) the canonical Crossroads UTXO marker always exists,
            // closing the race window where a second party could try to be
            // initial-depositor, AND (b) a maximum-drain withdrawal always
            // leaves a relayable, non-dust change output. The user's
            // maximum-possible cWBTC is `newValue - INITIAL_DEPOSIT_BURN_SATS`,
            // so the asset's canSign cost bound implies every withdrawal must
            // leave at least `INITIAL_DEPOSIT_BURN_SATS` of change.
            require(
                newValue > INITIAL_DEPOSIT_BURN_SATS,
                "Initial deposit must exceed the burned UTXO marker reserve"
            );
            amount = uint256(newValue) - uint256(INITIAL_DEPOSIT_BURN_SATS);
        }

        // Every successful deposit advances the epoch. The new UTXO lives at
        // the new slot; the old slot is preserved as historical state so
        // getDepositEpoch / getWithdrawalEpoch can be view-only and the asset
        // can replay the lookup if needed.
        uint256 newEpoch = destEpoch + 1;
        processedTransaction[txHash] = true;
        if (isSubsequent) {
            delete utxoOwner[_utxoKey(cur.txid, cur.vout)];
        }
        crossroadsUtxoByEpoch[destination][newEpoch] = CrossroadsUtxo({
            txid: txHash,
            vout: newVout,
            value: newValue
        });
        utxoOwner[_utxoKey(txHash, newVout)] = destination;
        currentEpoch[destination] = newEpoch;
    }

    function getDepositEpoch(
        bytes calldata /* txData */,
        bytes calldata /* proof */,
        bytes32 encAccount,
        uint256 /* currentEpochHint */
    ) external view override returns (uint256 nextEpoch) {
        // verifyDeposit advances currentEpoch by 1 (the new UTXO lives at the
        // new slot). Return the post-advance value so the asset's accountEpoch
        // stays in lockstep with the oracle's currentEpoch.
        return currentEpoch[encAccount];
    }

    /// @notice Finalize a withdrawal. Strict invariants (single-input, no
    /// fragmentation, RBF) live in `isValidForEpoch` / canSign so the
    /// committee NEVER signs a malformed withdrawal. But once a committee-
    /// signed transaction consuming the current Crossroads UTXO has been
    /// included in a Bitcoin block, this function MUST NOT revert merely
    /// because the tx structure is unexpected — doing so would freeze every
    /// future operation on the encumbered account. Only invariants we can't
    /// safely paper over (proof validity, replay protection, the current UTXO
    /// existing and being consumed, the epoch supplied matching the oracle's
    /// view) remain hard requirements; anything else degrades gracefully and
    /// the bridge follows Bitcoin.
    function verifyWithdrawal(
        bytes calldata txData,
        bytes calldata proof,
        bytes32 encAccount,
        uint256 accountEpoch
    ) external override returns (bytes32 account, address spender, uint256 amountSpent, bytes32 txHash) {
        txHash = _verifyProof(txData, proof);
        require(!processedTransaction[txHash], "Transaction already processed");
        require(accountEpoch == currentEpoch[encAccount], "Wrong epoch for encAccount");
        bytes memory txBytes = txData;
        bytes20 expectedHash = _hash160FromAccount(encAccount);
        // Witness pubkey must hash to encAccount — sanity check that the
        // caller identified the right encumbered account for this signed tx.
        _requireWitnessSignerMatches(txBytes, expectedHash);
        account = encAccount;
        spender = _extractSpenderOrZero(txBytes);

        amountSpent = _applyWithdrawalEffects(txBytes, expectedHash, encAccount, accountEpoch, txHash);
    }

    /// @dev Splits the body of `verifyWithdrawal` out so the parent function
    /// stays under the 16-local stack-too-deep limit. Returns `amountSpent`
    /// and writes both the new tracked UTXO (if any) and the new epoch.
    function _applyWithdrawalEffects(
        bytes memory txBytes,
        bytes20 expectedHash,
        bytes32 encAccount,
        uint256 accountEpoch,
        bytes32 txHash
    ) internal returns (uint256 amountSpent) {
        CrossroadsUtxo memory cur = crossroadsUtxoByEpoch[encAccount][accountEpoch];
        require(cur.value > 0, "No Crossroads UTXO to withdraw from");
        // The transaction MUST consume the current Crossroads UTXO; without
        // that the bridge has no basis to debit the encumbered balance.
        // Multi-input txs are tolerated here (canSign rejects them).
        require(
            _spendsOutpoint(txBytes, cur.txid, cur.vout),
            "Withdrawal must consume current Crossroads UTXO"
        );

        // Count and total all P2WPKH outputs paying back to the encumbered
        // address. canSign forbids count > 1, but if such a tx slipped through
        // we still process it: the bridge stops tracking a canonical
        // Crossroads UTXO for this encAccount (those fragments become
        // unreachable by the bridge) and the spending balance is charged for
        // the missing sats.
        (uint32 firstChangeVout, uint64 firstChangeValue, uint256 changeCount) =
            _findEncumberedOutput(txBytes, expectedHash);
        {
            uint256 totalChange = changeCount <= 1
                ? uint256(firstChangeValue)
                : _changeOutputAmount(txBytes, expectedHash);
            // Cap the change at the consumed UTXO value so amountSpent never
            // underflows (this can happen if a multi-input tx padded the change).
            uint256 cappedChange = totalChange > uint256(cur.value) ? uint256(cur.value) : totalChange;
            amountSpent = uint256(cur.value) - cappedChange;
        }

        processedTransaction[txHash] = true;
        delete utxoOwner[_utxoKey(cur.txid, cur.vout)];
        uint256 newEpoch = accountEpoch + 1;
        if (changeCount == 1) {
            crossroadsUtxoByEpoch[encAccount][newEpoch] =
                CrossroadsUtxo({txid: txHash, vout: firstChangeVout, value: firstChangeValue});
            utxoOwner[_utxoKey(txHash, firstChangeVout)] = encAccount;
        }
        // Always advance the epoch — even on full drain or fragmented output.
        // Full drain "should never happen" because of the initial-deposit burn
        // (INITIAL_DEPOSIT_BURN_SATS), but if a canSign-bypassing tx ever does
        // fully drain the UTXO, the asset's WithdrawalInconsistency event
        // still fires and the account is gracefully retired.
        currentEpoch[encAccount] = newEpoch;
    }

    function getWithdrawalEpoch(
        bytes calldata /* txData */,
        bytes calldata /* proof */,
        bytes32 encAccount,
        uint256 /* currentEpochHint */
    ) external view override returns (uint256 nextEpoch) {
        // verifyWithdrawal has already advanced `currentEpoch[encAccount]` by 1
        // by the time the asset reads this. Return the post-advance value so
        // the asset's accountEpoch stays in lockstep (one increment per
        // withdrawal, not two).
        return currentEpoch[encAccount];
    }

    function buildTransaction(
        address /* spender */,
        bytes32 /* encAccount */,
        bytes calldata txData
    ) external pure override returns (bytes memory finalTx) {
        // Bitcoin transactions don't have an EVM-style spender-nonce slot to
        // fill, so we pass the tx through unchanged.
        return txData;
    }

    function _utxoKey(bytes32 txid, uint32 vout) internal pure returns (bytes32) {
        return keccak256(abi.encode(txid, vout));
    }

    function getTransactionCost(bytes calldata /* unsignedTx */) external pure override returns (uint256 maxCost) {
        // No encAccount context: return the maximum possible value as a safe
        // default. The asset contract calls `getTransactionCostForAccount`
        // first via the IAccountAwareBridgeOracle pattern, which uses the
        // tracked Crossroads UTXO to compute an actual bound.
        return type(uint256).max;
    }

    function getTransactionCostForAccount(
        bytes calldata unsignedTx,
        bytes32 encAccount
    ) external view returns (uint256 maxCost) {
        uint256 epoch = currentEpoch[encAccount];
        CrossroadsUtxo memory cur = crossroadsUtxoByEpoch[encAccount][epoch];
        if (cur.value == 0) {
            return type(uint256).max;
        }
        (, uint64 newOutputValue, uint256 outputCount) =
            _findEncumberedOutputCalldata(unsignedTx, _hash160FromAccount(encAccount));
        // Exactly one P2WPKH output back to encAccount, in both the withdrawal
        // and consolidation-deposit cases. (Zero would be a full drain — not
        // permitted at sign time because of the INITIAL_DEPOSIT_BURN_SATS
        // invariant; ≥2 would fragment the encumbered UTXO.)
        if (outputCount != 1) {
            return type(uint256).max;
        }
        if (newOutputValue > cur.value) {
            // Consolidation deposit: the depositor contributes additional inputs
            // to grow the encumbered UTXO. Multi-input is required. Cost is 0
            // because no value leaves the encumbered pool.
            if (!_spendsOutpointCalldata(unsignedTx, cur.txid, cur.vout)) {
                return type(uint256).max;
            }
            return 0;
        }
        // Withdrawal: the only input must be the current encumbered UTXO so the
        // depositor can't pad the change with external sats and game the
        // spending-balance accounting.
        if (!_spendsSoleOutpointCalldata(unsignedTx, cur.txid, cur.vout)) {
            return type(uint256).max;
        }
        maxCost = uint256(cur.value) - uint256(newOutputValue);
    }

    function getTransactionHash(bytes calldata signedTx) external pure override returns (bytes32 txHash) {
        txHash = _txId(bytes(signedTx));
    }

    function isValidForEpoch(
        bytes calldata unsignedTx,
        bytes32 encAccount,
        uint256 accountEpoch,
        address spender
    ) external view override returns (bool) {
        if (accountEpoch != currentEpoch[encAccount]) {
            return false;
        }
        CrossroadsUtxo memory cur = crossroadsUtxoByEpoch[encAccount][accountEpoch];
        if (cur.value == 0) {
            return false;
        }
        bytes memory txBytes = unsignedTx;
        if (_extractSpenderOrZero(txBytes) != spender) {
            return false;
        }
        // Every committee-signed tx (deposit or withdrawal) MUST opt into BIP125
        // RBF so a stuck tx can be fee-bumped without a fresh signing round.
        // Sequence 0xffffffff and 0xfffffffe both block replaceability and
        // (for 0xffffffff) disable Bitcoin's locktime enforcement — neither
        // is acceptable here.
        if (!_signalsRbf(txBytes)) {
            return false;
        }
        // Exactly one P2WPKH output back to encAccount in both deposit and
        // withdrawal cases (the new Crossroads UTXO).
        (, uint64 newOutputValue, uint256 outputCount) =
            _findEncumberedOutput(txBytes, _hash160FromAccount(encAccount));
        if (outputCount != 1) {
            return false;
        }
        if (newOutputValue > cur.value) {
            // Consolidation deposit: depositor adds value, multi-input is
            // required. canSign permits anyone to request this signature
            // because no value leaves the encumbered pool.
            return _spendsOutpoint(txBytes, cur.txid, cur.vout);
        }
        // Withdrawal: the only input must be the current encumbered UTXO so
        // external sats can't be smuggled through.
        return _spendsSoleOutpointMemory(txBytes, cur.txid, cur.vout);
    }

    function _verifyProof(bytes calldata signedTx, bytes calldata proof) internal view returns (bytes32 txHash) {
        txHash = _txId(bytes(signedTx));
        // No shortcut for empty proofs — even synthetic tests must produce a valid
        // (single-tx) inclusion proof and push the matching block hash into the
        // configured block-hash oracle. Removing this guard was previously a free
        // mint vector.
        BitcoinTxProof memory txProof = abi.decode(proof, (BitcoinTxProof));
        require(txProof.blockHeader.length == 80, "Malformed block header");
        require(
            _doubleSha256(txProof.blockHeader) == blockHashOracle.getBlockHash(txProof.blockHeight),
            "Block hash mismatch"
        );

        bytes32 root = txHash;
        uint256 index = txProof.txIndex;
        for (uint256 i = 0; i < txProof.merkleProof.length; i++) {
            if (index & 1 == 0) {
                root = _doubleSha25632(root, txProof.merkleProof[i]);
            } else {
                root = _doubleSha25632(txProof.merkleProof[i], root);
            }
            index >>= 1;
        }

        require(root == _readBytes32(txProof.blockHeader, 36), "Merkle root mismatch");
    }

    function _txId(bytes memory txBytes) internal pure returns (bytes32) {
        return _doubleSha256(_stripWitness(txBytes));
    }

    function _stripWitness(bytes memory txBytes) internal pure returns (bytes memory) {
        if (!_hasWitness(txBytes)) {
            return txBytes;
        }

        uint256 inOffset = 6;
        (uint256 inputCount, uint256 offset) = _readVarInt(txBytes, inOffset);
        for (uint256 i = 0; i < inputCount; i++) {
            offset += 36;
            (uint256 scriptLen, uint256 next) = _readVarInt(txBytes, offset);
            offset = next + scriptLen + 4;
        }

        (uint256 outputCount, uint256 outputsOffset) = _readVarInt(txBytes, offset);
        uint256 endOutputs = outputsOffset;
        for (uint256 i = 0; i < outputCount; i++) {
            endOutputs += 8;
            (uint256 scriptLen, uint256 next) = _readVarInt(txBytes, endOutputs);
            endOutputs = next + scriptLen;
        }

        bytes memory out = new bytes(4 + (endOutputs - 6) + 4);
        _copy(txBytes, 0, out, 0, 4);
        _copy(txBytes, 6, out, 4, endOutputs - 6);
        _copy(txBytes, txBytes.length - 4, out, out.length - 4, 4);
        return out;
    }

    function _firstP2wpkhOutputMemory(bytes memory txBytes)
        internal
        pure
        returns (bytes20 accountHash, uint32 vout)
    {
        (uint256 outputCount, uint256 offset) = _outputsOffset(txBytes);
        for (uint256 i = 0; i < outputCount; i++) {
            offset += 8;
            (uint256 scriptLen, uint256 scriptOffset) = _readVarInt(txBytes, offset);
            if (_isP2wpkh(txBytes, scriptOffset, scriptLen)) {
                return (_readBytes20(txBytes, scriptOffset + 2), uint32(i));
            }
            offset = scriptOffset + scriptLen;
        }
        return (bytes20(0), 0);
    }

    /// @dev Returns (vout, value, count) for P2WPKH outputs whose program
    /// matches `accountHash`. The single-UTXO invariant requires count <= 1
    /// after a withdrawal and count == 1 on a deposit; callers enforce.
    function _findEncumberedOutput(bytes memory txBytes, bytes20 accountHash)
        internal
        pure
        returns (uint32 vout, uint64 value, uint256 count)
    {
        (uint256 outputCount, uint256 offset) = _outputsOffset(txBytes);
        for (uint256 i = 0; i < outputCount; i++) {
            uint64 v = _readUint64LE(txBytes, offset);
            offset += 8;
            (uint256 scriptLen, uint256 scriptOffset) = _readVarInt(txBytes, offset);
            if (
                _isP2wpkh(txBytes, scriptOffset, scriptLen) &&
                _readBytes20(txBytes, scriptOffset + 2) == accountHash
            ) {
                count += 1;
                if (count == 1) {
                    vout = uint32(i);
                    value = v;
                }
            }
            offset = scriptOffset + scriptLen;
        }
    }

    function _findEncumberedOutputCalldata(bytes calldata txBytes, bytes20 accountHash)
        internal
        pure
        returns (uint32 vout, uint64 value, uint256 count)
    {
        (uint256 outputCount, uint256 offset) = _outputsOffsetCalldata(txBytes);
        for (uint256 i = 0; i < outputCount; i++) {
            uint64 v = _readUint64LECalldata(txBytes, offset);
            offset += 8;
            (uint256 scriptLen, uint256 scriptOffset) = _readVarIntCalldata(txBytes, offset);
            if (
                _isP2wpkhCalldata(txBytes, scriptOffset, scriptLen) &&
                bytes20(txBytes[scriptOffset + 2:scriptOffset + 22]) == accountHash
            ) {
                count += 1;
                if (count == 1) {
                    vout = uint32(i);
                    value = v;
                }
            }
            offset = scriptOffset + scriptLen;
        }
    }

    /// @dev Scan tx inputs for one that matches a tracked Crossroads outpoint.
    /// Returns the matched outpoint and `found=true` on the first match. Used by
    /// `verifyDeposit` to identify chained deposits without trusting output ordering.
    function _findConsumedCrossroadsUtxoMemory(bytes memory txBytes)
        internal
        view
        returns (bytes32 outTxid, uint32 outVout, bool found)
    {
        uint256 offset = 4;
        if (_hasWitness(txBytes)) {
            offset += 2;
        }
        (uint256 inputCount, uint256 next) = _readVarInt(txBytes, offset);
        offset = next;
        for (uint256 i = 0; i < inputCount; i++) {
            bytes32 candTxid = _readBytes32(txBytes, offset);
            offset += 32;
            uint32 candVout = _readUint32LE(txBytes, offset);
            offset += 4;
            (uint256 scriptLen, uint256 scriptOffset) = _readVarInt(txBytes, offset);
            offset = scriptOffset + scriptLen + 4;
            if (utxoOwner[_utxoKey(candTxid, candVout)] != bytes32(0)) {
                return (candTxid, candVout, true);
            }
        }
        return (bytes32(0), 0, false);
    }

    /// @dev True iff at least one input has sequence < 0xfffffffe (BIP125 opt-in
    /// RBF). Any committee-signable withdrawal must satisfy this.
    function _signalsRbf(bytes memory txBytes) internal pure returns (bool) {
        uint256 offset = 4;
        if (_hasWitness(txBytes)) {
            offset += 2;
        }
        (uint256 inputCount, uint256 next) = _readVarInt(txBytes, offset);
        offset = next;
        for (uint256 i = 0; i < inputCount; i++) {
            offset += 36; // skip outpoint (txid + vout)
            (uint256 scriptLen, uint256 scriptOffset) = _readVarInt(txBytes, offset);
            offset = scriptOffset + scriptLen;
            uint32 sequence = _readUint32LE(txBytes, offset);
            offset += 4;
            if (sequence < 0xfffffffe) {
                return true;
            }
        }
        return false;
    }

    /// @dev True iff *any* input of the tx is the named outpoint. Used by
    /// `verifyWithdrawal` (which tolerates multi-input committee-signed txs to
    /// avoid freezing funds when canSign was bypassed).
    function _spendsOutpoint(bytes memory txBytes, bytes32 prevTxid, uint32 prevVout)
        internal
        pure
        returns (bool)
    {
        uint256 offset = 4;
        if (_hasWitness(txBytes)) {
            offset += 2;
        }
        (uint256 inputCount, uint256 next) = _readVarInt(txBytes, offset);
        offset = next;
        for (uint256 i = 0; i < inputCount; i++) {
            bytes32 candTxid = _readBytes32(txBytes, offset);
            offset += 32;
            uint32 candVout = _readUint32LE(txBytes, offset);
            offset += 4;
            (uint256 scriptLen, uint256 scriptOffset) = _readVarInt(txBytes, offset);
            offset = scriptOffset + scriptLen + 4;
            if (candTxid == prevTxid && candVout == prevVout) {
                return true;
            }
        }
        return false;
    }

    /// @dev True iff *any* input of the tx is the named outpoint. Calldata
    /// twin of `_spendsOutpoint`. Used by `getTransactionCostForAccount` to
    /// accept multi-input consolidation deposits.
    function _spendsOutpointCalldata(bytes calldata txBytes, bytes32 prevTxid, uint32 prevVout)
        internal
        pure
        returns (bool)
    {
        uint256 offset = 4;
        if (_hasWitnessCalldata(txBytes)) {
            offset += 2;
        }
        (uint256 inputCount, uint256 next) = _readVarIntCalldata(txBytes, offset);
        offset = next;
        for (uint256 i = 0; i < inputCount; i++) {
            bytes32 candTxid = bytes32(txBytes[offset:offset + 32]);
            offset += 32;
            uint32 candVout = _readUint32LECalldata(txBytes, offset);
            offset += 4;
            (uint256 scriptLen, uint256 scriptOffset) = _readVarIntCalldata(txBytes, offset);
            offset = scriptOffset + scriptLen + 4;
            if (candTxid == prevTxid && candVout == prevVout) {
                return true;
            }
        }
        return false;
    }

    /// @dev True iff the tx has exactly one input and that input is the named outpoint.
    /// Used by canSign (via `isValidForEpoch` / `getTransactionCostForAccount`)
    /// to forbid multi-input withdrawals at sign time.
    function _spendsSoleOutpointMemory(bytes memory txBytes, bytes32 prevTxid, uint32 prevVout)
        internal
        pure
        returns (bool)
    {
        uint256 offset = 4;
        if (_hasWitness(txBytes)) {
            offset += 2;
        }
        (uint256 inputCount, uint256 next) = _readVarInt(txBytes, offset);
        if (inputCount != 1) {
            return false;
        }
        bytes32 candTxid = _readBytes32(txBytes, next);
        uint32 candVout = _readUint32LE(txBytes, next + 32);
        return candTxid == prevTxid && candVout == prevVout;
    }

    function _spendsSoleOutpointCalldata(bytes calldata txBytes, bytes32 prevTxid, uint32 prevVout)
        internal
        pure
        returns (bool)
    {
        uint256 offset = 4;
        if (_hasWitnessCalldata(txBytes)) {
            offset += 2;
        }
        (uint256 inputCount, uint256 next) = _readVarIntCalldata(txBytes, offset);
        if (inputCount != 1) {
            return false;
        }
        bytes32 candTxid = bytes32(txBytes[next:next + 32]);
        uint32 candVout = _readUint32LECalldata(txBytes, next + 32);
        return candTxid == prevTxid && candVout == prevVout;
    }

    function _changeOutputAmount(bytes memory txBytes, bytes20 changeAccount) internal pure returns (uint256 amount) {
        (uint256 outputCount, uint256 offset) = _outputsOffset(txBytes);
        for (uint256 i = 0; i < outputCount; i++) {
            uint256 value = _readUint64LE(txBytes, offset);
            offset += 8;
            (uint256 scriptLen, uint256 scriptOffset) = _readVarInt(txBytes, offset);
            if (
                _isP2wpkh(txBytes, scriptOffset, scriptLen) &&
                _readBytes20(txBytes, scriptOffset + 2) == changeAccount
            ) {
                amount += value;
            }
            offset = scriptOffset + scriptLen;
        }
    }

    function _requireWitnessSignerMatches(bytes memory txBytes, bytes20 expectedHash160) internal pure {
        require(_hasWitness(txBytes), "Missing witness");
        uint256 inputCount;
        uint256 outputCount;
        uint256 offset;
        (inputCount, offset) = _readVarInt(txBytes, 6);
        for (uint256 i = 0; i < inputCount; i++) {
            offset += 36;
            (uint256 scriptLen, uint256 next) = _readVarInt(txBytes, offset);
            offset = next + scriptLen + 4;
        }
        (outputCount, offset) = _readVarInt(txBytes, offset);
        for (uint256 i = 0; i < outputCount; i++) {
            offset += 8;
            (uint256 scriptLen, uint256 next) = _readVarInt(txBytes, offset);
            offset = next + scriptLen;
        }
        for (uint256 inputIndex = 0; inputIndex < inputCount; inputIndex++) {
            (uint256 itemCount, uint256 witnessOffset) = _readVarInt(txBytes, offset);
            offset = witnessOffset;
            for (uint256 itemIndex = 0; itemIndex < itemCount; itemIndex++) {
                (uint256 itemLen, uint256 itemOffset) = _readVarInt(txBytes, offset);
                if ((itemLen == 33 || itemLen == 65) && itemIndex > 0) {
                    bytes20 hash = ripemd160(abi.encodePacked(sha256(_slice(txBytes, itemOffset, itemLen))));
                    if (hash == expectedHash160) {
                        return;
                    }
                }
                offset = itemOffset + itemLen;
            }
        }
        revert("Witness signer mismatch");
    }

    function _extractSpender(bytes memory txBytes) internal pure returns (address spender) {
        spender = _extractSpenderOrZero(txBytes);
        require(spender != address(0), "Missing spender binding");
    }

    function _extractSpenderOrZero(bytes memory txBytes) internal pure returns (address spender) {
        (uint256 outputCount, uint256 offset) = _outputsOffset(txBytes);
        for (uint256 i = 0; i < outputCount; i++) {
            offset += 8;
            (uint256 scriptLen, uint256 scriptOffset) = _readVarInt(txBytes, offset);
            if (_isOpReturnSpender(txBytes, scriptOffset, scriptLen)) {
                return address(uint160(_readBytes20(txBytes, scriptOffset + 2)));
            }
            offset = scriptOffset + scriptLen;
        }
        return address(0);
    }

    function _outputsOffset(bytes memory txBytes) internal pure returns (uint256 outputCount, uint256 offset) {
        uint256 start = _hasWitness(txBytes) ? 6 : 4;
        uint256 inputCount;
        (inputCount, offset) = _readVarInt(txBytes, start);
        for (uint256 i = 0; i < inputCount; i++) {
            require(offset + 36 <= txBytes.length, "Malformed input");
            offset += 36;
            (uint256 scriptLen, uint256 next) = _readVarInt(txBytes, offset);
            offset = next + scriptLen + 4;
            require(offset <= txBytes.length, "Malformed input script");
        }
        (outputCount, offset) = _readVarInt(txBytes, offset);
    }

    function _outputsOffsetCalldata(
        bytes calldata txBytes
    ) internal pure returns (uint256 outputCount, uint256 offset) {
        uint256 start = _hasWitnessCalldata(txBytes) ? 6 : 4;
        uint256 inputCount;
        (inputCount, offset) = _readVarIntCalldata(txBytes, start);
        for (uint256 i = 0; i < inputCount; i++) {
            require(offset + 36 <= txBytes.length, "Malformed input");
            offset += 36;
            (uint256 scriptLen, uint256 next) = _readVarIntCalldata(txBytes, offset);
            offset = next + scriptLen + 4;
            require(offset <= txBytes.length, "Malformed input script");
        }
        (outputCount, offset) = _readVarIntCalldata(txBytes, offset);
    }

    function _isP2wpkh(bytes memory txBytes, uint256 offset, uint256 len) internal pure returns (bool) {
        return len == 22 && txBytes[offset] == 0x00 && txBytes[offset + 1] == 0x14;
    }

    function _isP2wpkhCalldata(bytes calldata txBytes, uint256 offset, uint256 len) internal pure returns (bool) {
        return len == 22 && txBytes[offset] == 0x00 && txBytes[offset + 1] == 0x14;
    }

    function _isOpReturnSpender(bytes memory txBytes, uint256 offset, uint256 len) internal pure returns (bool) {
        return len == 22 && txBytes[offset] == 0x6a && txBytes[offset + 1] == 0x14;
    }

    function _hasWitness(bytes memory txBytes) internal pure returns (bool) {
        return txBytes.length > 5 && txBytes[4] == 0x00 && txBytes[5] != 0x00;
    }

    function _hasWitnessCalldata(bytes calldata txBytes) internal pure returns (bool) {
        return txBytes.length > 5 && txBytes[4] == 0x00 && txBytes[5] != 0x00;
    }

    function _readVarInt(bytes memory data, uint256 offset) internal pure returns (uint256 value, uint256 next) {
        require(offset < data.length, "Malformed varint");
        uint8 tag = uint8(data[offset]);
        if (tag < 0xfd) {
            return (tag, offset + 1);
        }
        if (tag == 0xfd) {
            require(offset + 3 <= data.length, "Malformed varint16");
            return (uint16(uint8(data[offset + 1])) | (uint16(uint8(data[offset + 2])) << 8), offset + 3);
        }
        if (tag == 0xfe) {
            return (_readUint32LE(data, offset + 1), offset + 5);
        }
        return (_readUint64LE(data, offset + 1), offset + 9);
    }

    function _readVarIntCalldata(
        bytes calldata data,
        uint256 offset
    ) internal pure returns (uint256 value, uint256 next) {
        require(offset < data.length, "Malformed varint");
        uint8 tag = uint8(data[offset]);
        if (tag < 0xfd) {
            return (tag, offset + 1);
        }
        if (tag == 0xfd) {
            require(offset + 3 <= data.length, "Malformed varint16");
            return (uint16(uint8(data[offset + 1])) | (uint16(uint8(data[offset + 2])) << 8), offset + 3);
        }
        if (tag == 0xfe) {
            return (_readUint32LECalldata(data, offset + 1), offset + 5);
        }
        return (_readUint64LECalldata(data, offset + 1), offset + 9);
    }

    function _readUint32LE(bytes memory data, uint256 offset) internal pure returns (uint32 value) {
        require(offset + 4 <= data.length, "uint32 out of bounds");
        value =
            uint32(uint8(data[offset])) |
            (uint32(uint8(data[offset + 1])) << 8) |
            (uint32(uint8(data[offset + 2])) << 16) |
            (uint32(uint8(data[offset + 3])) << 24);
    }

    function _readUint32LECalldata(bytes calldata data, uint256 offset) internal pure returns (uint32 value) {
        require(offset + 4 <= data.length, "uint32 out of bounds");
        value =
            uint32(uint8(data[offset])) |
            (uint32(uint8(data[offset + 1])) << 8) |
            (uint32(uint8(data[offset + 2])) << 16) |
            (uint32(uint8(data[offset + 3])) << 24);
    }

    function _readUint64LE(bytes memory data, uint256 offset) internal pure returns (uint64 value) {
        require(offset + 8 <= data.length, "uint64 out of bounds");
        for (uint256 i = 0; i < 8; i++) {
            value |= uint64(uint8(data[offset + i])) << uint8(8 * i);
        }
    }

    function _readUint64LECalldata(bytes calldata data, uint256 offset) internal pure returns (uint64 value) {
        require(offset + 8 <= data.length, "uint64 out of bounds");
        for (uint256 i = 0; i < 8; i++) {
            value |= uint64(uint8(data[offset + i])) << uint8(8 * i);
        }
    }

    function _readBytes20(bytes memory data, uint256 offset) internal pure returns (bytes20 out) {
        require(offset + 20 <= data.length, "bytes20 out of bounds");
        assembly {
            out := mload(add(add(data, 0x20), offset))
        }
    }

    function _readBytes32(bytes memory data, uint256 offset) internal pure returns (bytes32 out) {
        require(offset + 32 <= data.length, "bytes32 out of bounds");
        assembly {
            out := mload(add(add(data, 0x20), offset))
        }
    }

    function _slice(bytes memory data, uint256 offset, uint256 len) internal pure returns (bytes memory out) {
        require(offset + len <= data.length, "slice out of bounds");
        out = new bytes(len);
        _copy(data, offset, out, 0, len);
    }

    function _copy(
        bytes memory src,
        uint256 srcOffset,
        bytes memory dst,
        uint256 dstOffset,
        uint256 len
    ) internal pure {
        for (uint256 i = 0; i < len; i++) {
            dst[dstOffset + i] = src[srcOffset + i];
        }
    }

    /// @dev Per the spec, the encAccount for Bitcoin is the 20-byte hash160 of
    /// the witness pubkey, left-aligned in a 32-byte slot followed by 12 zero
    /// bytes. Slicing the high 20 bytes recovers the hash.
    function _hash160FromAccount(bytes32 account) internal pure returns (bytes20) {
        return bytes20(account);
    }

    function _doubleSha256(bytes memory data) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(data)));
    }

    function _doubleSha25632(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(abi.encodePacked(left, right))));
    }
}
