use sqlx::{PgPool, Row};
use thiserror::Error;
use uuid::Uuid;

use crate::proxy::workers::ProxyWorker;

#[derive(Debug, Clone, Copy)]
pub struct CollectorConfig {
    pub points_per_accepted_share: i64,
}

impl Default for CollectorConfig {
    fn default() -> Self {
        Self {
            points_per_accepted_share: 1,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CollectorRunSummary {
    pub observed_workers: usize,
    pub matched_workers: usize,
    pub credited_points: i64,
    pub credited_share_delta: i64,
    pub credited_hash_delta: i64,
}

#[derive(Debug, Error)]
pub enum CollectorError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("proxy counter {field} is too large for Postgres BIGINT: {value}")]
    CounterOverflow { field: &'static str, value: u64 },
    #[error("point calculation overflowed")]
    PointsOverflow,
}

pub async fn record_proxy_workers(
    pool: &PgPool,
    workers: &[ProxyWorker],
    config: CollectorConfig,
) -> Result<CollectorRunSummary, CollectorError> {
    let mut summary = CollectorRunSummary {
        observed_workers: workers.len(),
        ..CollectorRunSummary::default()
    };
    let mut transaction = pool.begin().await?;

    for worker in workers {
        let Some(db_worker) = lookup_worker(&mut transaction, &worker.name).await? else {
            continue;
        };

        summary.matched_workers += 1;

        let accepted_shares = counter_to_i64("accepted_shares", worker.accepted_shares)?;
        let rejected_shares = counter_to_i64("rejected_shares", worker.rejected_shares)?;
        let invalid_shares = counter_to_i64("invalid_shares", worker.invalid_shares)?;
        let total_hashes = counter_to_i64("total_hashes", worker.total_hashes)?;
        let last_share_timestamp_ms = worker
            .last_share_timestamp_ms
            .map(|value| counter_to_i64("last_share_timestamp_ms", value))
            .transpose()?;
        let previous = previous_live_stats(&mut transaction, db_worker.worker_id).await?;
        let accepted_share_delta = positive_delta(accepted_shares, previous.accepted_shares);
        let hash_delta = positive_delta(total_hashes, previous.total_hashes);

        insert_snapshot(
            &mut transaction,
            db_worker.worker_id,
            worker,
            accepted_shares,
            rejected_shares,
            invalid_shares,
            total_hashes,
            last_share_timestamp_ms,
        )
        .await?;
        upsert_live_stats(
            &mut transaction,
            db_worker.worker_id,
            worker,
            accepted_shares,
            rejected_shares,
            invalid_shares,
            total_hashes,
            last_share_timestamp_ms,
        )
        .await?;

        if accepted_share_delta > 0 {
            let points = accepted_share_delta
                .checked_mul(config.points_per_accepted_share)
                .ok_or(CollectorError::PointsOverflow)?;

            sqlx::query(
                r#"
                INSERT INTO point_ledger (
                  user_id,
                  worker_id,
                  points,
                  accepted_share_delta,
                  hash_delta
                )
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(db_worker.user_id)
            .bind(db_worker.worker_id)
            .bind(points)
            .bind(accepted_share_delta)
            .bind(hash_delta)
            .execute(&mut *transaction)
            .await?;

            summary.credited_points += points;
            summary.credited_share_delta += accepted_share_delta;
            summary.credited_hash_delta += hash_delta;
        }
    }

    transaction.commit().await?;
    Ok(summary)
}

async fn lookup_worker(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    worker_name: &str,
) -> Result<Option<DbWorker>, sqlx::Error> {
    sqlx::query("SELECT id, user_id FROM workers WHERE worker_name = $1")
        .bind(worker_name)
        .fetch_optional(&mut **transaction)
        .await
        .map(|row| {
            row.map(|row| DbWorker {
                worker_id: row.get("id"),
                user_id: row.get("user_id"),
            })
        })
}

async fn previous_live_stats(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    worker_id: Uuid,
) -> Result<PreviousStats, sqlx::Error> {
    sqlx::query(
        r#"
        SELECT accepted_shares, total_hashes
        FROM live_worker_stats
        WHERE worker_id = $1
        "#,
    )
    .bind(worker_id)
    .fetch_optional(&mut **transaction)
    .await
    .map(|row| {
        row.map(|row| PreviousStats {
            accepted_shares: row.get("accepted_shares"),
            total_hashes: row.get("total_hashes"),
        })
        .unwrap_or_default()
    })
}

async fn insert_snapshot(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    worker_id: Uuid,
    worker: &ProxyWorker,
    accepted_shares: i64,
    rejected_shares: i64,
    invalid_shares: i64,
    total_hashes: i64,
    last_share_timestamp_ms: Option<i64>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO worker_stat_snapshots (
          worker_id,
          accepted_shares,
          rejected_shares,
          invalid_shares,
          total_hashes,
          last_share_timestamp_ms,
          hashrate_10s,
          hashrate_60s,
          hashrate_15m,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(worker_id)
    .bind(accepted_shares)
    .bind(rejected_shares)
    .bind(invalid_shares)
    .bind(total_hashes)
    .bind(last_share_timestamp_ms)
    .bind(hashrate(worker, 0))
    .bind(hashrate(worker, 1))
    .bind(hashrate(worker, 2))
    .bind(&worker.raw)
    .execute(&mut **transaction)
    .await?;

    Ok(())
}

async fn upsert_live_stats(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    worker_id: Uuid,
    worker: &ProxyWorker,
    accepted_shares: i64,
    rejected_shares: i64,
    invalid_shares: i64,
    total_hashes: i64,
    last_share_timestamp_ms: Option<i64>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO live_worker_stats (
          worker_id,
          accepted_shares,
          rejected_shares,
          invalid_shares,
          total_hashes,
          last_share_timestamp_ms,
          hashrate_10s,
          hashrate_60s,
          hashrate_15m,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (worker_id) DO UPDATE SET
          accepted_shares = EXCLUDED.accepted_shares,
          rejected_shares = EXCLUDED.rejected_shares,
          invalid_shares = EXCLUDED.invalid_shares,
          total_hashes = EXCLUDED.total_hashes,
          last_share_timestamp_ms = EXCLUDED.last_share_timestamp_ms,
          hashrate_10s = EXCLUDED.hashrate_10s,
          hashrate_60s = EXCLUDED.hashrate_60s,
          hashrate_15m = EXCLUDED.hashrate_15m,
          raw = EXCLUDED.raw,
          observed_at = now(),
          updated_at = now()
        "#,
    )
    .bind(worker_id)
    .bind(accepted_shares)
    .bind(rejected_shares)
    .bind(invalid_shares)
    .bind(total_hashes)
    .bind(last_share_timestamp_ms)
    .bind(hashrate(worker, 0))
    .bind(hashrate(worker, 1))
    .bind(hashrate(worker, 2))
    .bind(&worker.raw)
    .execute(&mut **transaction)
    .await?;

    Ok(())
}

fn counter_to_i64(field: &'static str, value: u64) -> Result<i64, CollectorError> {
    i64::try_from(value).map_err(|_| CollectorError::CounterOverflow { field, value })
}

fn positive_delta(current: i64, previous: i64) -> i64 {
    if current > previous {
        current - previous
    } else {
        0
    }
}

fn hashrate(worker: &ProxyWorker, index: usize) -> Option<f64> {
    worker.hashrates.get(index).copied()
}

#[derive(Debug)]
struct DbWorker {
    worker_id: Uuid,
    user_id: Uuid,
}

#[derive(Debug, Default)]
struct PreviousStats {
    accepted_shares: i64,
    total_hashes: i64,
}
