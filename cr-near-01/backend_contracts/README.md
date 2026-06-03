# Crossroads Backend Contracts

## Setup

Install the Node dependencies from the lockfile:

```sh
npm ci
```

If you already have a stale or partial install, reset it first:

```sh
rm -rf node_modules
npm ci
```

## External prerequisites

Different test families need different tools.

### Always required

- Node.js and `npm`

### Required for the Ethereum proof-source tests

- Docker
- Kurtosis

Manual Kurtosis lifecycle:

```sh
kurtosis run github.com/ethpandaops/ethereum-package --args-file ./devnet/network_params.yaml --image-download always --enclave crossroads-pub-devnet
kurtosis enclave stop crossroads-pub-devnet
kurtosis enclave rm crossroads-pub-devnet
```

### Required for Solana validator-backed tests

- Solana CLI, with `solana-test-validator` on `PATH`

One working install path is:

```sh
curl -sSfL https://release.anza.xyz/stable/install | sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

### Required for the real signing committee flows

- Rust/Cargo
- Foundry (`anvil`, `forge`, `cast`)
- the sibling repo at `../signing_committee`

Typical installs:

```sh
curl https://sh.rustup.rs -sSf | sh
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

The real-committee scripts default to:

- `CARGO=$HOME/.cargo/bin/cargo`
- `ANVIL=$HOME/.foundry/bin/anvil`
- `FORGE=$HOME/.foundry/bin/forge`
- `CAST=$HOME/.foundry/bin/cast`

Override them with environment variables if your tools live elsewhere.

## Test matrix

### Self-contained Hardhat suite, with Kurtosis already running

This is the default full suite. It uses the local in-memory asset chain and a separate Kurtosis geth node as the public proof-source chain.

```sh
npm test
```

Important:

- `npm test` assumes the Kurtosis chain is already running on `http://127.0.0.1:32003`
- if Kurtosis is not running, the EVM proof test will fail with `ECONNREFUSED`

The equivalent explicit command is:

```sh
npm run test:kurtosis
```

`npm run test:kurtosis` also assumes the Kurtosis chain already exists; it does not start Kurtosis for you.

### Pure Solana codec/oracle tests

No validator required:

```sh
npm run test:solana
```

### Local Solana validator E2E

One-shot validator startup, test run, and cleanup:

```sh
npm run test:solana-devnet:local
```

Manual two-terminal flow:

```sh
# Terminal 1
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
npm run solana:devnet

# Terminal 2
SOLANA_RPC_URL=http://127.0.0.1:8899 SOLANA_ALLOW_AIRDROP=1 npm run test:solana-devnet
```

### Public testnet deployment

The public testnet deployment target is Ethereum Hoodi. The source chains are
Bitcoin testnet, Ethereum Sepolia, and Solana devnet. Deploy with:

```sh
export HOODI_RPC_URL=https://...
export HOODI_PRIVATE_KEY=0x...
npm run deploy:public-testnets
```

The deployer writes `deployments/public-testnets-<chainId>.json` by default.
Set `PUBLIC_TESTNET_DEPLOYMENT_PATH` to choose another path.

Centralized oracle reporters use the same deployment file:

```sh
# Sepolia block hash oracle
PUBLIC_TESTNET_DEPLOYMENT_PATH=deployments/public-testnets-560048.json \
SEPOLIA_RPC_URL=https://... \
ORACLE_MODE=ethereum-sepolia \
  npm run oracle:public-testnets

# Bitcoin testnet block hash oracle
PUBLIC_TESTNET_DEPLOYMENT_PATH=deployments/public-testnets-560048.json \
BITCOIN_TESTNET_RPC_URL=http://127.0.0.1:18332 \
BITCOIN_TESTNET_RPC_USER=... \
BITCOIN_TESTNET_RPC_PASSWORD=... \
ORACLE_MODE=bitcoin-testnet \
  npm run oracle:public-testnets

# Solana finalized transaction reporter
PUBLIC_TESTNET_DEPLOYMENT_PATH=deployments/public-testnets-560048.json \
SOLANA_RPC_URL=https://api.devnet.solana.com \
SOLANA_TRANSACTION_SIGNATURES=<base58-signature> \
ORACLE_MODE=solana-finality \
  npm run oracle:public-testnets

# Solana durable nonce synchronizer
PUBLIC_TESTNET_DEPLOYMENT_PATH=deployments/public-testnets-560048.json \
SOLANA_RPC_URL=https://api.devnet.solana.com \
SOLANA_PRIMARY_ACCOUNT=<base58-public-key> \
SOLANA_NONCE_ACCOUNT=<base58-public-key> \
ORACLE_MODE=solana-nonce \
  npm run oracle:public-testnets
```

