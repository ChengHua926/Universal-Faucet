require("@oasisprotocol/sapphire-hardhat");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("dotenv").config();

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  networks: {
    "sapphire-testnet": {
      url: process.env.SAPPHIRE_TESTNET_RPC_URL || "https://testnet.sapphire.oasis.io",
      chainId: 0x5aff,
      accounts,
    },
    "sapphire-mainnet": {
      url: process.env.SAPPHIRE_MAINNET_RPC_URL || "https://sapphire.oasis.io",
      chainId: 0x5afe,
      accounts,
    },
  },
};
