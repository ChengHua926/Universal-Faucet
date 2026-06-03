# Universal Faucet Mining Component

Universal PoW faucet mining/CLI component.

The product is not a user-facing Monero pool. Users install our CLI, likely
`drip`, ask for a destination chain/token/address, and the CLI manages local
RandomX mining. Mining work becomes internal PaperShare credit that a future
contract/Crossroads integration can settle into the requested asset.

Current mode:

```text
user CLI -> managed XMRig -> xpool-gate -> internal XMRig Proxy -> HashVault
backend collector -> xpool-gate stats -> Postgres PaperShare ledger
placeholder settlement queue -> future contract/Crossroads adapter
```

Crossroads and smart contracts are owned by other teammates. This repo owns the
mining pool, CLI, gate, backend accounting, and placeholder integration
boundary.

For the contract/Crossroads handoff, read
[docs/crossroads-contract-integration.md](docs/crossroads-contract-integration.md).

Intended faucet-facing UX:

```bash
drip base-sepolia eth 0x1111111111111111111111111111111111111111
drip status
drip stop
```

Current dev CLI is still named `xpool`.

## CLI

Run from repo root.

Set an isolated CLI home for local tests:

```bash
export XPOOL_HOME=/private/tmp/xpool-demo
export XPOOL_API_BASE_URL=http://127.0.0.1:8081
export XPOOL_XMRIG_PATH=/path/to/xmrig
```

Enroll:

```bash
cargo run -p xpool-cli -- enroll --name alice --machine-label local1
```

Create a faucet payout intent with the CLI:

```bash
cargo run -p xpool-cli -- request base-sepolia eth 0x1111111111111111111111111111111111111111
```

Create a payout intent directly against the backend:

```bash
curl -fsS http://127.0.0.1:8081/api/payout-intents \
  -H 'content-type: application/json' \
  -d '{
    "worker_name": "<worker_name from enroll>",
    "worker_token": "<worker_token from enroll>",
    "target_chain": "base-sepolia",
    "target_token": "eth",
    "recipient_address": "0x1111111111111111111111111111111111111111"
  }' | jq .
```

Start mining:

```bash
cargo run -p xpool-cli -- start --threads 1
```

Observe local miner:

```bash
cargo run -p xpool-cli -- status
tail -f "$XPOOL_HOME/xmrig.log"
jq . "$XPOOL_HOME/xmrig-config.json"
```

Read points:

```bash
cargo run -p xpool-cli -- leaderboard
curl -fsS http://127.0.0.1:8081/api/leaderboard | jq .
```

Inspect placeholder settlement handoff rows:

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U xpool -d xpool \
  -c 'SELECT amount, target_chain, target_token, recipient_address, status, adapter FROM settlement_requests ORDER BY created_at DESC LIMIT 10;'
```

Stop mining:

```bash
cargo run -p xpool-cli -- stop
cargo run -p xpool-cli -- status
```

CLI writes:

```text
$XPOOL_HOME/config.json        backend credentials + proxy settings
$XPOOL_HOME/xmrig-config.json  generated XMRig config
$XPOOL_HOME/xmrig.pid          local XMRig PID
$XPOOL_HOME/xmrig.log          XMRig runtime log
```

Generated XMRig config uses:

```text
user = backend-generated worker_name
pass = backend-generated worker_token
cpu.rx = one -1 affinity entry per requested mining thread
```

The gate validates `worker_token`, then rewrites `pass` to the internal
XMRig Proxy password before forwarding.

Current limitation: the CLI can point at an XMRig binary through `PATH`,
`--xmrig-path`, or `XPOOL_XMRIG_PATH`. Production `drip` must bundle or manage
pinned per-platform XMRig binaries so users install only our CLI.

## Backend And Proxy

Create local env:

```bash
cp .env.example .env
```

Set `HASHVAULT_WALLET_ADDRESS` in `.env`. Without it, Compose intentionally
fails because `xmrig-proxy` needs an upstream pool account/wallet.

Start local infra:

```bash
docker compose -f infra/docker-compose.yml build backend xmrig-proxy
docker compose -f infra/docker-compose.yml up -d postgres backend xmrig-proxy
```

Apply schema:

```bash
docker compose -f infra/docker-compose.yml cp backend/migrations/0001_init.sql postgres:/tmp/0001_init.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0001_init.sql
docker compose -f infra/docker-compose.yml cp backend/migrations/0002_payout_settlement.sql postgres:/tmp/0002_payout_settlement.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0002_payout_settlement.sql
docker compose -f infra/docker-compose.yml cp backend/migrations/0003_settlement_claims.sql postgres:/tmp/0003_settlement_claims.sql
docker compose -f infra/docker-compose.yml exec -T postgres psql -U xpool -d xpool -f /tmp/0003_settlement_claims.sql
```

Verify services:

```bash
docker compose -f infra/docker-compose.yml ps
curl -fsS http://127.0.0.1:8081/health | jq .
curl -fsS http://127.0.0.1:8081/api/leaderboard | jq .
curl -fsS -H "Authorization: Bearer devtoken" http://127.0.0.1:8082/1/workers | jq .
```

API surface owned by this component:

```text
GET  /health
POST /api/enroll
POST /api/payout-intents
GET  /api/leaderboard
```

`/api/payout-intents` is the placeholder Crossroads/contract boundary. It stores
the user-requested target chain, target token, and recipient address. When the
collector credits mined work for that worker, the backend writes:

```text
point_ledger          compatibility leaderboard ledger
paper_share_credits   explicit internal mining-pool-token credit
settlement_requests   pending placeholder for future contract signer/Crossroads
```

Ports:

```text
127.0.0.1:8081  backend API
127.0.0.1:3333  xpool-gate Stratum listener
127.0.0.1:8082  xpool-gate stats API, local debug only
127.0.0.1:8080  internal XMRig Proxy stats API, local debug only
127.0.0.1:15432 Postgres, local debug only
```

Manual miner test without CLI requires a real enrolled `worker_name` and
`worker_token`:

```bash
xmrig \
  -o 127.0.0.1:3333 \
  -u <worker_name> \
  -p <worker_token> \
  --rig-id <worker_name> \
  -t 1 \
  --coin monero
