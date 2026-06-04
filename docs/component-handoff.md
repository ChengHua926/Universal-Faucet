# Universal Faucet Mining Component Handoff

Scope: `drip` CLI, managed XMRig, Stratum Gate, XMRig Proxy, backend
accounting, Postgres ledger, and settlement placeholders.

Out of scope here: PaperShare contract, Crossroads routing/swap/bridge, final
token delivery.

## Runtime

```text
user host
  drip
    -> writes payout intent
    -> starts bundled XMRig
    -> connects to gate :3333

TEE / local Docker shape
  gate :3333
    -> validates worker token against Postgres
    -> rewrites miner password for internal proxy
    -> rejects duplicate/stale/unknown shares
    -> forwards Stratum to xmrig-proxy :3334
    -> exposes worker stats on :8082

  xmrig-proxy :3334
    -> internal only
    -> upstream HashVault Monero pool over TLS

  backend :8081
    -> enroll
    -> payout intent
    -> status/live/SSE/leaderboard
    -> collector loop
    -> settlement request queue

  postgres
    -> users/workers/intents/snapshots/ledger/credits/settlements
```

Docker is only the local/CI process harness. It mirrors the TEE deployment
boundary: public gate TCP, public backend HTTPS, private proxy/gate/backend/DB
links, persistent Postgres volume.

## Product Entry

```bash
drip <chain> <token> <recipient-address>
```

Example:

```bash
drip base-sepolia eth 0x1111111111111111111111111111111111111111
```

Current dev commands:

```bash
drip enroll --name alice --machine-label local1
drip request base-sepolia eth 0x1111111111111111111111111111111111111111
drip start --threads 1
drip status
drip stop
```

`drip <chain> <token> <address>` creates/updates the active payout intent.
Mining starts only through explicit `drip start` or the combined path once wired.

Local files:

```text
$DRIP_HOME/config.json
$DRIP_HOME/xmrig-config.json
$DRIP_HOME/xmrig.pid
$DRIP_HOME/xmrig.log
```

XMRig lookup order:

```text
--xmrig-path
DRIP_XMRIG_PATH
XPOOL_XMRIG_PATH
release asset next to drip
cli/third_party/xmrig/<platform>/
PATH xmrig
```

## API

```text
GET  /health
POST /api/enroll
POST /api/payout-intents
GET  /api/leaderboard
GET  /api/workers/{worker_id}/live
GET  /api/workers/{worker_id}/live/events
```

Worker live endpoints require:

```text
Authorization: Bearer <worker_token>
```

Do not expose payout recipient/status via unauthenticated worker IDs.

## Gate Contract

The gate is the accounting/security boundary. Do not account directly from stock
XMRig Proxy counters.

Implemented policy:

```text
worker_name + worker_token auth against Postgres
shared upstream proxy password hidden from clients
duplicate share rejected on same connection
duplicate share rejected across connections
duplicate nonce rejected even if result changes
unknown job rejected
previous same-height job allowed only <= 1000ms
previous different-height job rejected
```

Current limitation:

```text
accepted-share accounting follows the gate/proxy accepted response path
raw RandomX share verification is not implemented yet
sampled light-mode verification needs raw share capture first
```

## Accounting

Collector input:

```text
GET gate:8082/1/workers
```

Delta:

```text
accepted_delta = current_accepted - previous_accepted
points = accepted_delta
paper_share_amount = accepted_delta * PAPER_SHARE_DIFFICULTY
default PAPER_SHARE_DIFFICULTY = 10000
```

On positive delta:

```text
insert worker_stat_snapshots
upsert live_worker_stats
insert point_ledger
insert paper_share_credits
insert settlement_requests
```

HashVault pays our Monero wallet. User-facing value exits through PaperShare /
Crossroads, not direct Monero payouts.

## Tables

```text
users
  id
  display_name

workers
  id
  user_id
  worker_name unique, backend-generated
  token_hash
  machine_label

payout_intents
  user_id
  worker_id nullable
  target_chain
  target_token
  recipient_address
  receive_pool_token
  status = active | paused | completed | cancelled

worker_stat_snapshots
  worker_id
  accepted/rejected/invalid shares
  total_hashes
  hashrates
  raw

point_ledger
  user_id
  worker_id
  points
  accepted_share_delta
  hash_delta

paper_share_credits
  user_id
  worker_id
  payout_intent_id
  ledger_id
  amount
  status = pending_settlement | settled | failed | reversed

settlement_requests
  paper_share_credit_id
  user_id
  payout_intent_id
  amount
  target_chain
  target_token
  recipient_address
  idempotency_key unique
  adapter
  status = pending | processing | submitted | confirmed | failed | replaced
  tx_hash
  error
  claimed_by
  claim_expires_at
```

