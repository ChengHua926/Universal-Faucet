# Crossroads Workspace

This repository is now organized as a workspace with two distinct sub-projects:

- [signing_committee](/home/ubuntu/cr-near-01/signing_committee): the Rust NEAR MPC signing committee service, bootstrap contract, and Foundry-based committee e2e harness.
- [backend_contracts](/home/ubuntu/cr-near-01/backend_contracts): the Hardhat project for the Ethereum-facing asset contracts, inclusion-proof tooling, and backend-oriented e2e tests.

## Network split

The two test environments serve different purposes:

- The asset contracts themselves can be deployed on a local anvil chain.
- Kurtosis is required when the backend contract suite needs a devnet version of the Ethereum integrated chain, because the proof-building flow depends on `debug_getRawBlock` to assemble Merkle transaction inclusion proofs.

That means Kurtosis is for the integrated proof source chain, not for the local asset-contract deployment chain.

## Common commands

From the repository root:

```bash
make committee-build
make committee-test
make committee-e2e

make contracts-install
make contracts-test
```

For Kurtosis-backed backend tests, Solana local-validator tests, and real signing committee E2E scripts, see [backend_contracts/README.md](/home/ubuntu/cr-near-01/backend_contracts/README.md). For the Rust committee service and Foundry harness, see [signing_committee/README.md](/home/ubuntu/cr-near-01/signing_committee/README.md).
