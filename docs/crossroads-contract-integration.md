# Crossroads And Contract Integration

This document is the integration contract between this repository's mining
component and the external PaperShare contract / Crossroads payout component.

This repository owns:

- user enrollment
- worker authentication
- XMRig process configuration
- Stratum gate accounting
- PaperShare credit calculation
- settlement request queue creation

External teams own:

- PaperShare / mining-pool-token contract
- contract signing or transaction submission
- Crossroads swap/bridge/payout routing
- final target-chain token delivery

## Mental Model

```text
user mines through CLI
  -> gate counts accepted RandomX shares
  -> backend collector converts accepted share deltas into PaperShare credit
  -> backend creates settlement_requests rows
  -> external adapter consumes settlement_requests
  -> external adapter submits contract/Crossroads transaction
  -> external adapter updates settlement status
```

The collector is not a Monero wallet and does not receive Monero payouts.
HashVault/XMRig Proxy use the pool's Monero address upstream. The collector only
does internal accounting from gate worker counters.

## Tables To Consume

### payout_intents

Created when the CLI calls:

```text
POST /api/payout-intents
```

Purpose: stores what the user wants to receive.

Important columns:

```text
id                  payout intent UUID
user_id             internal user UUID
worker_id           worker tied to this intent
target_chain        requested chain, e.g. base-sepolia
target_token        requested token, e.g. eth
recipient_address   user destination address
receive_pool_token  true only if user explicitly wants pool token
status              active | paused | completed | cancelled
```

External systems should treat `payout_intents` as user intent metadata, not as
the settlement queue. Consume `settlement_requests` for executable work.

### paper_share_credits

Created by the backend collector when accepted mining work is credited.

Purpose: canonical internal PaperShare credit.

Important columns:

```text
id                  bigint credit id
user_id             credited user
worker_id           credited worker
payout_intent_id    payout intent active when credit was created
point_ledger_id     compatibility ledger row
amount              PaperShare units
status              pending_settlement | settled | failed | reversed
created_at          credit creation time
```

Current formula:

```text
amount = accepted_share_delta * PAPER_SHARE_DIFFICULTY
default PAPER_SHARE_DIFFICULTY = 10000
```

### settlement_requests

Created by the backend collector after `paper_share_credits`.

Purpose: handoff queue for contracts/Crossroads.

Important columns:

```text
id                     settlement request UUID
paper_share_credit_id  one-to-one linked PaperShare credit
payout_intent_id       original payout intent
user_id                user to credit/settle
amount                 PaperShare units to settle
target_chain           requested target chain
target_token           requested target token
recipient_address      requested recipient
idempotency_key        stable unique key for settlement execution
adapter                placeholder until real adapter is wired
status                 pending | processing | submitted | confirmed | failed | replaced
tx_hash                transaction hash after submission
error                  failure reason if failed
claimed_by             adapter instance currently processing this request
claim_expires_at       retry time if adapter dies while processing
created_at             queue time
updated_at             last adapter update
```

## Handoff Query

The external adapter should claim pending settlement rows from Postgres.

Basic read query:

```sql
SELECT
  sr.id,
  sr.paper_share_credit_id,
  sr.payout_intent_id,
  sr.user_id,
  sr.amount,
  sr.target_chain,
  sr.target_token,
  sr.recipient_address,
  sr.idempotency_key,
  psc.status AS credit_status
FROM settlement_requests sr
JOIN paper_share_credits psc ON psc.id = sr.paper_share_credit_id
WHERE sr.status = 'pending'
  AND psc.status = 'pending_settlement'
ORDER BY sr.created_at ASC
LIMIT 100;
```

Production claim/update should use row locking so two adapters do not submit the
same request:

```sql
BEGIN;

WITH claim AS (
  SELECT id
  FROM settlement_requests
  WHERE status = 'pending'
     OR (status = 'processing' AND claim_expires_at < now())
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE settlement_requests sr
SET
  status = 'processing',
  adapter = 'crossroads',
  claimed_by = '<adapter instance id>',
  claim_expires_at = now() + interval '5 minutes',
  updated_at = now()
FROM claim
WHERE sr.id = claim.id
RETURNING sr.*;

COMMIT;
```

Use `idempotency_key` when calling external contract/Crossroads systems. If the
adapter retries, it must not create duplicate on-chain effects for the same
`idempotency_key`.

## Status Updates

After transaction submission:

