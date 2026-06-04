# Universal Faucet Mining Architecture Handoff

Read this file first. It captures the current architecture decisions for the
mining/CLI component and should be enough context for a coding agent to start.
For the contract/Crossroads handoff contract, read
`docs/crossroads-contract-integration.md`.

## Product Goal

Build the mining component for a universal proof-of-work faucet.

Users install one CLI, `drip`, and request a destination chain/token/address:

```text
drip base-sepolia eth 0x1111111111111111111111111111111111111111
drip status
drip stop
```

Current development CLI shape:

```text
drip enroll --name alice --machine-label local1
drip base-sepolia eth 0x1111111111111111111111111111111111111111
drip start --threads 1
drip status
drip stop
```

`drip request <chain> <token> <recipient-address>` remains available as an
explicit compatibility command.

The CLI starts managed/bundled XMRig on the user's machine. The user never
manually installs or runs XMRig. Accepted RandomX mining work becomes internal
PaperShare credit. A future contract/Crossroads adapter settles that credit into
the user's requested chain/token/address.

Current repository scope:

```text
owned here:
  CLI
  managed XMRig process lifecycle
  Stratum Gate
  XMRig Proxy integration
  upstream RandomX/Monero pool integration
  backend accounting
  Postgres ledger
  placeholder settlement boundary

owned by other teammates:
  PaperShare/mining-pool-token smart contract
  Crossroads swap/bridge/payout layer
```

## Current Architecture Decision

Use an upstream mining pool, not a self-hosted Monero node and not custom block
assembly.

```text
User laptop
└── drip CLI
    ├── enrolls with backend API
    ├── creates payout intent: target chain/token/address
    ├── stores worker credentials locally
    └── starts managed XMRig
        └── connects to ROFL Stratum gate :3333

ROFL TEE
├── Rust API/backend
│   ├── public API ingress
│   ├── enrolls users and workers
│   ├── stores payout intents
│   ├── serves status and leaderboard
│   ├── exposes realtime progress
│   ├── runs collector and accounting tasks
│   └── queues placeholder settlement requests
│
├── xpool-gate
│   ├── accepts user miners on :3333
│   ├── validates worker_name + worker_token against Postgres
│   ├── rejects duplicate shares globally
│   ├── rejects stale shares except previous same-height jobs <= 1000ms
│   ├── rewrites miner password to internal proxy password
│   ├── forwards accepted submits to XMRig Proxy
│   └── exposes accounting stats API on 127.0.0.1:8082
│
├── XMRig Proxy
│   ├── accepts only internal gate miners on :3334
│   └── connects upstream to HashVault pool stratum
│
├── Optional RandomX verifier
│   ├── uses light mode for low memory
│   ├── verifies sampled raw shares if raw shares are available
│   └── marks points confirmed/reversed
│
└── Postgres
    ├── users
    ├── workers
    ├── mining_sessions
    ├── worker_stat_snapshots
    ├── live_worker_stats
    ├── point_ledger
    ├── payout_intents
    ├── paper_share_credits
    └── settlement_requests

External teammate systems
└── Crossroads / PaperShare contracts
    ├── consume settlement request intent later
    ├── mint/credit/redeem mining-pool-token value
    └── route value to requested chain/token/address

External upstream
└── HashVault Monero pool
    ├── gives mining jobs to XMRig Proxy
    ├── validates submitted upstream shares
    ├── handles block templates and node connectivity
    ├── handles pool accounting and payout threshold
    └── exposes pool/wallet stats API
```

No self-hosted `monerod` is planned. If we use HashVault as upstream, HashVault
and its infrastructure handle node connectivity, block templates, block
submission, and payout mechanics.

## Stack

```text
CLI:              Rust
Backend/API:      Rust, axum, tokio
DB:               Postgres inside ROFL TEE
DB access:        sqlx
Migrations:       sqlx migrate or refinery
Mining engine:    bundled XMRig on user machines
Mining gateway:   XMRig Proxy inside ROFL TEE
Upstream:         HashVault Monero pool
TEE runtime:      Oasis ROFL on Sapphire / TDX
Realtime:         SSE first, WebSocket optional later
```

