// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HeaderReportOracle} from "../HeaderReportOracle.sol";
import {HeaderReport, HeaderReportLib} from "../HeaderReportLib.sol";

/// @notice Test-only harness. registerHeaderSigner is gated by the Sapphire-only
///         roflEnsureAuthorizedOrigin precompile (reverts on plain Hardhat EDR),
///         so tests set the signer directly to exercise submitSignedHeader. Also
///         exposes the pure digest/recover helpers with explicit params so a
///         Python-generated fixture can be cross-checked deterministically.
contract HeaderReportOracleHarness is HeaderReportOracle {
    constructor(
        bytes21 a,
        uint256 sc,
        uint256 mc,
        bool mf
    ) HeaderReportOracle(a, sc, mc, mf) {}

    function setSignerForTest(address signer, uint64 epoch) external {
        headerSigner = signer;
        headerSignerEpoch = epoch;
    }

    function digestForTest(
        uint256 sapphireChainId,
        address oracleContract,
        HeaderReport calldata r
    ) external pure returns (bytes32) {
        return HeaderReportLib.digest(sapphireChainId, oracleContract, r);
    }

    function recoverForTest(bytes32 d, bytes calldata sig) external pure returns (address) {
        return _recover(d, sig);
    }
}