## Settlement Adapter Boundary

Backend currently stops at `settlement_requests.status = pending`.

Adapter claim pattern:

```sql
BEGIN;
SELECT *
FROM settlement_requests
WHERE status = 'pending'
   OR (status = 'processing' AND claim_expires_at < now())
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;

UPDATE settlement_requests
SET status = 'processing',
    adapter = 'crossroads',
    claimed_by = $adapter_id,
    claim_expires_at = now() + interval '5 minutes'
WHERE id = $id;
COMMIT;
```

Adapter responsibilities:

```text
submit contract/Crossroads action with idempotency_key
set submitted + tx_hash after broadcast
set confirmed after finality
set failed with error on terminal failure
set paper_share_credits.status = settled only after confirmed
```

Detailed contract handoff: `docs/crossroads-contract-integration.md`.

## Local Runbook

```bash
cp .env.example .env
# set HASHVAULT_WALLET_ADDRESS

docker compose -f infra/docker-compose.yml build backend xmrig-proxy
docker compose -f infra/docker-compose.yml up -d postgres xmrig-proxy gate backend

docker compose -f infra/docker-compose.yml cp backend/migrations/0001_init.sql postgres:/tmp/0001_init.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0001_init.sql
docker compose -f infra/docker-compose.yml cp backend/migrations/0002_payout_settlement.sql postgres:/tmp/0002_payout_settlement.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0002_payout_settlement.sql
docker compose -f infra/docker-compose.yml cp backend/migrations/0003_settlement_claims.sql postgres:/tmp/0003_settlement_claims.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0003_settlement_claims.sql
```

CLI smoke:

```bash
export DRIP_HOME=/private/tmp/drip-demo
export DRIP_API_BASE_URL=http://127.0.0.1:8081

cargo run -p xpool-cli -- enroll --name alice --machine-label local1
cargo run -p xpool-cli -- request base-sepolia eth 0x1111111111111111111111111111111111111111
cargo run -p xpool-cli -- start --threads 1
cargo run -p xpool-cli -- status
cargo run -p xpool-cli -- stop
```

Observe:

```bash
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8082/1/workers

docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U xpool -d xpool \
  -c 'SELECT amount, target_chain, target_token, recipient_address, status, adapter FROM settlement_requests ORDER BY created_at DESC LIMIT 10;'
```

## Packaging

XMRig package source:

```text
repo:   xmrig/xmrig
tag:    v6.26.0
commit: b2ca72480c58d197e18c885d9fc1a0c8d517e60a
patch:  cli/third_party/xmrig/patches/disable-donation.patch
```

Workflows:

```text
.github/workflows/package-xmrig.yml
.github/workflows/package-drip.yml
```

Scripts:

```bash
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-xmrig.sh
DRIP_XMRIG_PLATFORM=darwin-arm64 scripts/package-drip.sh
scripts/verify-linux-package.sh dist/drip-linux-amd64.tar.gz
scripts/sign-notarize-macos.sh dist/drip-darwin-arm64.tar.gz
```

Linux package is dynamically linked and validated in clean `ubuntu:24.04`.
Static XMRig is optional future portability work.

macOS signing/notarization is wired but requires Apple Developer secrets:

```text
DRIP_MACOS_CODESIGN_IDENTITY
DRIP_MACOS_NOTARY_KEYCHAIN_PROFILE
or DRIP_MACOS_NOTARY_APPLE_ID / TEAM_ID / PASSWORD
optional DRIP_MACOS_INSTALLER_IDENTITY
```

## Verified

```text
cargo test --workspace
package-drip workflow: darwin-arm64, linux-amd64
package-xmrig workflow: darwin-arm64, linux-amd64
scripts/verify-linux-package.sh inside ubuntu:24.04
scripts/sign-notarize-macos.sh skip path without Apple credentials
```

## Open Work

```text
TEE
  package ROFL image
  verify raw TCP ingress on :3333
  define Postgres persistence/backup policy

integration
  replace settlement placeholder with Crossroads/contract adapter
  run production E2E:
    drip -> gate -> proxy -> HashVault -> credit -> settlement_request

accounting hardening
  capture raw shares
  add sampled light-mode RandomX verification if required

release
  configure Apple signing/notary secrets
  decide Windows and Intel macOS support
```
