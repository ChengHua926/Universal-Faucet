# Crossroads Signing Committee — NEAR MPC Rewrite

This repository is a Rust committee service built directly around NEAR's `threshold-signatures` crate from `near/mpc`. It has no compatibility layer for the previous committee implementation and no legacy protocol fallback: the only signing paths are NEAR MPC threshold ECDSA over secp256k1 and NEAR MPC/FROST Ed25519.

## What this implements

- Committee discovery from `CommitteeBootstrap` at a configured, hardcoded address.
- One-time NEAR threshold DKG for **two persistent root keys** per committee: one ECDSA/secp256k1 root and one Ed25519 root.
- Both schemes are loaded and served by the same VM at the same time.
- Asset-contract-controlled scheme selection through `signatureScheme()`, returning `1` for ECDSA/secp256k1 or `2` for Ed25519.
- Stateless derived signing keys for `(assetContract, encumberedAccount)` using deterministic public-key tweaks under the selected root.
- Per-request validation against the user-supplied asset contract's `canSign(address spender, bytes32 encAccount, bytes txData)` view.
- NEAR robust threshold ECDSA for secp256k1.
- NEAR threshold Ed25519 using the library's FROST EdDSA path.
- Per-scheme root records in the bootstrap contract, so the same finalized committee publishes both an ECDSA root and an Ed25519 root.
- Unauthenticated plaintext peer-to-peer HTTP transport on the assumption that Tor or another trusted tunnel wraps it.

## Supported schemes

Every node process serves both schemes concurrently. There is no `SIGNATURE_SCHEME` runtime switch.

| Scheme id | Scheme | MPC path | Message handling | Signature output |
|---:|---|---|---|---|
| `1` | `ecdsa-secp256k1` | NEAR robust ECDSA | Controlled by `ECDSA_SIGNATURE_KIND` | `raw32`, `eth-keccak`, or `btc-sha256` encoding |
| `2` | `ed25519` | NEAR FROST Ed25519 | Signs the raw bytes supplied in `message` | 64-byte RFC 8032 Ed25519 signature |

ECDSA signing keeps the split-view-safe shape required by the robust ECDSA code: `n = 2f + 1`, with reconstruction threshold `f + 1`. Because the same process always supports ECDSA and Ed25519, the committee roster must satisfy this ECDSA shape even when an individual request uses Ed25519.

## Architecture

Each VM runs one committee node. At startup, a node reads the bootstrap contract, derives its `Participant` id from the finalized roster order, and loads its local constant-sized root key shares from `ECDSA_ROOT_SHARE_FILE` and `ED25519_ROOT_SHARE_FILE`.

Bootstrap flow:

1. Operators register committee members in `CommitteeBootstrap`.
2. Once the contract is finalized, a committee node calls `POST /v1/bootstrap/init`.
3. The initiator triggers all peers to run NEAR DKG for any missing root: ECDSA first, then Ed25519.
4. Each node persists only its local root `KeygenOutput` for each scheme.
5. The initiator optionally submits both root public keys to the bootstrap contract with `submitRootRecord` when `ADMIN_PRIVATE_KEY` is set.

Signing flow:

1. A user sends `asset_contract`, `encumbered_account`, raw hex `message`, and an EIP-191 signature over the canonical JSON payload.
2. Every member recovers `spender` from the user signature.
3. Every member calls `signatureScheme()` on the asset contract and selects the matching local MPC root.
4. Every member independently calls `canSign(spender, encAccount, txData)` on the asset contract.
5. The committee derives a scheme-specific public key tweak from `(rootPublicKey, assetContract, encumberedAccount)`.
6. Members run the selected NEAR MPC signing protocol.
7. The coordinator returns the signature and derived public key.

## Contract expectations

The asset contract passed in each signing request must expose:

```solidity
function signatureScheme() external view returns (uint8);
function canSign(address spender, bytes32 encAccount, bytes calldata txData) external view returns (bool);
```

