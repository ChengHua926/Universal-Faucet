// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EcdsaRecoveryHelper {
    function recoverBoth(bytes32 digest, bytes calldata signature) external pure returns (address rec27, address rec28) {
        (bytes32 r, bytes32 s) = splitSignature(signature);
        rec27 = ecrecover(digest, 27, r, s);
        rec28 = ecrecover(digest, 28, r, s);
    }

    function recoveryV(bytes32 digest, bytes calldata signature, address expected) external pure returns (uint8) {
        (bytes32 r, bytes32 s) = splitSignature(signature);
        if (ecrecover(digest, 27, r, s) == expected) {
            return 27;
        }
        if (ecrecover(digest, 28, r, s) == expected) {
            return 28;
        }
        revert("signature does not recover expected address");
    }

    function splitSignature(bytes calldata signature) internal pure returns (bytes32 r, bytes32 s) {
        require(signature.length == 64, "expected raw32 signature");
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
        }
    }
}
