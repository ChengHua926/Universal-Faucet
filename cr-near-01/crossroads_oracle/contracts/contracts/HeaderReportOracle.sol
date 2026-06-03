// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Subcall} from "@oasisprotocol/sapphire-contracts/contracts/Subcall.sol";
import {IBlockHashOracle} from "./EVM/IBlockHashOracle.sol";
import {HeaderReport, HeaderReportLib} from "./HeaderReportLib.sol";

/**
 * @title HeaderReportOracle (Model B reference)
 * @notice Two-part trust model:
 *   1. The ROFL app registers its header-signer address ONCE, gated by
 *      Subcall.roflEnsureAuthorizedOrigin (TEE-attested).
 *   2. Anyone can later submit a TEE-signed HeaderReport; we recover the
 *      signature against the registered signer and, if it passes the contract's
 *      OWN security floor, populate blockHashes[blockNumber].
 *
 * Because it populates the same blockHashes mapping and implements
 * IBlockHashOracle.getBlockHash, it is a drop-in for cr-near's
 * CentralizedEvmBlockHashOracle — EthereumBridgeOracle._verifyProof is unchanged.
 *
 * KEY POINT: the floor (minConfirmations, source chain, finality) is enforced by
 * THIS contract, not merely echoed from the TEE's self-reported fields.
 */
contract HeaderReportOracle is IBlockHashOracle {
    bytes21 public immutable roflAppID;
    uint256 public immutable expectedSourceChainId;
    uint256 public immutable minConfirmations;
    bool public immutable mandateFinalized;

    /**
     * @dev Source-chain RPC configuration the shared TEE container reads to serve
     * THIS contract. Letting one ROFL container fetch from per-contract RPC sets
     * (instead of hardcoding URLs) is what makes a single container serve every
     * EVM chain. Set once at construction and never mutated, so the trust set is
     * effectively immutable and a deployer can't swap in colluding RPCs later.
     * The container additionally only serves a contract whose roflAppID and
     * headerSigner already match its own identity, so this config being public
     * does not let an attacker conscript the TEE.
     */
    string[] private _sourceRpcUrls;
    uint256 public immutable sourceRpcQuorum;

    address public headerSigner;
    uint64 public headerSignerEpoch;
    bytes32 public headerSignerCommitment;

    mapping(uint256 => bytes32) public blockHashes;
    uint256 public latestBlockNumber;

    event HeaderSignerRegistered(address indexed signer, uint64 indexed epoch, bytes32 commitment);
    event HeaderSignerRotated(address indexed oldSigner, address indexed newSigner, uint64 indexed epoch);
    event BlockHashStored(uint256 indexed number, bytes32 hash);

    error AlreadyRegistered();
    error NotRegistered();
    error UnauthorizedReportSigner();
    error WrongSourceChain();
    error StaleSignerEpoch();
    error InsufficientConfirmations();
    error FinalityRequired();
    error HeaderHashMismatch();
    error ConflictingBlockHash();
    error ReportExpired();

    modifier onlyROFL() {
        Subcall.roflEnsureAuthorizedOrigin(roflAppID);
        _;
    }

    constructor(
        bytes21 _roflAppID,
        uint256 _expectedSourceChainId,
        uint256 _minConfirmations,
        bool _mandateFinalized,
        string[] memory _sourceRpcUrlList,
        uint256 _sourceRpcQuorum
    ) {
        require(_sourceRpcQuorum > 0, "quorum must be positive");
        require(_sourceRpcUrlList.length >= _sourceRpcQuorum, "fewer RPC URLs than quorum");
        roflAppID = _roflAppID;
        expectedSourceChainId = _expectedSourceChainId;
        minConfirmations = _minConfirmations;
        mandateFinalized = _mandateFinalized;
        _sourceRpcUrls = _sourceRpcUrlList;
        sourceRpcQuorum = _sourceRpcQuorum;
    }

    // --- Source RPC config (read by the shared TEE container) -----------------

    /// @notice The source-chain RPC endpoints the TEE queries to build reports
    ///         for this contract. Quorum-many must agree before a report is signed.
    function sourceRpcUrls() external view returns (string[] memory) {
        return _sourceRpcUrls;
    }

    function sourceRpcUrlCount() external view returns (uint256) {
        return _sourceRpcUrls.length;
    }

    // --- Registration (TEE-attested) -----------------------------------------

    function registerHeaderSigner(address signer, bytes32 commitment) external onlyROFL {
        if (headerSigner != address(0)) revert AlreadyRegistered();
        headerSignerEpoch += 1; // 0 -> 1
        headerSigner = signer;
        headerSignerCommitment = commitment;
        emit HeaderSignerRegistered(signer, headerSignerEpoch, commitment);
    }

    function rotateHeaderSigner(address signer, bytes32 commitment) external onlyROFL {
        if (headerSigner == address(0)) revert NotRegistered();
        address old = headerSigner;
        headerSignerEpoch += 1;
        headerSigner = signer;
        headerSignerCommitment = commitment;
        emit HeaderSignerRotated(old, signer, headerSignerEpoch);
    }

    // --- Adapter: verify a TEE-signed report, populate blockHashes ------------

    function submitSignedHeader(HeaderReport calldata r, bytes calldata signature) external {
        if (headerSigner == address(0)) revert NotRegistered();
        if (block.timestamp > r.expiresAt) revert ReportExpired();
        if (r.sourceChainId != expectedSourceChainId) revert WrongSourceChain();
        if (r.signerEpoch != headerSignerEpoch) revert StaleSignerEpoch();

        // Contract's OWN floor — not just trusting the TEE's self-reported policy.
        if (r.requiredConfirmations < minConfirmations) revert InsufficientConfirmations();
        if (r.observedConfirmations < r.requiredConfirmations) revert InsufficientConfirmations();
        if (mandateFinalized && (!r.requireFinalized || r.finalizedBlockNumber < r.blockNumber)) {
            revert FinalityRequired();
        }

        // Header integrity: the RLP header must hash to the claimed block hash.
        if (keccak256(r.rlpHeader) != r.blockHash) revert HeaderHashMismatch();
        if (r.rlpHeaderHash != r.blockHash) revert HeaderHashMismatch();

        // Signature is bound to THIS chain + THIS contract via the digest inputs.
        bytes32 d = HeaderReportLib.digest(block.chainid, address(this), r);
        if (_recover(d, signature) != headerSigner) revert UnauthorizedReportSigner();

        bytes32 existing = blockHashes[r.blockNumber];
        if (existing != bytes32(0)) {
            if (existing != r.blockHash) revert ConflictingBlockHash();
            return; // idempotent re-submission
        }
        blockHashes[r.blockNumber] = r.blockHash;
        if (r.blockNumber > latestBlockNumber) latestBlockNumber = r.blockNumber;
        emit BlockHashStored(r.blockNumber, r.blockHash);
    }

    // --- IBlockHashOracle -----------------------------------------------------

    function getBlockHash(uint256 blockNumber) external view override returns (bytes32) {
        bytes32 h = blockHashes[blockNumber];
        require(h != bytes32(0), "No header found for this block");
        return h;
    }

    // --- internal -------------------------------------------------------------

    /// @dev Recovers from a 65-byte r||s||v signature over the raw digest. v is
    ///      expected as 27/28; we also accept 0/1 for robustness. No EIP-191.
    function _recover(bytes32 d, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert UnauthorizedReportSigner();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 0x20))
            v := byte(0, calldataload(add(sig.offset, 0x40)))
        }
        if (v < 27) v += 27;
        return ecrecover(d, v, r, s);
    }
}
