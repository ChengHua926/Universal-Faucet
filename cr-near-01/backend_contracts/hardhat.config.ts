import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin, hardhatEthers],
  solidity: {
    profiles: {
      default: {
        version: "0.8.33",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "berlin",
        },
      },
      production: {
        version: "0.8.33",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "berlin",
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC_URL ?? configVariable("SEPOLIA_RPC_URL"),
      accounts: [process.env.SEPOLIA_PRIVATE_KEY ?? configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    hoodi: {
      type: "http",
      chainType: "l1",
      url: process.env.HOODI_RPC_URL ?? configVariable("HOODI_RPC_URL"),
      accounts: [process.env.HOODI_PRIVATE_KEY ?? configVariable("HOODI_PRIVATE_KEY")],
    },
    dev: {
      type: "http",
      url: "http://127.0.0.1:8545",
      // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
      // 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
      accounts: [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      ],
      chainId: 0x5a_fd,
      timeout: 10_000_000,
    },
    kurtosis: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:32003",
      accounts: [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      ],
      chainId: 30121,
      timeout: 10_000_000,
    },
  },
  test: {
    mocha: {
      timeout: 600_000,
    },
  },
});