Do not use Drizzle unless backend switches back to TypeScript. Current decision
is Rust backend.

## First-Principles Mining Model

```text
HashVault pool
  -> creates Monero mining jobs from its own nodes
  -> sends jobs over Stratum to XMRig Proxy

XMRig Proxy
  -> forwards jobs to user XMRig workers
  -> accepts low-difficulty worker shares
  -> counts per-worker accepted/rejected/invalid shares
  -> forwards qualifying upstream shares to HashVault

User XMRig
  -> changes nonces
  -> computes RandomX hashes
  -> submits shares when hash target is met

Backend collector
  -> reads gate per-worker counters
  -> computes deltas
  -> writes PaperShare credit and placeholder settlement requests
```

Users are not racing to finish a deterministic task. Mining is a probabilistic
hash search. Every hash is a lottery ticket. Low-difficulty shares prove work to
the proxy; rare high-quality shares count upstream to the pool; even rarer
network-valid blocks are handled by the pool.

This component is not the Crossroads swap/bridge implementation. It is the
mining and accounting source of truth. Its job is to convert real worker share
data into auditable PaperShare credit and settlement requests that another
component can execute on chain.

## HashVault Integration

HashVault API base:

```text
https://api.hashvault.pro/v3/monero
```

Useful endpoints:

```text
GET /
GET /wallet/{address}/stats?workers=true&chart=true&period=daily&inactivityThreshold=10
```

Expected upstream Stratum target:

```text
pool.hashvault.pro:443
TLS enabled
```

Proxy command shape:

```bash
xmrig-proxy \
  -o pool.hashvault.pro:443 \
  --tls \
  --coin monero \
  -u <MAINNET_XMR_WALLET_OR_HASHVAULT_ACCOUNT> \
  -p x \
  --bind 0.0.0.0:3333 \
  --mode simple \
  --custom-diff 10000 \
  --custom-diff-stats \
  --http-host 127.0.0.1 \
  --http-port 8080 \
  --http-access-token <secret>
```

Do not pass `--daemon` in HashVault pool mode. `--daemon` was only for direct
Monero node RPC mode.

Empirical HashVault test result:

```text
Date: 2026-06-02
Proxy: XMRig Proxy v6.26.0
Miner: XMRig v6.26.0
Upstream: pool.hashvault.pro:443 TLS
Local worker: hashvault.local1
Result:
  XMRig received mainnet RandomX jobs from HashVault through the proxy.
  XMRig submitted accepted local proxy shares at custom diff 10000.
  /1/workers showed hashvault.local1 with accepted shares and total hashes.
  HashVault wallet API showed activeMiners: 1 and offline: false.
  HashVault assigned upstream difficulty around 2160446 in this run.
```

HashVault may not show valid upstream shares quickly with one CPU thread because
upstream difficulty can be much higher than the proxy's internal custom
difficulty. This is acceptable. Internal points come from XMRig Proxy
per-worker counters, while HashVault confirms the proxy/pool connection.

HashVault sees the proxy/wallet/account level, not every internal user worker.
Internal user attribution is handled by xpool-gate `/1/workers`.

## Worker Identity

The backend generates canonical worker identity. Do not derive identity from a
terminal session or hardware/device ID.

Recommended:

```text
worker_id = UUID/ULID stored in DB
worker_name = unguessable backend-generated public worker key
worker_token = secret returned once to CLI
display_name = user-facing name, not used as mining identity
machine_label = user-facing device label, not used as mining identity
```

The CLI should pass the backend-generated worker key to XMRig as both `user`
and `rig-id`, and pass the backend-generated worker token as `pass`:

```text
user   = w_<random_id>
rig-id = w_<random_id>
pass   = worker_token
```

The gate rewrites `pass` to the internal XMRig Proxy shared password before
forwarding login upstream. The shared proxy password must not be returned to or
stored by the CLI.

Do not use friendly names like `alice.macbook1` as production worker IDs.

## Proxy Stats API

The collector must poll xpool-gate:

```text
GET http://127.0.0.1:8082/1/workers
Authorization: Bearer <token>
```

Do not use `/workers.json`; it returned `404` in XMRig Proxy v6.26.0.

Run proxy with:

```text
--custom-diff-stats
```

Without `--custom-diff-stats`, local XMRig workers can show accepted shares
while proxy API counters remain zero.

Observed worker row shape from v6.26.0:

```json
[
  "alice.macbook1",
  "127.0.0.1",
  1,
  44,
  0,
  0,
  44000,
  1780428243786,
  0.51,
  0.07,
  0.01,
  0.0,
  0.0
]
```

Interpretation used for MVP:

```text
index 0 = worker name / rig-id
index 3 = accepted shares
index 4 = rejected shares
index 5 = invalid shares
index 6 = total hashes
index 7 = last share timestamp
later indexes = hashrate windows
```

The collector should store the full raw row as JSON as well as parsed fields.

## RandomX Verification Policy

MVP decision: use option 3 first. Trust XMRig Proxy accepted-share counters
inside the ROFL TEE as confirmed internal points. Do not independently verify
raw RandomX shares in the first implementation.

Future direction: if raw-share verification is added, use RandomX light mode
inside the TEE.

RandomX fast mode needs about 2080 MiB shared memory. Light mode needs about
256 MiB shared memory and is much slower, but produces the same results and is
appropriate for proof verification rather than mining.

Important implementation caveat:

```text
Stock XMRig Proxy exposes aggregate worker counters.
It does not expose every raw submitted share through /1/workers.
```

Independent Rust RandomX verification still requires one of:

```text
1. Patch XMRig Proxy to emit raw shares to the backend/verifier.
2. Build a custom Rust Stratum ingress/gate that receives raw shares.
3. Keep trusting XMRig Proxy counters inside the TEE.
```

Approved hackathon order:

```text
Phase 1:
  Trust XMRig Proxy counters inside ROFL TEE.
  Store paper-share deltas as confirmed internal points.
  Do not implement RandomX share verification yet.

Phase 2:
  Add raw-share capture.
  Verify first N shares per worker with RandomX light mode.
  Then verify sampled shares, e.g. 1 in 5.
  Maintain pending/confirmed/reversed point states.
```

If sampling is implemented:

```text
first 5 shares per worker: verify 100%
afterward: verify random 20%
invalid sample: freeze worker, verify recent pending buffer, reverse bad points
```

Do not use sampling as a substitute for reasonable share difficulty. Tuning
`--custom-diff` is the main way to control share volume.

## PaperShare Accounting Model

Current scoring:

```text
paper_share_difficulty = XMRig Proxy --custom-diff
paper_share_amount = accepted_share_delta * paper_share_difficulty
```

Current local default:

```text
paper_share_difficulty = 10000
1 accepted share = 10000 PaperShare units
```

`point_ledger` remains for leaderboard compatibility. Production-facing
accounting should treat those values as PaperShare credit, not arbitrary game
points. PaperShare units measure expected work better than raw accepted-share
counts. Store hash deltas too so the scoring model can be audited or changed
later.

Alternative later:

```text
paper_share_amount = hash_delta
```

Recommended DB behavior:

```text
collector poll every 1-2 seconds:
  fetch /1/workers
  match row[0] to workers.worker_name
  read previous live_worker_stats
  accepted_delta = current_accepted - previous_accepted
  hash_delta = current_hashes - previous_hashes
  paper_share_amount = accepted_delta * PAPER_SHARE_DIFFICULTY
  upsert live_worker_stats
  insert worker_stat_snapshots periodically
  insert point_ledger if accepted_delta > 0
  if active payout_intent exists:
    insert paper_share_credits
    insert settlement_requests with adapter = placeholder
```

For realtime progress:

```text
live_worker_stats = current source for status UI
point_ledger = append-only source for leaderboard compatibility
paper_share_credits = contract-facing credit source
settlement_requests = placeholder handoff queue for contract/Crossroads adapter
GET /api/workers/{worker_id}/live = token-authenticated current worker view
GET /api/workers/{worker_id}/live/events = token-authenticated SSE stream
```

