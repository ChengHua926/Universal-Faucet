use pretty_assertions::assert_eq;
use sqlx::{PgPool, Row};
use uuid::Uuid;
use xpool_backend::{
    collector::{record_proxy_workers, CollectorConfig},
    proxy::workers::ProxyWorker,
};

#[tokio::test]
async fn collector_records_snapshots_and_credits_only_positive_share_deltas() {
    let Some(database_url) = std::env::var("XPOOL_TEST_DATABASE_URL").ok() else {
        eprintln!("skipping collector integration test; set XPOOL_TEST_DATABASE_URL");
        return;
    };

    let pool = PgPool::connect(&database_url).await.expect("connect db");
    reset_database(&pool).await;

    insert_worker(&pool, "alice", "alice.macbook1").await;

    let first = proxy_worker("alice.macbook1", 4, 40_000, 1);
    let first_summary = record_proxy_workers(&pool, &[first.clone()], CollectorConfig::default())
        .await
        .expect("record first sample");

    assert_eq!(first_summary.observed_workers, 1);
    assert_eq!(first_summary.matched_workers, 1);
    assert_eq!(first_summary.credited_points, 40_000);
    assert_eq!(first_summary.credited_share_delta, 4);
    assert_eq!(first_summary.credited_hash_delta, 40_000);
    assert_eq!(ledger_totals(&pool).await, (40_000, 4, 40_000, 1));
    assert_eq!(live_totals(&pool, "alice.macbook1").await, (4, 40_000));

    let duplicate_summary = record_proxy_workers(&pool, &[first], CollectorConfig::default())
        .await
        .expect("record duplicate sample");

    assert_eq!(duplicate_summary.credited_points, 0);
    assert_eq!(duplicate_summary.credited_share_delta, 0);
    assert_eq!(duplicate_summary.credited_hash_delta, 0);
    assert_eq!(ledger_totals(&pool).await, (40_000, 4, 40_000, 1));

    let next_summary = record_proxy_workers(
        &pool,
        &[proxy_worker("alice.macbook1", 7, 71_000, 0)],
        CollectorConfig::default(),
    )
    .await
    .expect("record next sample");

    assert_eq!(next_summary.credited_points, 30_000);
    assert_eq!(next_summary.credited_share_delta, 3);
    assert_eq!(next_summary.credited_hash_delta, 31_000);
    assert_eq!(ledger_totals(&pool).await, (70_000, 7, 71_000, 2));
    assert_eq!(live_totals(&pool, "alice.macbook1").await, (7, 71_000));

    let snapshot_count: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_stat_snapshots")
        .fetch_one(&pool)
        .await
        .expect("snapshot count");
    assert_eq!(snapshot_count, 3);
}

fn proxy_worker(
    name: impl Into<String>,
    accepted_shares: u64,
    total_hashes: u64,
    connections: u64,
) -> ProxyWorker {
    ProxyWorker {
        name: name.into(),
        address: "127.0.0.1".to_string(),
        connections,
        accepted_shares,
        rejected_shares: 0,
        invalid_shares: 0,
        total_hashes,
        last_share_timestamp_ms: Some(1_780_435_091_271),
        hashrates: vec![0.83, 0.13, 0.02],
        raw: serde_json::json!([
            "alice.macbook1",
            "127.0.0.1",
            connections,
            accepted_shares,
            0,
            0,
            total_hashes,
            1780435091271i64,
            0.83,
            0.13,
            0.02
        ]),
    }
}

async fn insert_worker(pool: &PgPool, display_name: &str, worker_name: &str) {
    let user_id = Uuid::new_v4();
    let worker_id = Uuid::new_v4();

    sqlx::query("INSERT INTO users (id, display_name) VALUES ($1, $2)")
        .bind(user_id)
        .bind(display_name)
        .execute(pool)
        .await
        .expect("insert user");
    sqlx::query(
        r#"
        INSERT INTO workers (id, user_id, worker_name, token_hash, machine_label)
        VALUES ($1, $2, $3, 'test-token-hash', 'macbook1')
        "#,
    )
    .bind(worker_id)
    .bind(user_id)
    .bind(worker_name)
    .execute(pool)
    .await
    .expect("insert worker");
}

async fn ledger_totals(pool: &PgPool) -> (i64, i64, i64, i64) {
    let row = sqlx::query(
        r#"
        SELECT
          COALESCE(sum(points), 0)::bigint AS points,
          COALESCE(sum(accepted_share_delta), 0)::bigint AS shares,
          COALESCE(sum(hash_delta), 0)::bigint AS hashes,
          count(*)::bigint AS rows
        FROM point_ledger
        "#,
    )
    .fetch_one(pool)
    .await
    .expect("ledger totals");

    (
        row.get("points"),
        row.get("shares"),
        row.get("hashes"),
        row.get("rows"),
    )
}

async fn live_totals(pool: &PgPool, worker_name: &str) -> (i64, i64) {
    let row = sqlx::query(
        r#"
        SELECT l.accepted_shares, l.total_hashes
        FROM live_worker_stats l
        JOIN workers w ON w.id = l.worker_id
        WHERE w.worker_name = $1
        "#,
    )
    .bind(worker_name)
    .fetch_one(pool)
    .await
    .expect("live stats");

    (row.get("accepted_shares"), row.get("total_hashes"))
}

async fn reset_database(pool: &PgPool) {
    sqlx::query("DELETE FROM point_ledger")
        .execute(pool)
        .await
        .expect("delete point ledger");
    sqlx::query("DELETE FROM worker_stat_snapshots")
        .execute(pool)
        .await
        .expect("delete snapshots");
    sqlx::query("DELETE FROM live_worker_stats")
        .execute(pool)
        .await
        .expect("delete live stats");
    sqlx::query("DELETE FROM mining_sessions")
        .execute(pool)
        .await
        .expect("delete sessions");
    sqlx::query("DELETE FROM workers")
        .execute(pool)
        .await
        .expect("delete workers");
    sqlx::query("DELETE FROM users")
        .execute(pool)
        .await
        .expect("delete users");
}
