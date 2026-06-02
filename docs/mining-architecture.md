# Mining Pool Architecture Handoff

Read this file first. It captures the current architecture decisions for the
hackathon prototype and should be enough context for a coding agent to start.

## Product Goal

Build `xpool`: a CLI-driven Monero mining points pool.

Users run:

```text
xpool enroll
xpool start --threads 2
xpool pause
xpool resume
xpool status
xpool leaderboard
```

The CLI starts bundled XMRig on the user's machine. The user never manually
runs XMRig. The app does not need to perform real XMR payouts to users. It
credits internal points from real share/hash data.

## Current Architecture Decision

Use an upstream mining pool, not a self-hosted Monero node and not custom block
assembly.

```text
User laptop
└── xpool CLI
    ├── enrolls with ROFL API
    ├── stores worker credentials locally
    └── starts bundled XMRig
        └── connects to ROFL Stratum port :3333

ROFL TEE
├── Rust API/backend
│   ├── public API ingress
│   ├── enrolls users and workers
│   ├── serves status and leaderboard
│   ├── exposes realtime progress
│   └── runs collector and accounting tasks
│
├── XMRig Proxy
│   ├── accepts user miners on :3333
│   ├── tags miners by rig-id / worker id
│   ├── exposes local stats API on 127.0.0.1:8080
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
    └── point_ledger

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
  -> reads proxy per-worker counters
  -> computes deltas
  -> writes internal points
```

Users are not racing to finish a deterministic task. Mining is a probabilistic
hash search. Every hash is a lottery ticket. Low-difficulty shares prove work to
the proxy; rare high-quality shares count upstream to the pool; even rarer
network-valid blocks are handled by the pool.

The app is not a pool payout engine. It is an internal points system over real
worker share data.

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
Internal user attribution is handled by XMRig Proxy `/1/workers`.

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
and `rig-id`:

```text
user   = w_<random_id>
rig-id = w_<random_id>
pass   = shared proxy password for MVP
```

Empirical result from local XMRig Proxy v6.26.0: `/1/workers` attributes rows by
`rig-id`, so `rig-id` is the collector's canonical worker lookup key.

The worker token is currently for backend API calls. Stock XMRig Proxy does not
perform DB-backed per-worker token validation. For the MVP, use a shared proxy
password plus unguessable worker names. Do not use friendly names like
`alice.macbook1` as production worker IDs.

## Proxy Stats API

The collector must poll:

```text
GET http://127.0.0.1:8080/1/workers
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

## Points Model

MVP:

```text
paper_share_difficulty = XMRig Proxy --custom-diff
points = accepted_share_delta * paper_share_difficulty
```

Current local default:

```text
paper_share_difficulty = 10000
1 accepted share = 10000 internal points
```

This is still an internal points system, not a payout engine. Paper-share
points measure expected work better than raw accepted-share counts. Store hash
deltas too so the scoring model can be audited or changed later.

Alternative later:

```text
points = hash_delta
```

Recommended DB behavior:

```text
collector poll every 1-2 seconds:
  fetch /1/workers
  match row[0] to workers.worker_name
  read previous live_worker_stats
  accepted_delta = current_accepted - previous_accepted
  hash_delta = current_hashes - previous_hashes
  points = accepted_delta * PAPER_SHARE_DIFFICULTY
  upsert live_worker_stats
  insert worker_stat_snapshots periodically
  insert point_ledger if accepted_delta > 0
```

For realtime progress:

```text
live_worker_stats = current source for status UI
point_ledger = append-only source for leaderboard truth
SSE/WebSocket = push latest live state to connected clients
```

For 100 workers, Postgres is fine. 100 miners connect to XMRig Proxy, not
Postgres. The Rust backend should use a small Postgres pool, e.g. 10-20
connections.

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
├── local xpool CLI
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
http://127.0.0.1:8081/api/leaderboard
127.0.0.1:3333 for local XMRig workers
127.0.0.1:15432 for local Postgres access
http://127.0.0.1:8080/1/workers for local proxy debugging
```

Current local startup:

```bash
cp .env.example .env
# Set HASHVAULT_WALLET_ADDRESS in .env.

docker compose -f infra/docker-compose.yml build backend xmrig-proxy
docker compose -f infra/docker-compose.yml up -d postgres backend xmrig-proxy

docker compose -f infra/docker-compose.yml cp backend/migrations/0001_init.sql postgres:/tmp/0001_init.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0001_init.sql

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
  -p test \
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
   alice.local1
   bob.local1
   charlie.local1
4. Local tests mine through local proxy to HashVault test wallet/account.
5. Shared integration tests assert /1/workers parsing and DB point deltas.
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
```

Need to test next:

```text
1. two workers -> proxy -> HashVault
2. /1/workers shows separate local counters
3. HashVault wallet API continues showing proxy wallet/account active
4. status and realtime endpoints read live_worker_stats
```

## Suggested Repo Layout

```text
cli/
  Cargo.toml
  src/
    main.rs
    commands/
    xmrig.rs
    config.rs
    api.rs

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
1. Build local Docker Compose: Postgres + backend + XMRig Proxy.
2. Configure XMRig Proxy upstream to HashVault.
3. Implement Rust backend health/config and DB migrations.
4. Implement /api/enroll and worker credential storage.
5. Implement collector for /1/workers parsing and point deltas.
6. Implement status, leaderboard, and realtime SSE.
7. Implement Rust CLI enroll/start/stop/status/leaderboard.
8. Run Alice/Bob local integration test through HashVault.
9. Package ROFL container with backend + proxy + Postgres.
10. Deploy to ROFL large instance.
11. Add RandomX light-mode verification only after raw-share access is designed.
```

## Open Risks

```text
HashVault upstream has been smoke-tested with one worker.
Two-worker HashVault test still needs to run through Docker Compose.
ROFL raw TCP passthrough for Stratum must be verified.
Postgres-in-TEE persistence/backup story must be decided.
Raw share capture is not available from /1/workers.
RandomX light-mode verifier requires raw shares, not just aggregate counters.
Proxy-level worker authentication may be weak; worker IDs should be unguessable.
```
