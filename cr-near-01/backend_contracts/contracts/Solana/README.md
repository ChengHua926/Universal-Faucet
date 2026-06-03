# Solana bridge integration

## Organization

Solana transaction byte parsing is split out from oracle policy:

- `SolanaTransactionLib.sol` contains the reusable v0 message, instruction, transfer, memo, hash, withdrawal-syntax, and durable-nonce-initialization parser helpers.
- `SolanaTransactionCodec.sol` is a small deployable pure facade over the library for tests, manual tooling, and future integrations that only need codec behavior.
- `SolanaBridgeOracle.sol` now only keeps finality-report state, durable nonce state, and the `IBridgeOracle` deposit/withdrawal adapters.

This directory adds Solana v0 transaction support behind the existing `IBridgeOracle` interface, without modifying `AssetContract.sol`.

## Transaction conventions

### Deposits

A Solana deposit is a v0 transaction containing a `SystemProgram::Transfer` to a registered Crossroads Solana primary account and an SPL Memo instruction whose data is the Crossroads EVM address encoded as lowercase UTF-8 hex without a `0x` prefix. The bridge oracle returns:

- `sender`: the decoded EVM address stored in the memo;
- `destination`: the 32-byte transfer destination public key;
- `amount`: lamports transferred to that destination;
- `txHash`: `keccak256(primary_solana_signature)` to fit the existing `bytes32` bridge API.

### Withdrawals

A signed withdrawal is exactly three instructions:

1. `SystemProgram::AdvanceNonceAccount`
2. `SystemProgram::Transfer`
3. SPL Memo containing the lowercase UTF-8 hex Crossroads spender address, without a `0x` prefix

The v0 message `recent_blockhash` must equal the oracle's current durable nonce for the primary account. The authority for the nonce account must be the primary account, so the primary account is also a required signer. The oracle exposes `setDurableNonce` and `advanceDurableNonce` so a TEE/RPC-backed service can publish the currently usable nonce before a signing round.

### Durable nonce initialization

`decodeNonceInitialization` validates the one-time transaction shape used to create a durable nonce account:

1. `SystemProgram::CreateAccount` for a fresh nonce account owned by the System Program and at least 80 bytes in size.
2. `SystemProgram::InitializeNonceAccount`, setting the authority to the primary account.

## Oracle finality model

Solana has no transaction Merkle tree. `SolanaBridgeOracle` therefore stores finalized transaction signatures reported by an off-chain oracle service. In production, configure a threshold of report signer keys that are bound off-chain to TEE attestations. Each signer signs the `CROSSROADS_SOLANA_FINALIZED_TX_V1` digest for the 64-byte Solana transaction signature. For local tests, deploy with threshold `0` and call the owner-only finalized transaction helper.


## Running a local Solana validator

The repository includes a local-validator workflow equivalent to the Ethereum
Kurtosis and Bitcoin regtest flows. It depends on the Solana CLI binary
`solana-test-validator`.

One-shot run, including validator startup and cleanup:

```sh
npm run test:solana-devnet:local
```

Manual two-terminal run:

```sh
# Terminal 1
npm run solana:devnet

# Terminal 2
SOLANA_RPC_URL=http://127.0.0.1:8899 npm run test:solana-devnet
```

The manual validator script supports these environment variables:

- `SOLANA_LEDGER_DIR` defaults to `.solana-test-validator`
- `SOLANA_RPC_PORT` defaults to `8899`
- `SOLANA_FAUCET_PORT` defaults to `9900`

The one-shot script `scripts/e2e-solana-devnet.sh` starts a reset local
validator, waits for RPC health, runs `test/solana-devnet.ts`, and shuts down the
validator on exit.

## Real signing committee E2E

`test/solana-real-committee-devnet.ts` is the full Solana signing test. It is
skipped unless both `SOLANA_RPC_URL` is set and `SIGNING_COMMITTEE=real`. The
one-shot script starts all required local services:

```sh
npm run test:real-committee:solana
```

The test uses the Rust committee's Ed25519 scheme (`signatureScheme == 2`) as the
Solana primary account. The committee signs the exact serialized v0 message bytes
for a durable-nonce withdrawal; those 64 signature bytes are placed in the
Solana transaction signature vector and broadcast to `solana-test-validator`. The
Solana validator accepting/finalizing the transaction is the signature check for
the real committee path. The finalized bytes are then submitted to
`SolanaBridgeOracle` and finalized through `CrossroadsAssetContract`.
