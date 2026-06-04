// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MintableERC20
 * @notice Simple owner-mintable ERC20. Used as the Universal Faucet mining-token
 *         placeholder and as stand-in Crossroads tokens for AMM pool testing,
 *         until the real mining mechanism / minted Crossroads assets are wired in.
 */
contract MintableERC20 is ERC20, Ownable {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        address initialHolder
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        if (initialSupply > 0) {
            _mint(initialHolder == address(0) ? msg.sender : initialHolder, initialSupply);
        }
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
