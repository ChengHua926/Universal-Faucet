// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommitteeBootstrap} from "../contracts/CommitteeBootstrap.sol";
import {MockAccountScopedCanSign} from "../contracts/MockAccountScopedCanSign.sol";
import {MockCommitteeAttestationVerifier} from "../contracts/MockCommitteeAttestationVerifier.sol";
import {EcdsaRecoveryHelper} from "../contracts/EcdsaRecoveryHelper.sol";

interface Vm {
    function envAddress(string calldata name) external returns (address value);
    function envString(string calldata name) external returns (string memory value);
    function envUint(string calldata name) external returns (uint256 value);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value) external returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value) external returns (string memory json);
    function startBroadcast() external;
    function stopBroadcast() external;
    function writeJson(string calldata json, string calldata path) external;
}

contract E2EDeploy {
    uint8 private constant SCHEME_ECDSA_SECP256K1 = 1;
    uint8 private constant SCHEME_ED25519 = 2;
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        uint8 threshold = uint8(vm.envUint("COMMITTEE_THRESHOLD"));
        string memory outputPath = vm.envString("DEPLOYMENT_PATH");

        vm.startBroadcast();
        MockCommitteeAttestationVerifier verifier = new MockCommitteeAttestationVerifier();
        EcdsaRecoveryHelper ecdsaRecoveryHelper = new EcdsaRecoveryHelper();
        CommitteeBootstrap bootstrap = new CommitteeBootstrap(deployer, address(verifier), threshold);
        MockAccountScopedCanSign ecdsaAsset = new MockAccountScopedCanSign(SCHEME_ECDSA_SECP256K1);
        MockAccountScopedCanSign ed25519Asset = new MockAccountScopedCanSign(SCHEME_ED25519);
        vm.stopBroadcast();

        string memory json = "e2e";
        vm.serializeUint(json, "threshold", threshold);
        vm.serializeAddress(json, "verifier", address(verifier));
        vm.serializeAddress(json, "ecdsaRecoveryHelper", address(ecdsaRecoveryHelper));
        vm.serializeAddress(json, "bootstrap", address(bootstrap));
        vm.serializeAddress(json, "ecdsaAsset", address(ecdsaAsset));
        string memory finalJson = vm.serializeAddress(json, "ed25519Asset", address(ed25519Asset));
        vm.writeJson(finalJson, outputPath);
    }
}