```sql
UPDATE settlement_requests
SET
  status = 'submitted',
  adapter = 'crossroads',
  tx_hash = '<tx hash>',
  claimed_by = null,
  claim_expires_at = null,
  updated_at = now()
WHERE id = '<settlement request id>';
```

After final confirmation:

```sql
BEGIN;

UPDATE settlement_requests
SET
  status = 'confirmed',
  updated_at = now()
WHERE id = '<settlement request id>';

UPDATE paper_share_credits
SET status = 'settled'
WHERE id = '<paper_share_credit_id>';

COMMIT;
```

After failure:

```sql
UPDATE settlement_requests
SET
  status = 'failed',
  error = '<failure reason>',
  updated_at = now()
WHERE id = '<settlement request id>';
```

Only mark `paper_share_credits.status = 'failed'` if the credit itself should no
longer be settled. Temporary adapter failures should leave the credit as
`pending_settlement` so it can be retried.

## Expected Adapter Interface

When implemented in this repo, the adapter boundary should look like this:

```text
SettlementRequest
  id
  idempotency_key
  user_id
  amount
  target_chain
  target_token
  recipient_address

SettlementResult
  status = processing | submitted | confirmed | failed
  tx_hash?
  error?
```

The adapter should be replaceable:

```text
placeholder adapter
  -> writes pending rows only

contract signer adapter
  -> submits PaperShare credit transaction

crossroads adapter
  -> swaps/routes to target chain/token/address
```

## External Adapter Contract

The first real adapter can be a separate service or a backend task. Either way,
it should implement exactly this loop:

```text
1. claim one settlement_requests row
2. submit an idempotent contract/Crossroads operation
3. write tx_hash and submitted status
4. observe confirmation/failure
5. mark settlement_requests and paper_share_credits final
```

Minimum required inputs:

```text
idempotency_key
amount
target_chain
target_token
recipient_address
receive_pool_token from payout_intents if needed
```

Minimum required outputs:

```text
settlement_requests.status
settlement_requests.tx_hash
settlement_requests.error
paper_share_credits.status
```

Do not depend on `display_name`, `machine_label`, CLI-local files, XMRig logs,
or HashVault wallet stats for settlement. Those are operational/debug inputs,
not contract settlement sources of truth.

Do not mutate `point_ledger`, `worker_stat_snapshots`, `live_worker_stats`,
`workers`, or `payout_intents` from the adapter. Those belong to mining
accounting and user intent capture.

## Integration Checklist

- Add a contract/Crossroads adapter that claims `settlement_requests`.
- Use `idempotency_key` as the external idempotency key.
- Map `amount` to the PaperShare/mining-pool-token unit expected by the
  contract.
- Respect `receive_pool_token`; if true, settle pool token directly instead of
  routing through Crossroads.
- Write `tx_hash` as soon as a transaction is submitted.
- Mark `paper_share_credits.status = settled` only after final success.
- Leave temporary failures retryable by keeping credit status as
  `pending_settlement`.
- Add adapter tests that simulate retry after `claim_expires_at`.

## Local Verification

Run the current component flow:

```bash
export DRIP_HOME=/private/tmp/drip-demo

cargo run -p xpool-cli -- enroll --name alice --machine-label local1
cargo run -p xpool-cli -- request base-sepolia eth 0x1111111111111111111111111111111111111111
cargo run -p xpool-cli -- start --threads 1
```

Inspect handoff rows:

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U xpool -d xpool \
  -c "SELECT amount, target_chain, target_token, recipient_address, status, adapter FROM settlement_requests ORDER BY created_at DESC LIMIT 10;"
```

Stop the miner:

```bash
cargo run -p xpool-cli -- stop
```

Expected result after at least one accepted share:

```text
paper_share_credits.amount > 0
paper_share_credits.status = pending_settlement
settlement_requests.status = pending
settlement_requests.adapter = placeholder
settlement_requests.target_chain = requested chain
settlement_requests.target_token = requested token
settlement_requests.recipient_address = requested address
```

## Invariants

- One `point_ledger` row can produce at most one `paper_share_credits` row.
- One `paper_share_credits` row can produce at most one `settlement_requests`
  row.
- `settlement_requests.idempotency_key` is unique.
- External adapters must be idempotent.
- External adapters should claim rows with `FOR UPDATE SKIP LOCKED`.
- External adapters should set `processing + claim_expires_at` before network
  calls.
- Expired `processing` rows are retryable.
- External adapters should not mutate miner auth, gate stats, or point ledger
  rows.
- Settlement execution should update `settlement_requests`; mining accounting
  should remain append-only.
