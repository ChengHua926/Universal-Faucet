# Crossroads Header Oracle

This directory contains the ROFL-based Crossroads header oracle. The service is
request-driven: clients ask for an EVM source-chain block header, the ROFL app
checks the header against a quorum of source RPCs, signs a report with the
registered Sapphire `headerSigner`, and returns the signed report over HTTP.

The old `cr-near-01/crossroads-oracle` directory is only a reference. This
implementation lives in `cr-near-01/crossroads_oracle`.

## Functionality

The oracle provides three main capabilities:

- Header signer bootstrap: derive a stable secp256k1 signer from ROFL KMS,
  verify that the running ROFL app id matches the Sapphire oracle contract, and
  register or rotate the `headerSigner` on Sapphire through ROFL appd.
- Source-chain header validation: query multiple source RPCs, confirm the
  requested block by quorum depth, optionally require quorum-finalized status,
  reconstruct the canonical EVM RLP header, and vote on the recomputed block
  hash.
- Signed report serving: sign a domain-separated report digest, cache immutable
  confirmed header reports, and expose the reports through a small HTTP API.

The service does not write source block hashes on-chain by itself. It returns a
signed report that a later Sapphire-side adapter/verifier can validate and use
to populate existing block-hash oracle storage.

## Runtime Components

- `app/oracle.py`: process entrypoint, environment parsing, signer
  registration, source RPC validation, and HTTP server startup.
- `app/kms_key.py`: ROFL KMS secp256k1 key derivation and Ethereum address
  derivation.
- `app/contract_client.py`: Sapphire oracle ABI, ROFL app id normalization,
  commitment digest construction, and register/rotate calldata generation.
- `app/source_rpc.py`: source RPC chain id validation, quorum tip/finality
  checks, block fetching, and recomputed hash voting.
- `app/evm_header.py`: canonical EVM block header RLP encoder. It includes
  London, Shanghai, Cancun, and Prague/Pectra header fields.
- `app/header_report.py`: report domain, RPC vote digest, report digest,
  low-s secp256k1 signature, and signer recovery helper.
- `app/server.py`: HTTP API handlers and signer mismatch checks.
- `app/report_cache.py`: bounded in-memory signed report cache.
- `app/rate_limit.py`: best-effort global fixed-window rate limiter.

## Configuration

The service reads `.env` through `python-dotenv` and also supports normal
environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORACLE_MODE` | `rofl` | Must be `rofl`; register/rotate transactions go through ROFL appd. |
| `TARGET_RPC_URL` | `https://testnet.sapphire.oasis.io` | Sapphire RPC used to read oracle contract state. |
| `SAPPHIRE_CHAIN_ID` | `23295` | Sapphire chain id bound into commitments and reports. |
| `ORACLE_CONTRACT_ADDRESS` | none | Required Sapphire `CrossroadsHeaderOracle` address. |
| `SOURCE_RPC_URLS` | Sepolia public RPC set | Comma-separated source-chain RPC URLs. |
| `SOURCE_RPC_QUORUM` | `2` | Number of source RPCs needed for chain id, tip, finality, and header hash quorum. |
| `SOURCE_CONFIRMATIONS` | `12` | Confirmation depth required by quorum tips. |
| `SOURCE_CHAIN_ID` | `11155111` | Source-chain chain id. Defaults to Ethereum Sepolia. |
| `SOURCE_REQUIRE_FINALIZED` | `0` | If `1`, source RPC quorum must report finalized block >= requested block. |
| `HEADER_REPORT_TTL_SECONDS` | `1800` | Signed report expiry horizon. |
| `HEADER_REPORT_CACHE_SIZE` | `512` | Maximum in-memory cached signed reports. |
| `HEADER_REPORT_CACHE_REFRESH_SECONDS` | `120` | Refresh a cached report when it is close to expiry. |
| `HTTP_HOST` | `0.0.0.0` | HTTP bind address. |
| `HTTP_PORT` | `8080` | HTTP bind port. |
| `HTTP_RATE_LIMIT_PER_MINUTE` | `60` | Best-effort global request limit. `0` disables it. |
| `ROFL_KMS_KEY_ID` | `crossroads-header-signer-v1` | Stable ROFL KMS key id for the header signer. |
| `ALLOW_SIGNER_ROTATION` | `0` | Must be `1` to replace an already-registered signer. |
| `ALLOW_LEGACY_FILE_SIGNER` | `0` | Development fallback only. Production should keep it disabled. |
| `ORACLE_SIGNING_KEY_PATH` | `/storage/crossroads-header-signer.json` | Legacy fallback path when `ALLOW_LEGACY_FILE_SIGNER=1`. |

## Startup Flow

The production entrypoint is:

```shell
python -m app.oracle
```

The Docker image uses that command by default.

The startup sequence is:

1. Load `.env` and environment variables into `OracleConfig`.
2. Require `ORACLE_CONTRACT_ADDRESS`; reject invalid numeric settings such as
   non-positive `SOURCE_CONFIRMATIONS` or `HEADER_REPORT_TTL_SECONDS`.
3. Connect to ROFL appd over `/run/rofl-appd.sock`.
4. Read the ROFL app id from `GET /rofl/v1/app/id`.
5. Derive the local header signer by calling `POST /rofl/v1/keys/generate` with
   `{ "key_id": ROFL_KMS_KEY_ID, "kind": "secp256k1" }`.
6. Derive and log only the Ethereum signer address. The KMS private key is not
   written to disk.
7. Connect to the Sapphire oracle contract at `ORACLE_CONTRACT_ADDRESS`.
8. Read `roflAppID()` from the contract and require it to match the ROFL app id
   reported by appd.