For real Solana devnet e2e runs, `SOLANA_DEPOSITOR_SECRET_KEY` is the funded
user account that makes the deposit into the committee-controlled encumbered
account. Encumbered account private keys must not be configured locally.
`SOLANA_DEPOSIT_LAMPORTS` defaults to `100000000` and
`SOLANA_MAX_DEPOSIT_LAMPORTS` defaults to `200000000`.

By default, Solana finality reporting is owner-centralized with threshold `0`.
Set `SOLANA_ORACLE_REPORT_PRIVATE_KEY` before deployment to configure a
one-signer report threshold, or set `SOLANA_ORACLE_REPORT_SIGNERS` and
`SOLANA_ORACLE_THRESHOLD` explicitly.

Useful knobs:

```sh
SOLANA_LEDGER_DIR=.solana-test-validator \
SOLANA_RPC_PORT=8899 \
SOLANA_FAUCET_PORT=9900 \
  npm run solana:devnet
```

### Real signing committee E2E

These scripts start the missing services for you.

Ethereum + Kurtosis proof-source chain:

```sh
npm run test:real-committee:kurtosis
```

Bitcoin regtest via Docker:

```sh
npm run test:real-committee:bitcoin
```

Solana local validator:

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
npm run test:real-committee:solana
```

Useful knobs for the real-committee scripts:

```sh
ANVIL_PORT=8545 \
SOLANA_RPC_PORT=8899 \
SOLANA_FAUCET_PORT=9900 \
SIGNING_COMMITTEE_SIZE=3 \
SIGNING_COMMITTEE_BASE_PORT=19080 \
COMMITTEE_MNEMONIC="test test test test test test test test test test test junk" \
  npm run test:real-committee:solana
```

```sh
ANVIL_PORT=8545 \
BITCOIN_RPC_PORT=18443 \
COMMITTEE_MNEMONIC="test test test test test test test test test test test junk" \
  npm run test:real-committee:bitcoin
```

`SIGNING_COMMITTEE=real` is set internally by the one-shot real-committee scripts. The Bitcoin flow also sets `ECDSA_SIGNATURE_KIND=btc-sha256` so the committee-derived account IDs match P2WPKH `hash160(publicKey)` account IDs.

## Optional Oasis Sapphire devnet

This is not required for the Solana or Bitcoin flows, and it is not required for the default mock-committee suite.

```sh
# linux/x86_64
docker run -it -p8545:8545 -p8546:8546 -p8547:8547 -p8548:8548 ghcr.io/oasisprotocol/sapphire-localnet -test-mnemonic

# Apple Silicon / other non-x86_64 hosts
docker run -it -p8545:8545 -p8546:8546 -p8547:8547 -p8548:8548 --platform linux/x86_64 ghcr.io/oasisprotocol/sapphire-localnet -test-mnemonic
```

Then run:

```sh
export SAPPHIRE_WRAP=1
npx hardhat test --network dev
```

Explorer:

- Oasis local explorer: <http://localhost:8548/localnet/sapphire/address/0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266>

## Notes

- The Solana bridge uses the Memo program with the Crossroads EVM address encoded as lowercase hex UTF-8 without the `0x` prefix. Raw 20-byte memo payloads do not work on a real validator.
- `scripts/e2e-solana-devnet.sh`, `scripts/e2e-real-committee-solana-devnet.sh`, `scripts/e2e-real-committee-bitcoin-regtest.sh`, and `scripts/e2e-real-committee-kurtosis.sh` are the most reproducible entry points because they provision their own local dependencies.
