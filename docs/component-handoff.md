# Universal Faucet Mining Component Handoff

This is the fast handoff. Read this first, then drill into:

```text
AGENTS.md                                  project guardrails
README.md                                  local commands and packaging
docs/mining-architecture.md                full architecture notes
docs/crossroads-contract-integration.md    contract/Crossroads adapter contract
```

## What This Is

Universal Faucet lets a user spend CPU work instead of money to get testnet or
small onchain assets.

The user installs one CLI:

```bash
drip base-sepolia eth 0x1111111111111111111111111111111111111111
drip start --threads 1
drip status
drip stop
```

The user does not install XMRig. The user does not run a Monero miner manually.
The CLI owns XMRig configuration and process lifecycle.

The mining component converts accepted RandomX work into internal PaperShare
credit. Crossroads/contracts later convert that credit into the chain/token the
user asked for.

## The Product Boundary

```text
owned in this repo
  drip CLI
  managed XMRig packaging and lifecycle
  Stratum Gate
  XMRig Proxy integration
  HashVault upstream mining-pool integration
  backend API and collector
  Postgres accounting ledger
  PaperShare credit records
  placeholder settlement queue

owned by other teams
  PaperShare / mining-pool-token contract
  Crossroads swap and bridge routing
  final token delivery on target chain
```

Do not turn this back into a Monero pool dashboard. Do not expose manual XMRig
setup to users. Do not bypass the Stratum Gate for accounting.

## System Shape

```text
user machine
+-- drip
    +-- enrolls against backend
    +-- stores worker credentials in DRIP_HOME
    +-- records payout intent: chain/token/address
    +-- starts bundled XMRig
        +-- Stratum TCP to gate :3333

local Docker / future ROFL TEE
+-- backend :8081
|   +-- enrolls users/workers
|   +-- stores payout intents
|   +-- serves live status, SSE, leaderboard
|   +-- polls gate stats
|   +-- writes PaperShare credits and settlement requests
|
+-- xpool-gate :3333
|   +-- validates worker_name + worker_token against Postgres
|   +-- rejects duplicate shares globally
|   +-- rejects stale shares except previous same-height jobs <= 1000ms
|   +-- rewrites miner password to internal proxy password
|   +-- forwards accepted submits to XMRig Proxy
|   +-- exposes local stats API on :8082
|
+-- XMRig Proxy :3334
|   +-- accepts only internal gate traffic
|   +-- connects upstream to HashVault Monero pool
|
+-- Postgres
    +-- users, workers
    +-- live_worker_stats, worker_stat_snapshots
    +-- point_ledger
    +-- payout_intents
    +-- paper_share_credits
    +-- settlement_requests

external
+-- HashVault -> our XMR wallet/account -> treasury/redemption process
+-- Crossroads/contracts -> final chain/token/address delivery
```

Docker is used as a local ROFL-shaped deployment harness: same long-running
services, same private ports, same Postgres volume, same TCP Stratum path. It is
not magic; it is a repeatable small VPS/TEE simulation.

## First Principles

Mining is not a task queue where users complete assigned jobs. Mining is a
probabilistic hash search. Every RandomX hash is a lottery ticket.

```text
HashVault creates pool jobs from Monero nodes
XMRig Proxy receives those jobs
gate forwards jobs to user miners
XMRig searches nonces locally
shares prove work at low difficulty
backend converts accepted share deltas into PaperShare credit
```

HashVault handles real Monero pool mechanics: node connectivity, block
templates, upstream share validation, block submission, and pool payouts.

We handle internal attribution: which Universal Faucet worker earned how much
credit.

## User Flow

### Enroll

```bash
drip enroll --name alice --machine-label local1
```

Backend creates:

```text
users row
workers row
worker_name = unguessable backend-generated public key
worker_token = secret returned once, stored hashed in DB
```

CLI stores:

```text
$DRIP_HOME/config.json
```

### Request Asset

```bash
drip base-sepolia eth 0x1111111111111111111111111111111111111111
```

Backend creates:

```text
payout_intents row
target_chain = base-sepolia
target_token = eth
recipient_address = 0x...
receive_pool_token = false by default
status = active
```

