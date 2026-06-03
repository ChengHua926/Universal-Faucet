// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockAccountScopedCanSign {
    uint8 public constant SCHEME_ECDSA_SECP256K1 = 1;
    uint8 public constant SCHEME_ED25519 = 2;

    uint8 private _signatureScheme;
    mapping(address => mapping(bytes32 => bool)) public allowedAccount;

    constructor(uint8 defaultSignatureScheme) {
        _setSignatureScheme(defaultSignatureScheme);
    }

    function setSignatureScheme(uint8 scheme) external {
        _setSignatureScheme(scheme);
    }

    function setAllowed(address spender, bytes32 encAccount, bool allowed) external {
        allowedAccount[spender][encAccount] = allowed;
    }

    function canSign(address spender, bytes32 encAccount, bytes calldata) external view returns (bool) {
        return allowedAccount[spender][encAccount];
    }

    function signatureScheme() external view returns (uint8) {
        return _signatureScheme;
    }

    function _setSignatureScheme(uint8 scheme) internal {
        require(scheme == SCHEME_ECDSA_SECP256K1 || scheme == SCHEME_ED25519, "unsupported scheme");
        _signatureScheme = scheme;
    }
}
