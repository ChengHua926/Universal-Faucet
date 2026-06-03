// The Sapphire plugin must be required so it can wrap the network provider and
// transparently encrypt transaction calldata (Sapphire's confidentiality).
require("@oasisprotocol/sapphire-hardhat");
// Gives us hre.ethers (contract factories, signers) inside scripts.
require("@nomicfoundation/hardhat-ethers");
// Adds chai matchers like .to.be.reverted for tests.
require("@nomicfoundation/hardhat-chai-matchers");
// Loads variables from a local .env file into process.env.
require("dotenv").config();

// Private key of the account that pays for and signs the deployment.
// Read from .env so it never gets hardcoded into source. Empty array if unset,
// which is fine for commands (like `compile`) that don't touch the network.
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      // Optimizer + IR pipeline: the 15-field report digest abi.encode otherwise
      // hits "stack too deep". evmVersion paris keeps the bytecode Sapphire-safe.
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris",
    },
  },
  // Heavier suite now (incl. the proof verifier + IR pipeline); give the first
  // in-process EDR warmup room, like the cr-near project does.
  mocha: { timeout: 120000 },
  networks: {
    "sapphire-testnet": {
      url: "https://testnet.sapphire.oasis.io",
      chainId: 0x5aff, // 23295
      accounts,
    },
    "sapphire-mainnet": {
      url: "https://sapphire.oasis.io",
      chainId: 0x5afe, // 23294
      accounts,
    },
  },
};