`drip request <chain> <token> <address>` still exists as an explicit
compatibility command. The product shape is the direct command.

### Mine

```bash
drip start --threads 1
```

CLI:

```text
resolves bundled XMRig
writes XMRig JSON config
starts XMRig as a visible child process
writes pid/log files
```

XMRig connects to:

```text
gate_host:3333
user = worker_name
pass = worker_token
rig-id = worker_name
```

The gate authenticates that token and rewrites the password before forwarding
to the internal XMRig Proxy. The user never sees the proxy password.

### Observe

```bash
drip status
curl -N -H "authorization: Bearer <worker_token>" \
  "http://127.0.0.1:8081/api/workers/<worker_id>/live/events"
```

`drip status` reports:

```text
local miner process state
accepted/rejected/invalid shares
hashes and hashrate
PaperShare credits
active payout intent
settlement summary
```

SSE emits `worker.live` events with the same JSON shape as
`GET /api/workers/{worker_id}/live`.

## Accounting

The collector polls the gate stats API and computes deltas.

```text
accepted_delta = current_accepted - previous_accepted
points = accepted_delta
paper_share_amount = accepted_delta * PAPER_SHARE_DIFFICULTY
default PAPER_SHARE_DIFFICULTY = 10000
```

For each positive accepted-share delta:

```text
worker_stat_snapshots  append raw observation
live_worker_stats      upsert current worker view
point_ledger           compatibility leaderboard ledger
paper_share_credits    contract-facing credit
settlement_requests    placeholder Crossroads/contract queue
```

`point_ledger` is convenient UI/accounting history. `paper_share_credits` and
`settlement_requests` are the integration boundary.

## Placeholder Settlement

The placeholder is intentional. It lets mining/accounting be built before the
contract and Crossroads path is final.

Current behavior:

```text
active payout intent exists
accepted mining work is credited
backend creates paper_share_credits row
backend creates settlement_requests row
status = pending
adapter = placeholder
```

Future adapter behavior:

```text
claim pending settlement_requests row with SKIP LOCKED
submit PaperShare/Crossroads transaction using idempotency_key
set status = submitted with tx_hash
set status = confirmed after finality
set paper_share_credits.status = settled
```

The adapter must not mutate miner auth, worker stats, point deltas, or CLI
state. It only consumes and updates settlement records.

## Security And Abuse Boundary

The gate exists because stock XMRig Proxy worker counters are not enough for
production accounting.

Gate-owned policy:

```text
worker token auth against Postgres
duplicate share rejection on same connection
duplicate share rejection across connections
duplicate nonce rejection even if result changes
unknown job rejection
previous same-height job accepted only within 1000ms
previous different-height job rejected
```

This does not yet mean we cryptographically verify every RandomX share
ourselves. Raw-share capture and light-mode RandomX verification remain a
separate decision. If credits must be independently auditable rather than
trusted through gate/proxy accepted responses, add raw share capture first.

## Local Development

Create env:

```bash
cp .env.example .env
```

Set:

```text
HASHVAULT_WALLET_ADDRESS=<our pool wallet/account>
```

Start infra:

```bash
docker compose -f infra/docker-compose.yml build backend xmrig-proxy
docker compose -f infra/docker-compose.yml up -d postgres xmrig-proxy gate backend
```

Apply migrations:

```bash
docker compose -f infra/docker-compose.yml cp backend/migrations/0001_init.sql postgres:/tmp/0001_init.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0001_init.sql
docker compose -f infra/docker-compose.yml cp backend/migrations/0002_payout_settlement.sql postgres:/tmp/0002_payout_settlement.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0002_payout_settlement.sql
docker compose -f infra/docker-compose.yml cp backend/migrations/0003_settlement_claims.sql postgres:/tmp/0003_settlement_claims.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0003_settlement_claims.sql
```

Exercise the component:

```bash
export DRIP_HOME=/private/tmp/drip-demo
export DRIP_API_BASE_URL=http://127.0.0.1:8081

cargo run -p xpool-cli -- enroll --name alice --machine-label local1
cargo run -p xpool-cli -- base-sepolia eth 0x1111111111111111111111111111111111111111
cargo run -p xpool-cli -- start --threads 1
cargo run -p xpool-cli -- status
cargo run -p xpool-cli -- stop
```

