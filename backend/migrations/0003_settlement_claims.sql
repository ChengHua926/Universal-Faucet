ALTER TABLE settlement_requests
  DROP CONSTRAINT IF EXISTS settlement_requests_status_check;

ALTER TABLE settlement_requests
  ADD CONSTRAINT settlement_requests_status_check
  CHECK (status IN ('pending', 'processing', 'submitted', 'confirmed', 'failed', 'replaced'));

ALTER TABLE settlement_requests
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_settlement_requests_claimable
  ON settlement_requests(status, claim_expires_at, created_at);