`signatureScheme()` must return:

- `1` for `ecdsa-secp256k1`
- `2` for `ed25519`

The repository includes only the committee initialization contract and local mocks:

- `contracts/CommitteeBootstrap.sol`
- `contracts/EcdsaRecoveryHelper.sol`
- `contracts/MockCommitteeAttestationVerifier.sol`
- `contracts/MockCanSign.sol`

The bootstrap contract stores active root records by `schemeId`:

- `1` = `ecdsa-secp256k1`
- `2` = `ed25519`

## Configuration

Required environment variables:

```bash
COMMITTEE_SELF_MEMBER_ID=0x...
EVM_RPC_URL=http://127.0.0.1:8545
BOOTSTRAP_CONTRACT=0x...
ECDSA_ROOT_SHARE_FILE=./secrets/root-ecdsa.json
ED25519_ROOT_SHARE_FILE=./secrets/root-ed25519.json
```

Common optional variables:

```bash
COMMITTEE_LISTEN=0.0.0.0:8080
ADMIN_PRIVATE_KEY=0x...              # only needed to submit root records
ECDSA_SIGNATURE_KIND=raw32           # ECDSA only: raw32 | eth-keccak | btc-sha256
REQUEST_TIMEOUT_SECS=120
MPC_ROUND_TIMEOUT_SECS=180
```

For Ed25519, `ECDSA_SIGNATURE_KIND` is ignored and the service signs the raw bytes represented by `message`.

## HTTP API

```text
GET  /healthz
GET  /v1/bootstrap/status
POST /v1/bootstrap/init
POST /v1/derived-key
POST /v1/sign
POST /v1/internal/bootstrap/run      # peer internal endpoint
POST /v1/internal/run-sign           # peer internal endpoint
POST /v1/internal/mpc/message        # peer internal endpoint
```

### Derived key request

```json
{
  "asset_contract": "0x0000000000000000000000000000000000000001",
  "encumbered_account": "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The node calls `signatureScheme()` on `asset_contract`, then returns the derived public key for that scheme.

### Signing request

```json
{
  "asset_contract": "0x0000000000000000000000000000000000000001",
  "encumbered_account": "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "message": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "user_signature": "0x..."
}
```

`user_signature` signs the EIP-191 hash of this canonical JSON object, with lowercase normalized fields and no `user_signature` field:

```json
{"asset_contract":"0x...","encumbered_account":"0x...","message":"0x..."}
```

Use `scripts/request_tool.py` to generate that payload and signature. The scheme is intentionally not part of the user-signed payload; the asset contract is the source of truth for scheme selection.

## No legacy support

This codebase does not retain the old system's storage model, wire protocol, request handlers, key format, or scheme-selection configuration. Similar naming or service structure is only organizational; all cryptographic operations go through NEAR `threshold-signatures`, and every node serves both supported schemes at once.

## Build and test

```bash
cargo build
cargo test
forge build
```

The repository also includes a live local end-to-end harness:

```bash
make e2e
```

The e2e harness starts anvil, deploys the bootstrap and mock asset contracts with Foundry, registers and finalizes a three-node committee, starts all committee nodes, bootstraps both MPC roots, and verifies successful and denied signing requests for account-scoped ECDSA and Ed25519 assets. Set `COMMITTEE_SIZE` to another odd split-view-safe size when needed.

## Signing-latency benchmark

Sweep over committee sizes and simulated inter-node RTTs, then print a table:

```bash
SIZES="3 5 7 9 11 13 15" \
  LATENCIES="0 10 50 100 250 500 1000" \
  TRIALS=5 SIGN_TIMEOUT=22 SCHEMES="ecdsa ed25519" \
  PROFILE=release \
  bash scripts/bench_sweep.sh
```

Any cell whose sign exceeds `SIGN_TIMEOUT` seconds is aborted and marked `skip`. To re-print the table from existing results:

```bash
python3 scripts/bench_summarize.py tmp/bench-sign-latency/results
```
