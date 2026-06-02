# XPool Mining Points Prototype

CLI-driven Monero mining points pool prototype.

Current mode:

```text
user XMRig -> local/TEE XMRig Proxy -> HashVault Monero pool
backend collector -> XMRig Proxy stats -> Postgres point ledger
```

No user payouts. Points are internal paper-share credits.

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
```

Verify services:

```bash
docker compose -f infra/docker-compose.yml ps
curl -fsS http://127.0.0.1:8081/health | jq .
curl -fsS http://127.0.0.1:8081/api/leaderboard | jq .
curl -fsS -H "Authorization: Bearer devtoken" http://127.0.0.1:8080/1/workers | jq .
```

Ports:

```text
127.0.0.1:8081  backend API
127.0.0.1:3333  XMRig Proxy Stratum listener
127.0.0.1:8080  XMRig Proxy stats API, local debug only
127.0.0.1:15432 Postgres, local debug only
```

Manual miner test without CLI:

```bash
xmrig \
  -o 127.0.0.1:3333 \
  -u manual.local1 \
  -p xpool-dev \
  --rig-id manual.local1 \
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
+-- xpool CLI
    |-- POST /api/enroll
    |-- writes ~/.xpool/*
    +-- starts XMRig
        +-- stratum tcp :3333

local docker / ROFL TEE
|-- backend :8081
|   |-- /api/enroll
|   |-- /api/leaderboard
|   +-- collector loop
|-- xmrig-proxy :3333
|   |-- /1/workers on :8080
|   +-- upstream pool.hashvault.pro:443 TLS
+-- postgres :5432
    |-- users
    |-- workers
    |-- live_worker_stats
    +-- point_ledger
```

Data flow:

```text
enroll
CLI -> backend -> Postgres
CLI <- worker_name + worker_token + proxy password

mine
CLI -> XMRig child process
XMRig -> XMRig Proxy -> HashVault

accounting
backend collector -> XMRig Proxy /1/workers
backend collector -> Postgres snapshots + ledger
leaderboard -> sum(point_ledger)
```

Scoring:

```text
accepted_delta = proxy.current_accepted - db.previous_accepted
points = accepted_delta * PAPER_SHARE_DIFFICULTY
default PAPER_SHARE_DIFFICULTY = 10000
```

Auth model:

```text
backend API token: worker_token, stored hashed in Postgres
proxy auth MVP: shared XMRIG_PROXY_WORKER_PASSWORD
worker identity: backend-generated unguessable w_<random_id>
```

Repo layout:

```text
cli/       Rust CLI + XMRig process manager
backend/   Rust axum API + collector + migrations
infra/     Docker Compose + XMRig Proxy image
docs/      long-form architecture handoff
```

Longer design notes: `docs/mining-architecture.md`.