```

Stop the manual miner after the test.

Run verification:

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
XPOOL_TEST_DATABASE_URL='postgres://xpool:xpool@127.0.0.1:15432/xpool?sslmode=disable' \
  cargo test -p xpool-backend --test enroll --test collector --test collector_proxy_poll --test leaderboard
```

## Structure

Runtime topology:

```text
host laptop
+-- drip/xpool CLI
    |-- POST /api/enroll
    |-- POST /api/payout-intents
    |-- writes ~/.xpool/*
    +-- starts managed XMRig
        +-- stratum tcp :3333

local docker / ROFL TEE
|-- backend :8081
|   |-- /api/enroll
|   |-- /api/payout-intents
|   |-- /api/leaderboard
|   +-- collector loop
|-- xpool-gate :3333
|   |-- worker token auth
|   |-- duplicate share rejection
|   |-- stale share policy: same height + <= 1000ms
|   |-- rewrites pass for internal proxy
|   +-- /1/workers on :8082
|-- xmrig-proxy :3334
|   |-- internal only
|   +-- upstream pool.hashvault.pro:443 TLS
+-- postgres :5432
    |-- users
    |-- workers
    |-- live_worker_stats
    |-- point_ledger
    |-- payout_intents
    |-- paper_share_credits
    +-- settlement_requests
```

Data flow:

```text
enroll
CLI -> backend -> Postgres
CLI <- worker_name + worker_token + gate host/port

intent
CLI -> backend -> Postgres payout_intents
CLI <- payout_intent_id + active status

mine
CLI -> XMRig child process
XMRig -> xpool-gate -> XMRig Proxy -> HashVault

accounting
backend collector -> xpool-gate /1/workers
backend collector -> Postgres snapshots + point ledger + PaperShare credit
leaderboard -> sum(point_ledger)

settlement placeholder
PaperShare credit -> settlement_requests row
future contract/Crossroads adapter -> tx_hash/status updates
```

Scoring:

```text
accepted_delta = proxy.current_accepted - db.previous_accepted
paper_share_amount = accepted_delta * PAPER_SHARE_DIFFICULTY
default PAPER_SHARE_DIFFICULTY = 10000
```

Auth model:

```text
backend API token: worker_token, stored hashed in Postgres
gate auth: worker_name + worker_token checked against Postgres
internal proxy auth: shared XMRIG_PROXY_WORKER_PASSWORD, not sent to users
worker identity: backend-generated unguessable w_<random_id>
```

Repo layout:

```text
cli/       Rust CLI + XMRig process manager
backend/   Rust axum API + collector + migrations
gate/      Rust Stratum gate + share policy + gate stats
infra/     Docker Compose + XMRig Proxy image
docs/      long-form architecture handoff
```

Longer design notes: `docs/mining-architecture.md`.
