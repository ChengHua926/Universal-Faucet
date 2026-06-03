# Crossroads Header Oracle

This ROFL app registers a Sapphire `headerSigner` and serves request-driven EVM
header reports signed by that signer.

## HTTP API

`GET /healthz` is local and cheap. It does not call source RPCs or Sapphire.

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

`GET /v1/header?block_number=123` returns a signed report for a specific source
block once quorum RPC tips satisfy `block_number + SOURCE_CONFIRMATIONS`.

`GET /v1/header/latest-confirmed` returns a signed report for the latest block
that is confirmed by the quorum tip threshold. A lagging RPC does not hold back
the threshold when quorum is still available.

Status codes:

- `400`: invalid input or requested block is too new
- `409`: source RPC block headers or recomputed hashes did not reach quorum
- `429`: best-effort rate limit
- `503`: not enough usable source RPCs or local signer mismatches Sapphire
- `500`: internal error

## Signer

Production uses ROFL KMS:

```env
ROFL_KMS_KEY_ID=crossroads-header-signer-v1
```

The app calls `/rofl/v1/keys/generate` with kind `secp256k1`, derives the
Ethereum address, prints only the address, and never writes the private key to
disk. The same ROFL app and key id produce the same signer across restarts and
storage wipes. Changing `ROFL_KMS_KEY_ID` is an explicit signer rotation and
requires `ALLOW_SIGNER_ROTATION=1`.

The legacy file signer is disabled by default. It is only used when
`ALLOW_LEGACY_FILE_SIGNER=1` is set explicitly.

## Trust Boundary

Future Sapphire verifiers can enforce:

- `keccak256(rlpHeader) == blockHash`
- report domain, Sapphire chain id, and verifying contract binding
- `signerEpoch == headerSignerEpoch`
- `ecrecover(reportDigest, signature) == headerSigner`
- signed confirmation and finality fields

The verifier cannot independently redo the off-chain work. It trusts the TEE
signature as the commitment that source RPC quorum checks, recomputed header
hash voting, and optional finalized checks were performed.