For 100 workers, Postgres is fine. 100 miners connect to XMRig Proxy, not
Postgres. The Rust backend should use a small Postgres pool, e.g. 10-20
connections.

## Payout Intent And Settlement Boundary

The current backend owns the placeholder boundary only:

```text
POST /api/payout-intents
  worker_name
  worker_token
  target_chain
  target_token
  recipient_address
  receive_pool_token=false
```

The endpoint authenticates `worker_name + worker_token`, then stores an active
payout intent. When the collector later credits accepted work for that worker,
it writes:

```text
point_ledger
  old leaderboard-compatible ledger

paper_share_credits
  explicit internal mining-pool-token/PaperShare credit

settlement_requests
  placeholder queue item with:
    amount
    target_chain
    target_token
    recipient_address
    idempotency_key
    adapter = placeholder
    status = pending
```

Future contract/Crossroads integration should replace the placeholder adapter,
not the mining/gate/accounting pipeline. Expected status lifecycle:

```text
pending -> processing -> submitted -> confirmed
pending -> failed
processing -> failed
submitted -> confirmed
submitted -> replaced
```

## ROFL TEE Sizing

Given the provided Oasis ROFL offers, use a large TDX instance for the main
prototype if Postgres is inside the TEE.

Recommended:

```text
large
4 vCPU
8 GiB RAM
39.06 GiB storage
```

Reason:

```text
Postgres data + WAL needs disk headroom.
Rust API + collector need memory.
XMRig Proxy needs memory.
RandomX light-mode verifier needs about 256 MiB cache plus overhead.
Docker images and logs consume storage.
Small 1 vCPU / 2 GiB is too tight for Postgres + proxy + API.
Medium 2 vCPU / 4 GiB can work but leaves less safety margin.
```

No Monero blockchain storage is needed because HashVault is the upstream pool.

## Local Testing Strategy For A Team

Docker is for repeatable infrastructure. It does not simulate TDX/ROFL
attestation, but it can reproduce the process layout and networking.

Recommended local dev topology:

```text
docker compose
├── postgres
├── backend
└── xmrig-proxy

host machine
├── local drip CLI
├── local bundled/downloaded XMRig
└── optional second/third XMRig worker terminals
```

Why miners stay on the host:

```text
They represent real user laptops.
They make it easy to test process launch/stop from the CLI.
They avoid Docker CPU/memory quirks while validating UX.
```

Compose should expose:

```text
3333 -> xmrig-proxy Stratum listener
8081 -> backend API
15432 -> postgres only for local dev
```

The proxy API should stay internal to compose in production, but can be exposed
locally for debugging.

Current local Docker ports:

```text
http://127.0.0.1:8081/health
http://127.0.0.1:8081/api/enroll
http://127.0.0.1:8081/api/payout-intents
http://127.0.0.1:8081/api/leaderboard
127.0.0.1:3333 for local XMRig workers
127.0.0.1:15432 for local Postgres access
http://127.0.0.1:8082/1/workers for local gate accounting/debugging
http://127.0.0.1:8080/1/workers for internal proxy debugging only
```

Current local startup:

```bash
cp .env.example .env
# Set HASHVAULT_WALLET_ADDRESS in .env.

docker compose -f infra/docker-compose.yml build backend xmrig-proxy
docker compose -f infra/docker-compose.yml up -d postgres backend xmrig-proxy

docker compose -f infra/docker-compose.yml cp backend/migrations/0001_init.sql postgres:/tmp/0001_init.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0001_init.sql
docker compose -f infra/docker-compose.yml cp backend/migrations/0002_payout_settlement.sql postgres:/tmp/0002_payout_settlement.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0002_payout_settlement.sql
docker compose -f infra/docker-compose.yml cp backend/migrations/0003_settlement_claims.sql postgres:/tmp/0003_settlement_claims.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0003_settlement_claims.sql

curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8081/api/leaderboard
```

Run DB-backed Rust tests against the local Postgres container:

```bash
XPOOL_TEST_DATABASE_URL='postgres://xpool:xpool@127.0.0.1:15432/xpool?sslmode=disable' \
  cargo test -p xpool-backend --test enroll --test collector --test leaderboard
```

Run one host miner against the Dockerized proxy:

```bash
xmrig \
  -o 127.0.0.1:3333 \
  -u local-worker-1 \
  -p xpool-dev \
  --rig-id local-worker-1 \
  -t 1 \
  --coin monero
```

Stop the host miner after the test. The proxy may retain a disconnected worker
row with `connections = 0` and the latest counters. The collector must not treat
row presence as proof of current mining.

Team workflow:

```text
1. Everyone runs the same docker compose stack.
2. Everyone uses the same pinned XMRig/XMRig Proxy versions.
3. Each developer uses a unique local worker name:
   manual tests: enroll first, then use backend-generated w_<random_id>
   CLI tests: backend-generated w_<random_id>
4. Manual miners connect to the gate with:
   user = backend-generated worker_name
   pass = backend-generated worker_token
5. The gate rewrites `pass` to XMRIG_PROXY_WORKER_PASSWORD before forwarding
   to the internal XMRig Proxy.
6. Local tests mine through gate -> local proxy -> HashVault test wallet/account.
7. Shared integration tests assert gate /1/workers parsing and DB point deltas.
```

## Local Test Cases

Already proven locally with XMRig Proxy v6.26.0 against a public stagenet node:

```text
one worker -> proxy -> node:
  accepted shares increased
  /1/workers exposed accepted shares with --custom-diff-stats

two workers -> proxy -> node:
  alice.macbook1 and bob.macbook1 appeared as separate rows
  accepted share counters moved independently
```

Already proven locally with XMRig Proxy v6.26.0 against HashVault:

```text
one worker -> proxy -> HashVault:
  proxy connected to pool.hashvault.pro:443 over TLS
  miner received mainnet RandomX jobs
  miner submitted accepted local proxy shares
  /1/workers exposed accepted shares with --custom-diff-stats
  HashVault wallet API showed activeMiners: 1 and offline: false
```

Already proven locally with Docker Compose:

```text
postgres container:
  Postgres 16 started with persistent docker volume
  migration 0001_init.sql applied cleanly

backend container:
  /health returned ok
  /api/enroll created user + worker and returned one-time token
  /api/leaderboard returned ranked point totals from Postgres
  collector loop polled xmrig-proxy /1/workers and credited point deltas

xmrig-proxy container:
  connected upstream to pool.hashvault.pro:443 over TLS
  host XMRig worker connected through 127.0.0.1:3333
  /1/workers exposed worker row, accepted shares, and total hashes
  after miner stopped, worker row remained with connections = 0

live collector validation:
  enrolled backend worker docker.local1
  proxy had retained docker.local1 row with 8 accepted shares
  collector credited docker with 8 leaderboard shares

paper-share validation:
  enrolled backend worker w_32e47f31771c457f96a19e617421a327
  proxy reported 4 accepted shares at custom diff 10000
  backend leaderboard reported paperdemo with 40000 points and 4 accepted shares

CLI-managed mining validation:
  drip enroll created worker w_703c2ba8230742ca9737b1e335a350f8
  drip start launched host XMRig with 1 thread against 127.0.0.1:3333
  proxy /1/workers reported 39 accepted shares for that worker
  backend leaderboard reported clidemo2 with 390000 points and 39 shares
  drip leaderboard printed the same paper-share totals
  drip stop terminated the host XMRig process
```

Need to test next:

```text
1. create payout_intent through CLI-facing API
2. accepted mining work inserts paper_share_credits and settlement_requests
3. two workers -> gate -> proxy -> HashVault
4. /1/workers shows separate local counters
5. HashVault wallet API continues showing proxy wallet/account active
6. status and realtime endpoints read live_worker_stats
7. package the CLI with pinned XMRig binaries per platform
```

## Suggested Repo Layout

