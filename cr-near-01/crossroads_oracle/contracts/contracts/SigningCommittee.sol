// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sapphire} from "@oasisprotocol/sapphire-contracts/contracts/Sapphire.sol";
import {EthereumUtils} from "@oasisprotocol/sapphire-contracts/contracts/EthereumUtils.sol";

/// @notice The asset contract a SigningCommittee serves. The committee asks the
/// asset whether a particular `(spender, encAccount, txData)` combo is allowed to
/// sign. Crossroads asset contracts implement this directly (see
/// `AssetContract.canSign`). `encAccount` here is the asset's encumbered-account
/// id, which for the EVM bridge is `bytes32(uint160(signerAddress))`.
interface ICrossroadsAsset {
    function canSign(address spender, bytes32 encAccount, bytes calldata txData)
        external
        view
        returns (bool);
}

/// @title SigningCommittee
/// @notice A single-contract replacement for the entire Crossroads
/// signing-committee multisig. Lives on Sapphire so its storage and computation
/// are confidential, deterministically derives a distinct keypair per
/// `(asset, account label, algorithm)` from a confidential root seed, and emits
/// signatures only when the underlying asset contract approves via `canSign`.
///
/// ===========================================================================
/// CHANGES FROM THE ORIGINAL `SigningCommittee` (James's pasted version)
/// ---------------------------------------------------------------------------
/// This contract keeps James's interface and EIP-712 design intact. The only
/// differences — each required for it to compile under Sapphire and to actually
/// drive the Crossroads EVM asset — are the three tagged below (`grep CHANGE`)
/// plus one added view (`assetAccount`, `grep ADDED`). All are live-verified:
/// the isolation test passes 5/5 and a real Sepolia withdrawal round-trip
/// (deposit -> lock -> committee-sign -> finalize, epoch 0->1) succeeded.
///
///   CHANGE 1 — EIP-712 / ECDSA are INLINED, not imported from OpenZeppelin.
///     OZ's `EIP712 -> MessageHashUtils -> Strings -> Bytes` chain uses the
///     Cancun `mcopy` opcode, which fails to compile under Sapphire's required
///     `paris` evmVersion. The inlined `_domainSeparator()` + `_recover()`
///     produce a byte-identical digest/recovery — proven by the isolation test
///     (on-chain `requestDigest` == the client's EIP-712 typed-data hash).
///
///   CHANGE 2 — `Sapphire.sign` ARGUMENT ORDER (this was the one real bug in
///     the original). For `Secp256k1PrehashedKeccak256` the 32-byte digest goes
///     in the `contextOrHash` (3rd) argument and `message` (4th) is empty — per
///     the Sapphire.sol docs and `EthereumUtils.sign`. The original passed them
///     swapped, which signs the wrong bytes / reverts.
///
///   CHANGE 3 — `canSign` is fed the ADDRESS-DERIVED encumbered-account id
///     `bytes32(uint160(signer))`, not the raw `encAccount` derivation label.
///     The Crossroads asset derives the encumbered-account id from the on-chain
///     signer address (`EthereumBridgeOracle._accountIdFromAddress`), so the
///     deposit destination, `lockWithdrawal`, `canSign`, and `finalizeWithdrawal`
///     all key on that address id. Passing the raw label would make `canSign`
///     reject every real withdrawal (the label cannot equal a hash of the
///     address derived from it — a circular dependency). `encAccount` is thus
///     the derivation namespace + EIP-712 replay binding; the asset-facing id is
///     exposed via `assetAccount(...)` (ADDED — not in the original).
/// ===========================================================================
///
/// Design notes:
///  * `_rootSeed` is set once in the constructor and never read outside this
///    contract. Sapphire's confidential storage means no node operator can read
///    it post-deploy.
///  * Key derivation is deterministic — same `(asset, encAccount, alg)` always
///    resolves to the same keypair. `signerAddress(...)` lets an Ethereum-side
///    oracle pin the expected signer.
///  * The signing entrypoint is a *view*: it reads confidential state and
///    returns bytes without persisting anything, so every call is gas-free over
///    an `eth_call` and callers authenticate to the *asset* (via `canSign`),
///    not to us — the committee is policy-neutral.
///  * v1 supports secp256k1 with prehashed Keccak256 (Ethereum-style). Adding
///    algorithms is a matter of accepting a new `algId` and routing to a
///    different Sapphire precompile.
contract SigningCommittee {
    /// Algorithm id mirroring Sapphire's `SigningAlg`. Kept as `uint256` so the
    /// committee can route to future precompile algorithms without a type
    /// change; v1 only implements this one.
    uint256 public constant ALG_SECP256K1_KECCAK256 = 1;

    /// Confidential root seed. HKDF-like input to derive per-(asset, account,
    /// alg) private keys. Confidential on Sapphire (encrypted storage).
    bytes32 private _rootSeed;

    /// Domain baked into every key derivation. Bumping it rotates every key the
    /// committee serves; treat as breaking.
    bytes32 private constant DOMAIN = keccak256("SigningCommittee/v1");

    // --- CHANGE 1: inlined EIP-712 (paris-safe; identical digest to OZ) ------
    // Replaces `contract ... is EIP712` + OZ `_hashTypedDataV4`. See header.

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _HASHED_NAME = keccak256("SigningCommittee");
    bytes32 private constant _HASHED_VERSION = keccak256("1");

    /// EIP-712 type of the request a withdrawer signs to authorize the committee
    /// to sign `txData` for `encAccount` on `asset`. The chain and this
    /// committee's address are bound by the EIP-712 domain separator, so they
    /// need not appear in the struct.
    bytes32 private constant SIGN_REQUEST_TYPEHASH =
        keccak256("SignRequest(address asset,bytes32 encAccount,bytes txData)");

    /// @param seed The root seed. Pass `bytes32(0)` to have the enclave generate
    /// one with secure randomness — known only to this contract after deploy.
    ///
    /// WARNING: passing a non-zero `seed` makes the deployer a permanent
    /// backdoor — whoever knows the seed can derive every private key this
    /// committee will ever control. Trustless deployments MUST pass `bytes32(0)`.
    constructor(bytes32 seed) {
        if (seed == bytes32(0)) {
            bytes memory r = Sapphire.randomBytes(32, "SigningCommittee/init");
            assembly {
                seed := mload(add(r, 32))
            }
        }
        _rootSeed = seed;
    }

    // --- key derivation ------------------------------------------------------

    /// Derive `(privateKey, publicKey)` for `(asset, encAccount, alg)`. Internal;
    /// exposed via `publicKey()`/`signerAddress()` and used by `sign()`.
    function _derive(address asset, bytes32 encAccount, uint256 algId)
        internal
        view
        returns (bytes memory privateKey, bytes memory pubKey)
    {
        require(algId == ALG_SECP256K1_KECCAK256, "alg unsupported");
        // Hash the input material to a fixed 32-byte seed. Deterministic —
        // keccak256 is a function — and portable across Sapphire builds that
        // restrict the seed length.
        bytes32 seedHash = keccak256(
            abi.encodePacked(DOMAIN, _rootSeed, algId, asset, encAccount)
        );
        (pubKey, privateKey) = Sapphire.generateSigningKeyPair(
            Sapphire.SigningAlg.Secp256k1PrehashedKeccak256,
            abi.encodePacked(seedHash)
        );
    }

    /// Algorithm-native public key for `(asset, encAccount, alg)` (for secp256k1
    /// the 33-byte compressed serialization). Most callers want
    /// `signerAddress(...)`.
    function publicKey(address asset, bytes32 encAccount, uint256 algId)
        external
        view
        returns (bytes memory)
    {
        (, bytes memory pk) = _derive(asset, encAccount, algId);
        return pk;
    }

    /// Ethereum address of the signer for `(asset, encAccount, alg)` — what an
    /// Ethereum-side oracle pins as the expected signer. Computed on-chain from
    /// the compressed pubkey; free over an `eth_call`.
    function signerAddress(address asset, bytes32 encAccount, uint256 algId)
        public
        view
        returns (address)
    {
        (, bytes memory pk) = _derive(asset, encAccount, algId);
        return EthereumUtils.k256PubkeyToEthereumAddress(pk);
    }

    /// ADDED (not in the original): the Crossroads asset-facing encumbered-account
    /// id for this derivation. The asset keys deposits/locks/withdrawals on
    /// `bytes32(uint160(signer))` (`EthereumBridgeOracle._accountIdFromAddress`),
    /// so register THIS id on the asset, deposit to `signer`, and pass
    /// `assetEncId` to lock/finalize. Needed because of CHANGE 3 (see header).
    function assetAccount(address asset, bytes32 encAccount, uint256 algId)
        public
        view
        returns (address signer, bytes32 assetEncId)
    {
        signer = signerAddress(asset, encAccount, algId);
        assetEncId = bytes32(uint256(uint160(signer)));
    }

    // --- request authorization (EIP-712) -------------------------------------

    /// The EIP-712 digest a requester signs to authorize the committee to sign
    /// `txData` for `encAccount` on `asset`. The domain binds this committee on
    /// this chain; the struct binds the exact asset, account, and tx — so a
    /// captured signature cannot be replayed to a different tx/account/asset/
    /// committee/chain.
    function requestDigest(address asset, bytes32 encAccount, bytes calldata txData)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(SIGN_REQUEST_TYPEHASH, asset, encAccount, keccak256(txData)));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    /// Recover the requester address from `requesterSig` over
    /// `requestDigest(...)`. This is the Crossroads `spender`. Free of Sapphire
    /// precompiles, so the recovery path is unit-testable off-chain.
    function recoverRequester(
        address asset,
        bytes32 encAccount,
        bytes calldata txData,
        bytes calldata requesterSig
    ) public view returns (address) {
        return _recover(requestDigest(asset, encAccount, txData), requesterSig);
    }

    // --- the committee: confidential, policy-gated signer --------------------

    /// Sign `txData` for `(asset, encAccount, alg)` — but only after asking the
    /// asset whether it permits the spend via `canSign(spender, assetEncId,
    /// txData)`. Returns the algorithm-native signature bytes: for secp256k1 the
    /// ASN.1 DER encoding from `Sapphire.sign` (NOT 65-byte r||s||v, and no `v`).
    /// The client splits the DER into (r, s) and recovers `v` against
    /// `signerAddress(...)` (or use `EthereumUtils.splitDERSignature` semantics).
    ///
    /// `spender` is NOT an argument: it is recovered from `requesterSig`. The
    /// Crossroads `spender` is the account whose spending balance/subsidy
    /// authorizes the withdrawal, so it must be the party that actually
    /// requested the signature — recovering it ties the request to control of
    /// that account's key rather than letting a caller name a third party.
    ///
    /// The committee signs `keccak256(txData)` — exactly the bytes the asset
    /// approved — so a caller cannot get `canSign` to approve one transaction and
    /// have the committee sign a different one.
    function sign(
        address asset,
        bytes32 encAccount,
        uint256 algId,
        bytes calldata txData,
        bytes calldata requesterSig
    ) external view returns (bytes memory) {
        address spender = recoverRequester(asset, encAccount, txData, requesterSig);

        (bytes memory sk, bytes memory pk) = _derive(asset, encAccount, algId);
        // CHANGE 3 (vs original): gate on the ADDRESS-DERIVED id, not the raw
        // `encAccount` label. The original passed `encAccount` here, which the
        // real Crossroads asset always rejects (see header CHANGE 3).
        bytes32 assetEncId = bytes32(uint256(uint160(EthereumUtils.k256PubkeyToEthereumAddress(pk))));
        require(
            ICrossroadsAsset(asset).canSign(spender, assetEncId, txData),
            "asset rejected signing request"
        );

        // CHANGE 2 (vs original): digest -> `contextOrHash` (3rd arg), `message`
        // (4th) empty. The original had these two arguments swapped.
        return Sapphire.sign(
            Sapphire.SigningAlg.Secp256k1PrehashedKeccak256,
            sk,
            abi.encodePacked(keccak256(txData)),
            ""
        );
    }

    // --- CHANGE 1: inlined helpers replacing OZ EIP712/ECDSA (Cancun mcopy) --
    // `_domainSeparator` == OZ EIP712 domain separator; `_recover` == OZ
    // `ECDSA.recover` (incl. the high-s malleability check). See header CHANGE 1.

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(_EIP712_DOMAIN_TYPEHASH, _HASHED_NAME, _HASHED_VERSION, block.chainid, address(this))
        );
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
        // Reject the upper half of the curve order (signature malleability).
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "bad s"
        );
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad requester signature");
        return signer;
    }
}
