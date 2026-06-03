use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub struct PaperShareCreditInput {
    pub user_id: Uuid,
    pub worker_id: Uuid,
    pub point_ledger_id: i64,
    pub amount: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueuedSettlement {
    pub paper_share_credit_id: i64,
    pub settlement_request_id: Uuid,
}

pub async fn queue_placeholder_settlement(
    transaction: &mut Transaction<'_, Postgres>,
    input: PaperShareCreditInput,
) -> Result<Option<QueuedSettlement>, sqlx::Error> {
    let Some(intent) = active_payout_intent(transaction, input.user_id, input.worker_id).await?
    else {
        return Ok(None);
    };

    let paper_share_credit_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO paper_share_credits (
          user_id,
          worker_id,
          payout_intent_id,
          point_ledger_id,
          amount
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(input.user_id)
    .bind(input.worker_id)
    .bind(intent.id)
    .bind(input.point_ledger_id)
    .bind(input.amount)
    .fetch_one(&mut **transaction)
    .await?;

    let settlement_request_id = Uuid::new_v4();
    let idempotency_key = format!("paper_share_credit:{paper_share_credit_id}");

    sqlx::query(
        r#"
        INSERT INTO settlement_requests (
          id,
          paper_share_credit_id,
          payout_intent_id,
          user_id,
          amount,
          target_chain,
          target_token,
          recipient_address,
          idempotency_key,
          adapter
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'placeholder')
        "#,
    )
    .bind(settlement_request_id)
    .bind(paper_share_credit_id)
    .bind(intent.id)
    .bind(input.user_id)
    .bind(input.amount)
    .bind(intent.target_chain)
    .bind(intent.target_token)
    .bind(intent.recipient_address)
    .bind(idempotency_key)
    .execute(&mut **transaction)
    .await?;

    Ok(Some(QueuedSettlement {
        paper_share_credit_id,
        settlement_request_id,
    }))
}

async fn active_payout_intent(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    worker_id: Uuid,
) -> Result<Option<ActivePayoutIntent>, sqlx::Error> {
    sqlx::query(
        r#"
        SELECT id, target_chain, target_token, recipient_address
        FROM payout_intents
        WHERE user_id = $1
          AND worker_id = $2
          AND status = 'active'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .bind(worker_id)
    .fetch_optional(&mut **transaction)
    .await
    .map(|row| {
        row.map(|row| ActivePayoutIntent {
            id: row.get("id"),
            target_chain: row.get("target_chain"),
            target_token: row.get("target_token"),
            recipient_address: row.get("recipient_address"),
        })
    })
}

#[derive(Debug)]
struct ActivePayoutIntent {
    id: Uuid,
    target_chain: String,
    target_token: String,
    recipient_address: String,
}
