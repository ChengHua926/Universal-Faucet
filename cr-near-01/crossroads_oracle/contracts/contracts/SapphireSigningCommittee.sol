// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Sapphire} from "@oasisprotocol/sapphire-contracts/contracts/Sapphire.sol";
import {EthereumUtils, SignatureRSV} from "@oasisprotocol/sapphire-contracts/contracts/EthereumUtils.sol";

interface IAssetPolicy {
    function canSign(address spender, bytes32 encAccount, bytes calldata txData) external view returns (bool);
}

/**
 * @title SapphireSigningCommittee
 * @notice Sapphire-native replacement for the off-chain MPC signing committee.
 *
 * On Oasis Sapphire a single confidential contract IS the committee:
 *   1. at deploy it generates a MASTER SECRET with the enclave's secure RNG and
 *      keeps it in confidential storage (it never leaves the enclave);
 *   2. it derives a per-(assetContract, accountId) secp256k1 key on the fly,
 *      deterministically, from that master secret;
 *   3. a *view* function `sign(...)` runs confidentially in the enclave and,
 *      only after (a) verifying the spender's request signature and (b) the
 *      target asset's `canSign` policy, signs the message with the derived key
 *      and returns a standard Ethereum (r,s,v) signature.
 *
 * Because `sign` is a view call, clients fetch a signature with a plain eth_call
 * (no gas, instant) while the master secret stays sealed in the TEE. This is the
 * exact role the NEAR-MPC cluster played, collapsed into one contract — no DKG,
 * no nodes, no threshold protocol.
 *
 * Workflow for an integrator:
 *   - pick an `accountId` label, read `encumberedAccount(asset, accountId)` to
 *     get the controlled address + `encAccount` id;
 *   - register `encAccount` on the asset and deposit to the address on the
 *     source chain;
 *   - to withdraw, build the unsigned tx as `message`, have the spender sign
 *     `requestHash(...)`, then eth_call `sign(...)` and assemble the raw signed
 *     tx from the returned (r,s,v).
 */
contract SapphireSigningCommittee {
    // Confidential on Sapphire (encrypted storage). NOT immutable — immutables
    // live in public bytecode and would leak the secret.
    bytes32 private _masterSecret;

    string public constant version = "crossroads-sapphire-committee-v1";

    constructor() {
        _masterSecret = bytes32(Sapphire.randomBytes(32, bytes(version)));
    }

    // --- derivation -----------------------------------------------------------

    function _derivePrivateKey(address asset, bytes32 accountId) internal view returns (bytes32) {
        // Deterministic per (committee, chain, asset, accountId). The secp256k1
        // secret key is this 32-byte value (overwhelmingly < curve order).
        return keccak256(abi.encode(_masterSecret, block.chainid, asset, accountId));
    }

    function _addressFor(bytes32 secretKey) internal view returns (address) {
        (bytes memory pubKey, ) = Sapphire.generateSigningKeyPair(
            Sapphire.SigningAlg.Secp256k1PrehashedKeccak256,
            abi.encodePacked(secretKey)
        );
        return EthereumUtils.k256PubkeyToEthereumAddress(pubKey);
    }

    /// @notice The encumbered account this committee controls for (asset, accountId).
    /// `addr` is the source-chain address (deposit here); `encAccount` is the id
    /// to register on the asset (`bytes32(uint160(addr))`).
    function encumberedAccount(address asset, bytes32 accountId)
        external
        view
        returns (address addr, bytes32 encAccount)
    {
        addr = _addressFor(_derivePrivateKey(asset, accountId));
        encAccount = bytes32(uint256(uint160(addr)));
    }

    // --- request authorization ------------------------------------------------

    /// @notice The digest the spender must sign (EIP-191) to authorize a signing
    /// request. Binds the committee, chain, asset, accountId and the exact message.
    function requestHash(address asset, bytes32 accountId, bytes calldata message)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(this), block.chainid, asset, accountId, keccak256(message)));
    }

    // --- the committee: confidential, policy-gated signer ---------------------

    /// @notice Verify the spender's authorization + the asset's `canSign` policy,
    /// then sign `keccak256(message)` with the derived key. Returns the encumbered
    /// address and an Ethereum (r,s,v) signature ready to assemble a raw signed tx.
    /// @dev VIEW: runs confidentially in the enclave; the master secret stays sealed.
    function sign(
        address asset,
        bytes32 accountId,
        bytes calldata message,
        bytes calldata spenderSig
    ) external view returns (address encAddr, bytes32 r, bytes32 s, uint8 v) {
        // (a) authenticate the spender from their EIP-191 signature over the request.
        bytes32 digest = _toEthSignedMessageHash(requestHash(asset, accountId, message));
        address spender = _recover(digest, spenderSig);

        // derive the key + the encumbered identity it controls.
        bytes32 sk = _derivePrivateKey(asset, accountId);
        encAddr = _addressFor(sk);
        bytes32 encAccount = bytes32(uint256(uint160(encAddr)));

        // (b) honor the target asset's policy.
        require(IAssetPolicy(asset).canSign(spender, encAccount, message), "canSign: not eligible");

        // (c) sign keccak256(message) with the derived key (Ethereum r,s,v).
        SignatureRSV memory rsv = EthereumUtils.sign(encAddr, sk, keccak256(message));
        return (encAddr, rsv.r, rsv.s, uint8(rsv.v));
    }

    // --- inline crypto helpers (avoid OZ utils that need the Cancun mcopy op) --

    function _toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 0x20))
            v := byte(0, calldataload(add(sig.offset, 0x40)))
        }
        if (v < 27) v += 27;
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad spender signature");
        return signer;
    }
}
