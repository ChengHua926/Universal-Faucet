// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MiningRewardToken
 * @notice The Universal Faucet mining-reward token. Minting is gated to
 * authorized minters: the mining pool's TEE attestor is granted the minter role
 * and mints rewards as it attests mining output (e.g. Monero contributed). This
 * is the integration seam — the pool plugs in as a minter; nothing else changes.
 * Pairs with Crossroads assets (e.g. crsETH) in the AMM so rewards are tradeable.
 */
contract MiningRewardToken is ERC20, Ownable {
    mapping(address => bool) public isMinter;

    event MinterSet(address indexed minter, bool allowed);

    constructor(string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {}

    /// @notice Authorize (or revoke) an address that may mint rewards — the
    /// mining pool's TEE/attestor contract.
    function setMinter(address minter, bool allowed) external onlyOwner {
        isMinter[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    /// @notice Mint mining rewards. Callable only by an authorized minter.
    function mint(address to, uint256 amount) external {
        require(isMinter[msg.sender], "MiningRewardToken: not a minter");
        _mint(to, amount);
    }
}