```text
cli/
  Cargo.toml
  src/
    main.rs
    commands.rs
    xmrig.rs
    config.rs
    api.rs
  tests/

backend/
  Cargo.toml
  migrations/
  src/
    main.rs
    config.rs
    routes/
    db/
    collector/
    proxy/
    realtime/
    verifier/

infra/
  docker-compose.yml
  rofl/
    rofl.yaml
    Dockerfile
  systemd/

third_party/
  xmrig/
  xmrig-proxy/

docs/
  mining-architecture.md
```

## Implementation Order

Recommended order:

```text
1. Build local Docker Compose: Postgres + backend + XMRig Proxy. DONE
2. Configure XMRig Proxy upstream to HashVault. DONE
3. Implement Rust backend health/config and DB migrations. DONE
4. Implement /api/enroll and worker credential storage. DONE
5. Implement collector for /1/workers parsing and point deltas. DONE
6. Implement leaderboard. DONE
7. Implement Rust CLI enroll/start/stop/status/leaderboard. DONE for MVP
8. Add payout_intents + PaperShare credit + placeholder settlements. DONE
9. Productize CLI from xpool mining UX toward drip faucet UX. DONE:
   user-facing binary is now drip; internal crate names still use xpool.
10. Package CLI with pinned XMRig binaries per platform. IN PROGRESS:
    macOS arm64 is bundled from source with donation disabled; macOS arm64 and
    Linux amd64 drip archives are buildable through packaging workflows; macOS
    amd64 is deferred because GitHub-hosted Intel macOS runner availability can
    keep jobs queued; Windows amd64 still needs native dependency packaging
    before release.
11. Run end-to-end faucet-component test:
    CLI payout intent -> mining -> PaperShare credit -> placeholder settlement.
12. Run Alice/Bob local integration test through HashVault.
13. Implement backend status endpoint over live_worker_stats. DONE:
    `GET /api/workers/{worker_id}/live` requires `Authorization: Bearer
    <worker_token>` and returns live shares, hashes, paper-share totals, active
    payout intent, and settlement summary.
14. Implement realtime SSE over live_worker_stats. DONE:
    `GET /api/workers/{worker_id}/live/events` requires `Authorization: Bearer
    <worker_token>` and emits `worker.live` events with the same JSON shape as
    the live status endpoint.
15. Package ROFL container with backend + proxy + Postgres.
16. Deploy to ROFL large instance.
17. Add RandomX light-mode verification only after raw-share access is designed.
```

## Open Risks

```text
HashVault upstream has been smoke-tested with one worker.
Two-worker HashVault test still needs to run through Docker Compose.
ROFL raw TCP passthrough for Stratum must be verified.
Postgres-in-TEE persistence/backup story must be decided.
Raw share capture is not available from /1/workers.
RandomX light-mode verifier requires raw shares, not just aggregate counters.
CLI resolves explicit `--xmrig-path`, `DRIP_XMRIG_PATH`, legacy
`XPOOL_XMRIG_PATH`, release-archive assets next to the drip executable,
repo-checkout bundled platform assets, then `xmrig` on `PATH`.
Current bundled asset: `cli/third_party/xmrig/darwin-arm64/xmrig`, source-built
from `xmrig/xmrig` v6.26.0 commit `b2ca72480c58d197e18c885d9fc1a0c8d517e60a`
with `patches/disable-donation.patch`.
Official prebuilt XMRig keeps the default donation behavior; production drip
must use source-built binaries and keep GPL distribution obligations explicit.
XMRig packages write `BUILDINFO` with source commit, donation patch status, and
`ldd`/`otool` runtime dependency output. Linux release archives are pre-release
until those dependencies are validated on a clean supported distro or the miner
is switched to static linking.
Current linux-amd64 CI output links dynamically to OpenSSL 3 and glibc-family
system libraries: `libssl.so.3`, `libcrypto.so.3`, `libm.so.6`, `libc.so.6`,
and `/lib64/ld-linux-x86-64.so.2`.
Contract/Crossroads settlement is a placeholder adapter in this repo.
Live worker status is token-authenticated; do not expose payout/recipient state
through unauthenticated worker IDs.
Realtime progress is SSE first; WebSocket is optional only if the frontend later
needs bidirectional controls.
```