9. Read `headerSigner()` and `headerSignerEpoch()`.
10. Build the signer commitment for `headerSignerEpoch + 1`:
    `keccak256(abi.encode(CROSSROADS_HEADER_SIGNER_V1, sapphireChainId,
    oracleContract, roflAppID, signer, nextEpoch))`.
11. If the chain signer is empty, submit `registerHeaderSigner` through
    `/rofl/v1/tx/sign-submit`.
12. If the chain signer already equals the local signer, skip registration and
    use the current on-chain epoch.
13. If the chain signer differs, exit unless `ALLOW_SIGNER_ROTATION=1`; with
    rotation enabled, submit `rotateHeaderSigner`.
14. Validate each configured source RPC with `eth_chainId`. Only RPCs matching
    `SOURCE_CHAIN_ID` participate in quorum.
15. Require at least `SOURCE_RPC_QUORUM` usable source RPCs.
16. Start the HTTP server on `HTTP_HOST:HTTP_PORT`.

`compose.yaml` exposes port `8080` and mounts the ROFL appd socket:

```shell
docker compose up --build oracle
```

In an actual ROFL deployment, the compose service runs inside the ROFL
container environment where `/run/rofl-appd.sock` is provided by the platform.

## Request Flow

For `GET /v1/header?block_number=N`:

1. Check the signed-report cache. A fresh cache hit returns without source RPC
   calls or signing.
2. Query usable source RPCs with `eth_blockNumber`.
3. Require at least quorum RPCs with `tip >= N + SOURCE_CONFIRMATIONS`.
4. If `SOURCE_REQUIRE_FINALIZED=1`, query `eth_getBlockByNumber("finalized",
   false)` and require quorum finalized block numbers >= `N`.
5. Fetch the block JSON from each usable RPC with
   `eth_getBlockByNumber(hex(N), false)`.
6. Rebuild the canonical RLP header from each successful block JSON.
7. Compute `keccak256(rlpHeader)` and require it to equal that RPC's `block.hash`.
8. Vote on the recomputed block hash and require hash quorum.
9. Pick the first usable winner vote's RLP header.
10. Re-read Sapphire `headerSigner()` and `headerSignerEpoch()`.
11. Refuse to sign if the local signer no longer matches the Sapphire
    `headerSigner`.
12. Build the signed report, cache it, and return it.

For `GET /v1/header/latest-confirmed`:

1. Query source RPC tips.
2. Compute the quorum tip threshold as the Nth-highest tip, where N is
   `SOURCE_RPC_QUORUM`.
3. Set `confirmedByDepth = quorumTip - SOURCE_CONFIRMATIONS`.
4. If finality is required, use
   `min(confirmedByDepth, quorumFinalizedThreshold)`.
5. Run the same signed-report flow for the selected block number.

This means one lagging RPC does not hold back `latest-confirmed` as long as
quorum is still available.

## HTTP API

### `GET /healthz`

Cheap local health endpoint. It does not call source RPCs or Sapphire.

```json
{
  "ok": true,
  "sourceChainId": 11155111,
  "sourceRpcQuorum": 2,
  "requiredConfirmations": 12,
  "requireFinalized": false,
  "signer": "0x...",
  "signerEpoch": 1
}
```

### `GET /v1/header?block_number=123`

Returns a signed report for a specific source block once quorum confirmations
are available.

### `GET /v1/header/latest-confirmed`

Returns a signed report for the newest block confirmed by the quorum tip
threshold and, if enabled, finalized by quorum.

### Error Codes

- `400`: invalid input or requested block is too new
- `409`: source RPC block headers or recomputed hashes did not reach quorum
- `429`: best-effort rate limit
- `503`: not enough usable source RPCs or local signer mismatches Sapphire
- `500`: internal error

## Signed Report

The response includes:

- `sourceChainId`
- `blockNumber`
- `blockHash`
- `rlpHeader`
- `rlpHeaderHash`
- `requiredConfirmations`
- `observedConfirmations`
- `quorumTip`
- `requireFinalized`
- `finalizedBlockNumber`
- `rpcVotes`
- `rpcVoteDigest`
- `signer`
- `signerEpoch`
- `oracleContractAddress`
- `sapphireChainId`
- `reportDigest`
- `signature`
- `expiresAt`

The report digest domain is `CROSSROADS_HEADER_REPORT_V1`, encoded as
`bytes32`. The signature is over the raw report digest, not an EIP-191 or
`personal_sign` prefixed digest. The returned signature is `r || s || v` with
`v` as `27` or `28` and `s` normalized to low-s form.

`rpcVoteDigest` is built from typed vote hashes, not from JSON string hashing.
Votes are ordered by configured source index.

## Trust Boundary

A Sapphire verifier can enforce:

- `keccak256(rlpHeader) == blockHash`
- report domain, Sapphire chain id, and verifying contract binding
- `signerEpoch == headerSignerEpoch`
- `ecrecover(reportDigest, signature) == headerSigner`
- signed confirmation and finality fields
- `expiresAt` if the verifier chooses to enforce report freshness

A Sapphire verifier cannot independently redo the off-chain work. It trusts the
TEE signature as the commitment that source RPC quorum checks, recomputed header
hash voting, and optional finalized checks were performed.

## Development and Tests

Install dependencies in an isolated environment, then run:

```shell
python -m pytest
```

The unit tests cover:

- ROFL KMS key parsing and signer address derivation
- EVM header RLP canonicalization, including Prague/Pectra `requestsHash`
- source RPC quorum behavior
- signed report digest stability and signer recovery
- cache behavior and cheap `/healthz`

The app's production startup expects ROFL appd. For local tests, use the unit
test fakes instead of trying to run the full ROFL registration flow outside a
ROFL environment.
