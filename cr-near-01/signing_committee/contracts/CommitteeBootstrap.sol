// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICommitteeAttestationVerifier {
    function verifyAttestation(
        address bootstrap,
        bytes32 memberId,
        address admin,
        string calldata publicEndpoint,
        bytes32 bootstrapPubKey,
        bytes32 clientAuthPubKey,
        bytes calldata attestation
    ) external view returns (bool);
}

contract CommitteeBootstrap {
    struct Member {
        bytes32 id;
        address admin;
        string publicEndpoint;
        bytes32 bootstrapPubKey;
        bytes32 clientAuthPubKey;
        bool active;
    }

    struct RootRecord {
        uint8 schemeId;
        bytes publicKey;
        bytes32 chainCode;
        bytes32 manifestDigest;
        bool active;
    }

    struct RootProposal {
        uint8 schemeId;
        bytes publicKey;
        bytes32 chainCode;
        bytes32 manifestDigest;
        uint64 votes;
        bool exists;
        bool activated;
    }

    bytes32 private constant ROOT_DOMAIN = keccak256("HD_MPC_COMMITTEE_ROOT_RECORD_V1");

    address public bootstrapController;
    ICommitteeAttestationVerifier public immutable verifier;
    uint8 public immutable quorumThreshold;
    bool public bootstrapComplete;
    bool public registrationClosed;

    Member[] private _members;
    mapping(bytes32 => uint256) private _memberIndexPlusOne;
    mapping(address => uint256) private _adminIndexPlusOne;
    bytes32 private _finalCommitteeId;

    mapping(bytes32 => RootProposal) private _rootProposals;
    mapping(bytes32 => mapping(address => bool)) private _rootVotesByAdmin;
    mapping(uint8 => bytes32) public activeRootRecordHashByScheme;
    mapping(uint8 => RootRecord) private _activeRootRecords;

    event MemberRegistered(
        uint256 indexed index,
        bytes32 indexed id,
        address indexed admin,
        string publicEndpoint,
        bytes32 bootstrapPubKey,
        bytes32 clientAuthPubKey
    );
    event MemberRemoved(uint256 indexed index, bytes32 indexed id, address indexed admin);
    event BootstrapCompleted(bytes32 indexed committeeId, uint256 memberCount, uint8 threshold);
    event RootRecordSubmitted(bytes32 indexed recordHash, address indexed admin, uint8 votes);
    event RootRecordActivated(bytes32 indexed recordHash, uint8 indexed schemeId, bytes publicKey, bytes32 chainCode, bytes32 manifestDigest);

    error BootstrapAlreadyComplete();
    error RegistrationClosed();
    error FinalizationNotReady();
    error InvalidOwner();
    error InvalidVerifier();
    error InvalidThreshold();
    error InvalidTimeline();
    error EmptyMemberId();
    error EmptyPublicEndpoint();
    error DuplicateMemberId();
    error DuplicateAdmin();
    error InvalidAttestation();
    error UnknownMember();
    error NotController();
    error NotCommitteeAdmin();
    error InsufficientMembers();
    error RegistrationAlreadyClosed();
    error RootRecordNotReady();
    error RootRecordAlreadyActive();
    error RootVoteAlreadyCast();
    error EmptyPublicKey();
    error EmptyBootstrapPubKey();
    error EmptyClientAuthPubKey();

    constructor(
        address controller_,
        address verifier_,
        uint8 quorumThreshold_
    ) {
        if (controller_ == address(0)) revert InvalidOwner();
        if (verifier_ == address(0)) revert InvalidVerifier();
        if (quorumThreshold_ == 0) revert InvalidThreshold();

        bootstrapController = controller_;
        verifier = ICommitteeAttestationVerifier(verifier_);
        quorumThreshold = quorumThreshold_;
    }

    modifier onlyController() {
        if (msg.sender != bootstrapController) revert NotController();
        _;
    }

    modifier onlyBeforeCompletion() {
        if (bootstrapComplete) revert BootstrapAlreadyComplete();
        _;
    }

    modifier onlyDuringRegistration() {
        if (registrationClosed || bootstrapComplete) revert RegistrationClosed();
        _;
    }

    modifier onlyCommitteeAdmin() {
        uint256 idx = _adminIndexPlusOne[msg.sender];
        if (idx == 0) revert NotCommitteeAdmin();
        if (!_members[idx - 1].active) revert NotCommitteeAdmin();
        _;
    }

    function registerMember(
        bytes32 memberId,
        string calldata publicEndpoint,
        bytes32 bootstrapPubKey,
        bytes32 clientAuthPubKey,
        bytes calldata attestation
    ) external onlyBeforeCompletion onlyDuringRegistration {
        if (memberId == bytes32(0)) revert EmptyMemberId();
        if (bytes(publicEndpoint).length == 0) revert EmptyPublicEndpoint();
        if (bootstrapPubKey == bytes32(0)) revert EmptyBootstrapPubKey();
        if (clientAuthPubKey == bytes32(0)) revert EmptyClientAuthPubKey();
        if (_memberIndexPlusOne[memberId] != 0) revert DuplicateMemberId();
        if (_adminIndexPlusOne[msg.sender] != 0) revert DuplicateAdmin();
        if (!verifier.verifyAttestation(address(this), memberId, msg.sender, publicEndpoint, bootstrapPubKey, clientAuthPubKey, attestation)) {
            revert InvalidAttestation();
        }

        _members.push(
            Member({
                id: memberId,
                admin: msg.sender,
                publicEndpoint: publicEndpoint,
                bootstrapPubKey: bootstrapPubKey,
                clientAuthPubKey: clientAuthPubKey,
                active: true
            })
        );
        uint256 index = _members.length - 1;
        _memberIndexPlusOne[memberId] = index + 1;
        _adminIndexPlusOne[msg.sender] = index + 1;
        emit MemberRegistered(index, memberId, msg.sender, publicEndpoint, bootstrapPubKey, clientAuthPubKey);
    }

    function removeMember(bytes32 memberId) external onlyController onlyBeforeCompletion onlyDuringRegistration {
        uint256 indexPlusOne = _memberIndexPlusOne[memberId];
        if (indexPlusOne == 0) revert UnknownMember();
        uint256 index = indexPlusOne - 1;
        Member memory removed = _members[index];

        uint256 lastIndex = _members.length - 1;
        if (index != lastIndex) {
            Member memory moved = _members[lastIndex];
            _members[index] = moved;
            _memberIndexPlusOne[moved.id] = index + 1;
            _adminIndexPlusOne[moved.admin] = index + 1;
        }

        _members.pop();
        delete _memberIndexPlusOne[removed.id];
        delete _adminIndexPlusOne[removed.admin];
        emit MemberRemoved(index, removed.id, removed.admin);
    }

    function closeRegistration() external onlyController onlyBeforeCompletion {
        if (registrationClosed) revert RegistrationAlreadyClosed();
        registrationClosed = true;
    }

    function completeBootstrap() external onlyBeforeCompletion {
        if (!registrationClosed) revert FinalizationNotReady();
        if (_members.length < quorumThreshold) revert InsufficientMembers();

        bootstrapComplete = true;
        _finalCommitteeId = _computeCommitteeId();

        emit BootstrapCompleted(_finalCommitteeId, _members.length, quorumThreshold);
    }

    function submitRootRecord(
        uint8 schemeId,
        bytes calldata publicKey,
        bytes32 chainCode,
        bytes32 manifestDigest
    ) external onlyCommitteeAdmin {
        if (!bootstrapComplete) revert RootRecordNotReady();
        if (_activeRootRecords[schemeId].active) revert RootRecordAlreadyActive();
        if (publicKey.length == 0) revert EmptyPublicKey();

        bytes32 recordHash = keccak256(abi.encode(ROOT_DOMAIN, schemeId, keccak256(publicKey), chainCode, manifestDigest));
        if (_rootVotesByAdmin[recordHash][msg.sender]) revert RootVoteAlreadyCast();
        _rootVotesByAdmin[recordHash][msg.sender] = true;

        RootProposal storage p = _rootProposals[recordHash];
        if (!p.exists) {
            p.exists = true;
            p.schemeId = schemeId;
            p.publicKey = publicKey;
            p.chainCode = chainCode;
            p.manifestDigest = manifestDigest;
        }
        p.votes += 1;
        emit RootRecordSubmitted(recordHash, msg.sender, uint8(p.votes));

        if (p.votes >= quorumThreshold) {
            activeRootRecordHashByScheme[schemeId] = recordHash;
            _activeRootRecords[schemeId] = RootRecord({
                schemeId: p.schemeId,
                publicKey: p.publicKey,
                chainCode: p.chainCode,
                manifestDigest: p.manifestDigest,
                active: true
            });
            p.activated = true;
            emit RootRecordActivated(recordHash, p.schemeId, p.publicKey, p.chainCode, p.manifestDigest);
        }
    }

    function committeeId() external view returns (bytes32) {
        if (bootstrapComplete) {
            return _finalCommitteeId;
        }
        return _computeCommitteeId();
    }

    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    function getMember(uint256 i) external view returns (Member memory) {
        return _members[i];
    }

    function rootRecordActive(uint8 schemeId) external view returns (bool) {
        return _activeRootRecords[schemeId].active;
    }

    function rootRecord(uint8 schemeId) external view returns (RootRecord memory) {
        return _activeRootRecords[schemeId];
    }

    function rosterHash() external view returns (bytes32) {
        return _rosterHash();
    }

    function registrationOpen() external view returns (bool) {
        return !bootstrapComplete && !registrationClosed;
    }

    function finalizationOpen() external view returns (bool) {
        return !bootstrapComplete && registrationClosed;
    }

    function _computeCommitteeId() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), quorumThreshold, _rosterHash()));
    }

    function _rosterHash() internal view returns (bytes32) {
        bytes memory out;
        for (uint256 i = 0; i < _members.length; i++) {
            Member memory m = _members[i];
            out = abi.encodePacked(
                out,
                m.id,
                m.admin,
                keccak256(bytes(m.publicEndpoint)),
                m.bootstrapPubKey,
                m.clientAuthPubKey,
                m.active
            );
        }
        return keccak256(out);
    }
}
