CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  machine_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mining_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopped')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ
);

CREATE TABLE live_worker_stats (
  worker_id UUID PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  accepted_shares BIGINT NOT NULL DEFAULT 0,
  rejected_shares BIGINT NOT NULL DEFAULT 0,
  invalid_shares BIGINT NOT NULL DEFAULT 0,
  total_hashes BIGINT NOT NULL DEFAULT 0,
  last_share_timestamp_ms BIGINT,
  hashrate_10s DOUBLE PRECISION,
  hashrate_60s DOUBLE PRECISION,
  hashrate_15m DOUBLE PRECISION,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE worker_stat_snapshots (
  id BIGSERIAL PRIMARY KEY,
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_shares BIGINT NOT NULL DEFAULT 0,
  rejected_shares BIGINT NOT NULL DEFAULT 0,
  invalid_shares BIGINT NOT NULL DEFAULT 0,
  total_hashes BIGINT NOT NULL DEFAULT 0,
  last_share_timestamp_ms BIGINT,
  hashrate_10s DOUBLE PRECISION,
  hashrate_60s DOUBLE PRECISION,
  hashrate_15m DOUBLE PRECISION,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE point_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  points BIGINT NOT NULL,
  accepted_share_delta BIGINT NOT NULL DEFAULT 0,
  hash_delta BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'reversed')),
  source TEXT NOT NULL DEFAULT 'xmrig_proxy',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workers_user_id ON workers(user_id);
CREATE INDEX idx_sessions_worker_id ON mining_sessions(worker_id);
CREATE INDEX idx_snapshots_worker_time ON worker_stat_snapshots(worker_id, observed_at DESC);
CREATE INDEX idx_ledger_user_time ON point_ledger(user_id, created_at DESC);
CREATE INDEX idx_ledger_worker_time ON point_ledger(worker_id, created_at DESC);
