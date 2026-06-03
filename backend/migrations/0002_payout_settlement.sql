CREATE TABLE IF NOT EXISTS payout_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id UUID REFERENCES workers(id) ON DELETE SET NULL,
  target_chain TEXT NOT NULL,
  target_token TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  receive_pool_token BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_share_credits (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  payout_intent_id UUID NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  point_ledger_id BIGINT NOT NULL UNIQUE REFERENCES point_ledger(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending_settlement' CHECK (status IN ('pending_settlement', 'settled', 'failed', 'reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settlement_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_share_credit_id BIGINT NOT NULL UNIQUE REFERENCES paper_share_credits(id) ON DELETE CASCADE,
  payout_intent_id UUID NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK (amount > 0),
  target_chain TEXT NOT NULL,
  target_token TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL DEFAULT 'placeholder',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'replaced')),
  tx_hash TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_intents_user_status ON payout_intents(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_intents_worker_status ON payout_intents(worker_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_share_credits_intent_time ON paper_share_credits(payout_intent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_requests_status_time ON settlement_requests(status, created_at DESC);