Inspect settlement handoff:

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U xpool -d xpool \
  -c 'SELECT amount, target_chain, target_token, recipient_address, status, adapter FROM settlement_requests ORDER BY created_at DESC LIMIT 10;'
```

## Release Packaging

XMRig is source-built from official `xmrig/xmrig` `v6.26.0` at commit:

```text
b2ca72480c58d197e18c885d9fc1a0c8d517e60a
```

Donation is disabled by source patch:

```text
cli/third_party/xmrig/patches/disable-donation.patch
```

Artifacts include:

```text
drip
third_party/xmrig/<platform>/xmrig
third_party/xmrig/<platform>/SHA256SUMS
third_party/xmrig/<platform>/BUILDINFO
README.txt
```

CI workflows:

```text
.github/workflows/package-xmrig.yml
.github/workflows/package-drip.yml
```

Both workflows use Node 24-compatible GitHub Actions:

```text
actions/checkout@v6
actions/upload-artifact@v6
```

Linux release hardening:

```bash
scripts/verify-linux-package.sh dist/drip-linux-amd64.tar.gz
```

The supported Linux target is currently clean `ubuntu:24.04` amd64. The
package is dynamically linked and validated there. Static linking remains the
path if we need wider distro compatibility.

macOS release hardening:

```bash
DRIP_MACOS_CODESIGN_IDENTITY="Developer ID Application: <name> (<team>)" \
DRIP_MACOS_NOTARY_KEYCHAIN_PROFILE=drip-notary \
scripts/sign-notarize-macos.sh dist/drip-darwin-arm64.tar.gz
```

The script signs `drip` and bundled XMRig, rewrites checksums, creates a
notarization zip, and submits it when Apple notary credentials exist. A signed
pkg can also be created and stapled when `DRIP_MACOS_INSTALLER_IDENTITY` is
configured.

## Current Verification

Known green checks after the latest hardening:

```text
cargo test --workspace
scripts/verify-linux-package.sh <linux archive>
scripts/sign-notarize-macos.sh <mac archive>  # skip path without credentials
Package drip workflow
Package XMRig workflow
```

Latest verified workflow classes:

```text
Package drip: builds macOS arm64 + Linux amd64 drip archives
Package XMRig: builds macOS arm64 + Linux amd64 source-patched XMRig artifacts
```

## TEE Readiness

The local Docker setup is intentionally TEE-friendly:

```text
one backend service
one gate service with raw TCP ingress
one internal proxy service
one Postgres service with persistent data
private stats ports
explicit env config
no user-managed miner binaries on server
```

The deployment shape maps directly to ROFL:

```text
ROFL public ingress
  :443   backend API
  :3333  Stratum Gate TCP

ROFL private services
  backend -> Postgres
  backend -> gate stats :8082
  gate -> Postgres
  gate -> XMRig Proxy :3334
  XMRig Proxy -> HashVault :443 TLS
```

The main deployment unknown is not architecture. It is ROFL raw TCP ingress and
operational persistence/backups for Postgres in the TEE environment.

## What Is Still Left

```text
must do before production demo
  package ROFL deployment image
  verify raw TCP Stratum ingress on ROFL
  run full production E2E: drip -> gate -> proxy -> HashVault -> credit -> settlement_request

needed for real payouts
  implement contract/Crossroads settlement adapter
  configure treasury/redemption policy for upstream XMR income
  set final PaperShare contract call semantics

release polish
  configure Apple Developer signing/notary secrets
  decide whether Windows packaging matters
  decide whether Intel macOS matters

accounting hardening decision
  decide whether sampled RandomX verification is required
  if yes, add raw share capture before light-mode verifier
```

## One Sentence

`drip` turns local CPU work into auditable PaperShare credit by running bundled
XMRig through our authenticated Stratum Gate; the backend records the credit and
hands settlement intent to Crossroads/contracts without coupling payout logic to
miner accounting.
