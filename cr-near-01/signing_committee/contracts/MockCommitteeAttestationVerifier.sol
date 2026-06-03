// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockCommitteeAttestationVerifier {
    function attestationDigest(
        address bootstrap,
        bytes32 memberId,
        address admin,
        string calldata publicEndpoint,
        bytes32 bootstrapPubKey,
        bytes32 clientAuthPubKey
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "HD_MPC_COMMITTEE_ATTEST_V1",
                bootstrap,
                memberId,
                admin,
                publicEndpoint,
                bootstrapPubKey,
                clientAuthPubKey
            )
        );
    }

    function verifyAttestation(
        address bootstrap,
        bytes32 memberId,
        address admin,
        string calldata publicEndpoint,
        bytes32 bootstrapPubKey,
        bytes32 clientAuthPubKey,
        bytes calldata attestation
    ) external pure returns (bool) {
        bytes32 digest = attestationDigest(bootstrap, memberId, admin, publicEndpoint, bootstrapPubKey, clientAuthPubKey);
        return _recover(digest, attestation) == admin;
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
