// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title SolanaTransactionLib
 * @notice Stateless parser/codec helpers for Solana v0 transactions.
 *
 * The library deliberately supports only static account keys. Versioned v0
 * messages may contain address table lookups, and this parser validates their
 * serialization, but any instruction account index that resolves into a lookup
 * table account is rejected. Crossroads deposit/withdrawal transactions are
 * expected to include all touched accounts as static keys.
 */
library SolanaTransactionLib {
    uint256 internal constant MAX_SHORTVEC_BYTES = 5;
    uint8 internal constant SOLANA_VERSION_V0_PREFIX = 0x80;

    uint32 internal constant SYSTEM_CREATE_ACCOUNT = 0;
    uint32 internal constant SYSTEM_TRANSFER = 2;
    uint32 internal constant SYSTEM_ADVANCE_NONCE_ACCOUNT = 4;
    uint32 internal constant SYSTEM_INITIALIZE_NONCE_ACCOUNT = 6;
    uint64 internal constant NONCE_ACCOUNT_SPACE = 80;
    uint256 internal constant CROSSROADS_ADDRESS_HEX_CHARS = 40;
    uint256 internal constant CROSSROADS_ADDRESS_HEX_CHARS_WITH_PREFIX = 42;

    /// @dev Solana ComputeBudget program defaults.
    /// `DEFAULT_COMPUTE_UNIT_LIMIT` is the per-transaction CU limit applied
    /// when no `SetComputeUnitLimit` instruction is present.
    uint32 internal constant DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;
    uint8 internal constant CB_SET_COMPUTE_UNIT_LIMIT = 0x02;
    uint8 internal constant CB_SET_COMPUTE_UNIT_PRICE = 0x03;
    uint256 internal constant MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;

    bytes32 internal constant SYSTEM_PROGRAM_ID = bytes32(0);
    bytes32 internal constant MEMO_PROGRAM_ID =
        0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d;
    bytes32 internal constant SYSVAR_RECENT_BLOCKHASHES_ID =
        0x06a7d517192c568ee08a845f73d29788cf035c3145b21ab344d8062ea9400000;
    bytes32 internal constant SYSVAR_RENT_ID =
        0x06a7d517192c5c51218cc94c3d4af17f58daee089ba1fd44e3dbd98a00000000;
    bytes32 internal constant COMPUTE_BUDGET_PROGRAM_ID =
        0x0306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000;

    struct MessageHeaderView {
        uint8 numRequiredSignatures;
        uint8 numReadonlySignedAccounts;
        uint8 numReadonlyUnsignedAccounts;
        uint256 accountKeysLength;
        uint256 accountKeysOffset;
        bytes32 recentBlockhash;
        uint256 instructionsLength;
        uint256 instructionsOffset;
        uint256 addressTableLookupsLength;
        uint256 addressTableLookupsOffset;
        uint256 endOffset;
    }

    struct InstructionView {
        uint8 programIdIndex;
        uint256 accountsLength;
        uint256 accountsOffset;
        uint256 dataLength;
        uint256 dataOffset;
        uint256 endOffset;
    }

    struct SystemTransferView {
        bytes32 from;
        bytes32 to;
        uint64 lamports;
    }

    struct NonceInitializationView {
        bytes32 payer;
        bytes32 nonceAccount;
        bytes32 authority;
        uint64 lamports;
        uint64 space;
    }

    function getTransactionHash(bytes calldata signedTx) external pure returns (bytes32 txHash) {
        (uint256 count, uint256 sigOffset, ) = signatureSection(signedTx);
        require(count > 0, "Missing primary signature");
        txHash = keccak256(signedTx[sigOffset:sigOffset + 64]);
    }

    function getTransactionWireHash(bytes calldata signedTx) external pure returns (bytes32) {
        return keccak256(signedTx);
    }

    function getMessageHash(bytes calldata signedOrUnsignedTx) external pure returns (bytes32) {
        (uint256 messageOffset, uint256 messageEnd) = messageBounds(signedOrUnsignedTx);
        return sha256(signedOrUnsignedTx[messageOffset:messageEnd]);
    }

    function getPrimarySignature(bytes calldata signedTx) external pure returns (bytes memory) {
        (uint256 count, uint256 sigOffset, ) = signatureSection(signedTx);
        require(count > 0, "Missing primary signature");
        return signedTx[sigOffset:sigOffset + 64];
    }

    function decodeV0MessageHeader(bytes calldata signedOrUnsignedTx) external pure returns (MessageHeaderView memory) {
        (uint256 messageOffset, ) = messageBounds(signedOrUnsignedTx);
        return parseV0Message(signedOrUnsignedTx, messageOffset);
    }

    function decodeInstruction(
        bytes calldata signedOrUnsignedTx,
        uint256 instructionIndex
    ) external pure returns (InstructionView memory ix, bytes32 programId, bytes memory accounts, bytes memory data) {
        (uint256 messageOffset, ) = messageBounds(signedOrUnsignedTx);
        MessageHeaderView memory msgView = parseV0Message(signedOrUnsignedTx, messageOffset);
        require(instructionIndex < msgView.instructionsLength, "Instruction index out of bounds");
        uint256 offset = msgView.instructionsOffset;
        for (uint256 i = 0; i <= instructionIndex; i++) {
            ix = parseInstruction(signedOrUnsignedTx, offset);
            offset = ix.endOffset;
        }
        programId = accountKey(signedOrUnsignedTx, msgView, ix.programIdIndex);
        accounts = signedOrUnsignedTx[ix.accountsOffset:ix.accountsOffset + ix.accountsLength];
        data = signedOrUnsignedTx[ix.dataOffset:ix.dataOffset + ix.dataLength];
    }

    function extractMemoBoundTransfer(
        bytes calldata txData,
        bool requireFrom,
        bytes32 requiredFrom
    ) external pure returns (address memoAddress, bytes32 destination, uint256 amount) {
        (uint256 messageOffset, ) = messageBounds(txData);
        MessageHeaderView memory msgView = parseV0Message(txData, messageOffset);
        memoAddress = extractCrossroadsMemo(txData, msgView);
        (destination, amount) = extractTransferToDestination(txData, msgView, requireFrom, requiredFrom);
    }

    struct ComputeBudgetView {
        uint32 cuLimit;
        uint64 cuPrice;
        uint256 endOffset;
    }

    function decodeWithdrawal(
        bytes calldata txData,
        bytes32 encAccount,
        bytes32 nonceAccount,
        bool enforceNonce,
        bytes32 requiredNonce,
        uint256 baseFeePerSignature
    ) external pure returns (address spender, uint256 amountSpent) {
        require(nonceAccount != bytes32(0), "Nonce account not configured");
        (uint256 messageOffset, ) = messageBounds(txData);
        MessageHeaderView memory msgView = parseV0Message(txData, messageOffset);
        // The canonical 3-instruction shape (advanceNonce + transfer + memo)
        // may optionally be preceded by 1 or 2 ComputeBudgetProgram
        // instructions (SetComputeUnitLimit / SetComputeUnitPrice).
        require(
            msgView.instructionsLength >= 3 && msgView.instructionsLength <= 5,
            "Withdrawal must have 3-5 instructions"
        );
        if (enforceNonce) {
            require(msgView.recentBlockhash == requiredNonce, "Durable nonce invalid");
        }
        require(isRequiredSigner(txData, msgView, encAccount), "Primary account must sign");

        (uint256 transferLamports, address decodedSpender, uint256 priorityFee) =
            _decodeWithdrawalBody(txData, msgView, encAccount, nonceAccount);
        spender = decodedSpender;

        // Fold network fee and priority fee into amountSpent so the
        // spender's spending balance is debited by the full encumbered-pool
        // drain (transfer + base fee + priority fee).
        amountSpent =
            transferLamports +
            uint256(msgView.numRequiredSignatures) * baseFeePerSignature +
            priorityFee;
    }

    function _decodeWithdrawalBody(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        bytes32 encAccount,
        bytes32 nonceAccount
    ) internal pure returns (uint256 transferLamports, address spender, uint256 priorityFee) {
        ComputeBudgetView memory cb = parseComputeBudgetPrefix(
            txData,
            msgView,
            msgView.instructionsLength - 3
        );

        // Priority fee is ceilDiv(cuLimit * cuPrice, MICRO_LAMPORTS_PER_LAMPORT)
        // since the price is in micro-lamports per CU.
        uint256 priorityFeeMicro = uint256(cb.cuLimit) * uint256(cb.cuPrice);
        priorityFee = (priorityFeeMicro + MICRO_LAMPORTS_PER_LAMPORT - 1) /
            MICRO_LAMPORTS_PER_LAMPORT;

        InstructionView memory advanceIx = parseInstruction(txData, cb.endOffset);
        requireAdvanceNonce(txData, msgView, advanceIx, encAccount, nonceAccount);

        InstructionView memory transferIx = parseInstruction(txData, advanceIx.endOffset);
        SystemTransferView memory transfer = decodeSystemTransfer(txData, msgView, transferIx);
        require(transfer.from == encAccount, "Withdrawal source mismatch");
        require(transfer.lamports > 0, "Zero withdrawal");
        transferLamports = uint256(transfer.lamports);

        InstructionView memory memoIx = parseInstruction(txData, transferIx.endOffset);
        require(accountKey(txData, msgView, memoIx.programIdIndex) == MEMO_PROGRAM_ID, "Memo program required");
        require(memoIx.accountsLength == 0, "Memo accounts unsupported");
        spender = decodeCrossroadsMemoAddress(txData, memoIx.dataOffset, memoIx.dataLength);
    }

    function parseComputeBudgetPrefix(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        uint256 cbCount
    ) internal pure returns (ComputeBudgetView memory cb) {
        cb.cuLimit = DEFAULT_COMPUTE_UNIT_LIMIT;
        cb.cuPrice = 0;
        cb.endOffset = msgView.instructionsOffset;
        bool sawLimit;
        bool sawPrice;
        for (uint256 i = 0; i < cbCount; i++) {
            InstructionView memory cbIx = parseInstruction(txData, cb.endOffset);
            require(
                accountKey(txData, msgView, cbIx.programIdIndex) == COMPUTE_BUDGET_PROGRAM_ID,
                "Expected ComputeBudget instruction"
            );
            require(cbIx.accountsLength == 0, "ComputeBudget accounts unsupported");
            require(cbIx.dataLength >= 1, "Malformed ComputeBudget data");
            uint8 disc = uint8(txData[cbIx.dataOffset]);
            if (disc == CB_SET_COMPUTE_UNIT_LIMIT) {
                require(!sawLimit, "Duplicate SetComputeUnitLimit");
                require(cbIx.dataLength == 5, "Malformed SetComputeUnitLimit");
                cb.cuLimit = readU32LE(txData, cbIx.dataOffset + 1);
                sawLimit = true;
            } else if (disc == CB_SET_COMPUTE_UNIT_PRICE) {
                require(!sawPrice, "Duplicate SetComputeUnitPrice");
                require(cbIx.dataLength == 9, "Malformed SetComputeUnitPrice");
                cb.cuPrice = readU64LE(txData, cbIx.dataOffset + 1);
                sawPrice = true;
            } else {
                revert("Unsupported ComputeBudget instruction");
            }
            cb.endOffset = cbIx.endOffset;
        }
    }

    function decodeNonceInitialization(bytes calldata txData) external pure returns (NonceInitializationView memory init) {
        (uint256 messageOffset, ) = messageBounds(txData);
        MessageHeaderView memory msgView = parseV0Message(txData, messageOffset);
        require(msgView.instructionsLength >= 2, "Nonce init needs two instructions");

        InstructionView memory createIx = parseInstruction(txData, msgView.instructionsOffset);
        require(accountKey(txData, msgView, createIx.programIdIndex) == SYSTEM_PROGRAM_ID, "Create must use System Program");
        require(createIx.accountsLength >= 2, "Malformed CreateAccount accounts");
        require(createIx.dataLength == 52, "Malformed CreateAccount data");
        require(readU32LE(txData, createIx.dataOffset) == SYSTEM_CREATE_ACCOUNT, "Expected CreateAccount");
        init.payer = instructionAccountKey(txData, msgView, createIx, 0);
        init.nonceAccount = instructionAccountKey(txData, msgView, createIx, 1);
        init.lamports = readU64LE(txData, createIx.dataOffset + 4);
        init.space = readU64LE(txData, createIx.dataOffset + 12);
        bytes32 owner = bytes32(txData[createIx.dataOffset + 20:createIx.dataOffset + 52]);
        require(owner == SYSTEM_PROGRAM_ID, "Nonce account owner must be System Program");
        require(init.space >= NONCE_ACCOUNT_SPACE, "Nonce account too small");

        InstructionView memory initIx = parseInstruction(txData, createIx.endOffset);
        require(accountKey(txData, msgView, initIx.programIdIndex) == SYSTEM_PROGRAM_ID, "Init must use System Program");
        require(initIx.accountsLength >= 3, "Malformed InitializeNonceAccount accounts");
        require(instructionAccountKey(txData, msgView, initIx, 0) == init.nonceAccount, "Init nonce mismatch");
        require(
            instructionAccountKey(txData, msgView, initIx, 1) == SYSVAR_RECENT_BLOCKHASHES_ID,
            "Init recent sysvar mismatch"
        );
        require(instructionAccountKey(txData, msgView, initIx, 2) == SYSVAR_RENT_ID, "Init rent sysvar mismatch");
        require(initIx.dataLength == 36, "Malformed InitializeNonceAccount data");
        require(readU32LE(txData, initIx.dataOffset) == SYSTEM_INITIALIZE_NONCE_ACCOUNT, "Expected InitializeNonceAccount");
        init.authority = bytes32(txData[initIx.dataOffset + 4:initIx.dataOffset + 36]);
        require(init.authority != bytes32(0), "Nonce authority required");
        require(init.authority != init.nonceAccount, "Authority must be primary account");
    }

    function extractCrossroadsMemo(
        bytes calldata txData,
        MessageHeaderView memory msgView
    ) internal pure returns (address memoAddress) {
        uint256 offset = msgView.instructionsOffset;
        for (uint256 i = 0; i < msgView.instructionsLength; i++) {
            InstructionView memory ixView = parseInstruction(txData, offset);
            if (isMemoInstruction(txData, msgView, ixView)) {
                return decodeCrossroadsMemoAddress(txData, ixView.dataOffset, ixView.dataLength);
            }
            offset = ixView.endOffset;
        }
        revert("Missing Crossroads memo");
    }

    function extractTransferToDestination(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        bool requireFrom,
        bytes32 requiredFrom
    ) internal pure returns (bytes32 destination, uint256 amount) {
        uint256 offset = msgView.instructionsOffset;
        bool foundTransfer;
        for (uint256 i = 0; i < msgView.instructionsLength; i++) {
            InstructionView memory ixView = parseInstruction(txData, offset);
            (bool ok, bytes32 from, bytes32 to, uint64 lamports) = tryDecodeSystemTransfer(txData, msgView, ixView);
            if (ok && (!requireFrom || from == requiredFrom)) {
                if (!foundTransfer) {
                    destination = to;
                    foundTransfer = true;
                }
                if (to == destination) {
                    amount += lamports;
                }
            }
            offset = ixView.endOffset;
        }
        require(foundTransfer && amount > 0, "Missing SOL transfer");
    }

    function isMemoInstruction(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        InstructionView memory ixView
    ) internal pure returns (bool) {
        return accountKey(txData, msgView, ixView.programIdIndex) == MEMO_PROGRAM_ID &&
            (ixView.dataLength == CROSSROADS_ADDRESS_HEX_CHARS ||
                ixView.dataLength == CROSSROADS_ADDRESS_HEX_CHARS_WITH_PREFIX);
    }

    function decodeCrossroadsMemoAddress(
        bytes calldata txData,
        uint256 offset,
        uint256 length
    ) internal pure returns (address memoAddress) {
        uint256 cursor = offset;
        if (length == CROSSROADS_ADDRESS_HEX_CHARS_WITH_PREFIX) {
            require(uint8(txData[offset]) == uint8(bytes1("0")), "Memo 0x prefix invalid");
            uint8 prefix = uint8(txData[offset + 1]);
            require(prefix == uint8(bytes1("x")) || prefix == uint8(bytes1("X")), "Memo 0x prefix invalid");
            cursor += 2;
        } else {
            require(length == CROSSROADS_ADDRESS_HEX_CHARS, "Memo must be hex-encoded address");
        }

        uint160 value;
        for (uint256 i = 0; i < CROSSROADS_ADDRESS_HEX_CHARS; i++) {
            value = (value << 4) | uint160(hexNibble(uint8(txData[cursor + i])));
        }
        memoAddress = address(value);
    }

    function hexNibble(uint8 char) internal pure returns (uint8) {
        if (char >= uint8(bytes1("0")) && char <= uint8(bytes1("9"))) {
            return char - uint8(bytes1("0"));
        }
        if (char >= uint8(bytes1("a")) && char <= uint8(bytes1("f"))) {
            return 10 + char - uint8(bytes1("a"));
        }
        if (char >= uint8(bytes1("A")) && char <= uint8(bytes1("F"))) {
            return 10 + char - uint8(bytes1("A"));
        }
        revert("Memo contains non-hex character");
    }

    function tryDecodeSystemTransfer(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        InstructionView memory ixView
    ) internal pure returns (bool ok, bytes32 from, bytes32 to, uint64 lamports) {
        if (accountKey(txData, msgView, ixView.programIdIndex) != SYSTEM_PROGRAM_ID) {
            return (false, bytes32(0), bytes32(0), 0);
        }
        if (ixView.dataLength != 12 || readU32LE(txData, ixView.dataOffset) != SYSTEM_TRANSFER) {
            return (false, bytes32(0), bytes32(0), 0);
        }
        require(ixView.accountsLength >= 2, "Malformed transfer accounts");
        from = instructionAccountKey(txData, msgView, ixView, 0);
        to = instructionAccountKey(txData, msgView, ixView, 1);
        lamports = readU64LE(txData, ixView.dataOffset + 4);
        ok = true;
    }

    function requireAdvanceNonce(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        InstructionView memory ix,
        bytes32 encAccount,
        bytes32 nonceAccount
    ) internal pure {
        require(accountKey(txData, msgView, ix.programIdIndex) == SYSTEM_PROGRAM_ID, "Advance nonce must use System Program");
        require(ix.dataLength == 4, "Malformed AdvanceNonceAccount data");
        require(readU32LE(txData, ix.dataOffset) == SYSTEM_ADVANCE_NONCE_ACCOUNT, "Expected AdvanceNonceAccount");
        require(ix.accountsLength >= 3, "Malformed AdvanceNonceAccount accounts");
        require(instructionAccountKey(txData, msgView, ix, 0) == nonceAccount, "Nonce account mismatch");
        require(
            instructionAccountKey(txData, msgView, ix, 1) == SYSVAR_RECENT_BLOCKHASHES_ID,
            "Recent blockhash sysvar mismatch"
        );
        require(instructionAccountKey(txData, msgView, ix, 2) == encAccount, "Nonce authority mismatch");
    }

    function decodeSystemTransfer(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        InstructionView memory ix
    ) internal pure returns (SystemTransferView memory transfer) {
        require(accountKey(txData, msgView, ix.programIdIndex) == SYSTEM_PROGRAM_ID, "Expected System Program");
        require(ix.accountsLength >= 2, "Malformed transfer accounts");
        require(ix.dataLength == 12, "Malformed transfer data");
        require(readU32LE(txData, ix.dataOffset) == SYSTEM_TRANSFER, "Expected Transfer");
        transfer.from = instructionAccountKey(txData, msgView, ix, 0);
        transfer.to = instructionAccountKey(txData, msgView, ix, 1);
        transfer.lamports = readU64LE(txData, ix.dataOffset + 4);
    }

    function messageBounds(bytes calldata data) internal pure returns (uint256 messageOffset, uint256 messageEnd) {
        if (data.length > 0 && uint8(data[0]) == SOLANA_VERSION_V0_PREFIX) {
            messageOffset = 0;
            MessageHeaderView memory msgView = parseV0Message(data, messageOffset);
            messageEnd = msgView.endOffset;
            require(messageEnd == data.length, "Trailing message bytes");
            return (messageOffset, messageEnd);
        }
        (, , messageOffset) = signatureSection(data);
        MessageHeaderView memory txMsgView = parseV0Message(data, messageOffset);
        messageEnd = txMsgView.endOffset;
        require(messageEnd == data.length, "Trailing transaction bytes");
    }

    function signatureSection(bytes calldata signedTx) internal pure returns (uint256 count, uint256 sigOffset, uint256 messageOffset) {
        (count, sigOffset) = readShortVec(signedTx, 0);
        require(count <= type(uint16).max, "Too many signatures");
        require(sigOffset + count * 64 <= signedTx.length, "Malformed signatures");
        messageOffset = sigOffset + count * 64;
    }

    function parseV0Message(bytes calldata data, uint256 offset) internal pure returns (MessageHeaderView memory msgView) {
        require(offset + 4 <= data.length, "Malformed v0 message");
        require(uint8(data[offset]) == SOLANA_VERSION_V0_PREFIX, "Unsupported Solana transaction version");
        msgView.numRequiredSignatures = uint8(data[offset + 1]);
        msgView.numReadonlySignedAccounts = uint8(data[offset + 2]);
        msgView.numReadonlyUnsignedAccounts = uint8(data[offset + 3]);
        uint256 cursor = offset + 4;
        (msgView.accountKeysLength, msgView.accountKeysOffset) = readShortVec(data, cursor);
        require(msgView.accountKeysLength > 0, "Missing account keys");
        require(msgView.accountKeysLength <= 256, "Too many static account keys");
        cursor = msgView.accountKeysOffset + msgView.accountKeysLength * 32;
        require(cursor + 32 <= data.length, "Malformed account keys");
        msgView.recentBlockhash = bytes32(data[cursor:cursor + 32]);
        cursor += 32;
        (msgView.instructionsLength, msgView.instructionsOffset) = readShortVec(data, cursor);
        cursor = msgView.instructionsOffset;
        for (uint256 i = 0; i < msgView.instructionsLength; i++) {
            InstructionView memory ix = parseInstruction(data, cursor);
            cursor = ix.endOffset;
        }
        (msgView.addressTableLookupsLength, msgView.addressTableLookupsOffset) = readShortVec(data, cursor);
        cursor = msgView.addressTableLookupsOffset;
        for (uint256 i = 0; i < msgView.addressTableLookupsLength; i++) {
            require(cursor + 32 <= data.length, "Malformed lookup table account");
            cursor += 32;
            uint256 writableLength;
            (writableLength, cursor) = readShortVec(data, cursor);
            require(cursor + writableLength <= data.length, "Malformed writable lookup indexes");
            cursor += writableLength;
            uint256 readonlyLength;
            (readonlyLength, cursor) = readShortVec(data, cursor);
            require(cursor + readonlyLength <= data.length, "Malformed readonly lookup indexes");
            cursor += readonlyLength;
        }
        msgView.endOffset = cursor;
    }

    function parseInstruction(bytes calldata data, uint256 offset) internal pure returns (InstructionView memory ix) {
        require(offset < data.length, "Malformed instruction");
        ix.programIdIndex = uint8(data[offset]);
        uint256 cursor = offset + 1;
        (ix.accountsLength, ix.accountsOffset) = readShortVec(data, cursor);
        require(ix.accountsLength <= 256, "Too many instruction accounts");
        cursor = ix.accountsOffset + ix.accountsLength;
        require(cursor <= data.length, "Malformed instruction accounts");
        (ix.dataLength, ix.dataOffset) = readShortVec(data, cursor);
        ix.endOffset = ix.dataOffset + ix.dataLength;
        require(ix.endOffset <= data.length, "Malformed instruction data");
    }

    function instructionAccountKey(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        InstructionView memory ix,
        uint256 instructionAccountOffset
    ) internal pure returns (bytes32) {
        require(instructionAccountOffset < ix.accountsLength, "Instruction account out of bounds");
        uint8 accountIndex = uint8(txData[ix.accountsOffset + instructionAccountOffset]);
        return accountKey(txData, msgView, accountIndex);
    }

    function accountKey(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        uint256 index
    ) internal pure returns (bytes32) {
        require(index < msgView.accountKeysLength, "Address lookup account resolution unsupported");
        uint256 keyOffset = msgView.accountKeysOffset + index * 32;
        return bytes32(txData[keyOffset:keyOffset + 32]);
    }

    function isRequiredSigner(
        bytes calldata txData,
        MessageHeaderView memory msgView,
        bytes32 account
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < msgView.numRequiredSignatures && i < msgView.accountKeysLength; i++) {
            if (accountKey(txData, msgView, i) == account) {
                return true;
            }
        }
        return false;
    }

    function readShortVec(bytes calldata data, uint256 offset) internal pure returns (uint256 value, uint256 next) {
        next = offset;
        uint256 shift;
        for (uint256 i = 0; i < MAX_SHORTVEC_BYTES; i++) {
            require(next < data.length, "Malformed shortvec");
            uint8 b = uint8(data[next]);
            next += 1;
            value |= uint256(b & 0x7f) << shift;
            if ((b & 0x80) == 0) {
                return (value, next);
            }
            shift += 7;
        }
        revert("Shortvec too long");
    }

    function readU32LE(bytes calldata data, uint256 offset) internal pure returns (uint32) {
        require(offset + 4 <= data.length, "u32 out of bounds");
        return uint32(uint8(data[offset])) |
            (uint32(uint8(data[offset + 1])) << 8) |
            (uint32(uint8(data[offset + 2])) << 16) |
            (uint32(uint8(data[offset + 3])) << 24);
    }

    function readU64LE(bytes calldata data, uint256 offset) internal pure returns (uint64) {
        require(offset + 8 <= data.length, "u64 out of bounds");
        return uint64(uint8(data[offset])) |
            (uint64(uint8(data[offset + 1])) << 8) |
            (uint64(uint8(data[offset + 2])) << 16) |
            (uint64(uint8(data[offset + 3])) << 24) |
            (uint64(uint8(data[offset + 4])) << 32) |
            (uint64(uint8(data[offset + 5])) << 40) |
            (uint64(uint8(data[offset + 6])) << 48) |
            (uint64(uint8(data[offset + 7])) << 56);
    }
}
