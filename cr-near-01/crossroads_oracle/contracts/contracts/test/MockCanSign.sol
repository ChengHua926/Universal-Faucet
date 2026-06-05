// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal asset-policy stub for testing SigningCommittee in
/// isolation: canSign returns a settable flag (optionally only for an allowed
/// spender), mimicking CrossroadsAssetContract.canSign's signature.
contract MockCanSign {
    bool public allow = true;
    address public allowedSpender; // 0 = any

    function setAllow(bool a) external {
        allow = a;
    }

    function setAllowedSpender(address s) external {
        allowedSpender = s;
    }

    function canSign(address spender, bytes32, bytes calldata) external view returns (bool) {
        if (!allow) return false;
        if (allowedSpender != address(0) && spender != allowedSpender) return false;
        return true;
    }
}
