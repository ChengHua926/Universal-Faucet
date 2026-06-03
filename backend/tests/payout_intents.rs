use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use pretty_assertions::assert_eq;
use serde_json::Value;
use sqlx::{PgPool, Row};
use tower::ServiceExt;
use xpool_backend::{
    collector::{record_proxy_workers, CollectorConfig},
    http::{app_with_state, AppState},
    proxy::workers::ProxyWorker,
};

#[tokio::test]
async fn payout_intent_turns_mined_work_into_placeholder_settlement() {
    let Some(database_url) = std::env::var("XPOOL_TEST_DATABASE_URL").ok() else {
        eprintln!("skipping payout intent integration test; set XPOOL_TEST_DATABASE_URL");
        return;
    };

    let pool = PgPool::connect(&database_url).await.expect("connect db");
    reset_database(&pool).await;

    let enroll_response = app_with_state(AppState::new(pool.clone(), "127.0.0.1", 3333))
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/enroll")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "display_name": "alice",
                        "machine_label": "macbook1"
                    })
                    .to_string(),
                ))
                .expect("enroll request"),
        )
        .await
        .expect("enroll response");

    assert_eq!(enroll_response.status(), StatusCode::CREATED);

    let enroll_body = to_bytes(enroll_response.into_body(), usize::MAX)
        .await
        .expect("enroll body");
    let enrolled: Value = serde_json::from_slice(&enroll_body).expect("enroll json");
    let worker_name = enrolled["worker_name"].as_str().expect("worker name");
    let worker_token = enrolled["worker_token"].as_str().expect("worker token");

    let create_intent_response = app_with_state(AppState::new(pool.clone(), "127.0.0.1", 3333))
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/payout-intents")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "worker_name": worker_name,
                        "worker_token": worker_token,
                        "target_chain": "base-sepolia",
                        "target_token": "eth",
                        "recipient_address": "0x1111111111111111111111111111111111111111"
                    })
                    .to_string(),
                ))
                .expect("intent request"),
        )
        .await
        .expect("intent response");

    assert_eq!(create_intent_response.status(), StatusCode::CREATED);

    let intent_body = to_bytes(create_intent_response.into_body(), usize::MAX)
        .await
        .expect("intent body");
    let intent: Value = serde_json::from_slice(&intent_body).expect("intent json");

    assert_eq!(intent["target_chain"], "base-sepolia");
    assert_eq!(intent["target_token"], "eth");
    assert_eq!(
        intent["recipient_address"],
        "0x1111111111111111111111111111111111111111"
    );
    assert_eq!(intent["receive_pool_token"], false);
    assert_eq!(intent["status"], "active");

    let summary = record_proxy_workers(
        &pool,
        &[proxy_worker(worker_name, 2, 20_000)],
        CollectorConfig::default(),
    )
    .await
    .expect("record proxy workers");

    assert_eq!(summary.credited_points, 20_000);
    assert_eq!(summary.queued_settlements, 1);

    let settlement = sqlx::query(
        r#"
        SELECT
          psc.amount,
          psc.status AS credit_status,
          sr.amount AS settlement_amount,
          sr.status AS settlement_status,
          sr.adapter,
          sr.target_chain,
          sr.target_token,
          sr.recipient_address,
          sr.idempotency_key
        FROM paper_share_credits psc
        JOIN settlement_requests sr ON sr.paper_share_credit_id = psc.id
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("settlement row");

    assert_eq!(settlement.get::<i64, _>("amount"), 20_000);
    assert_eq!(
        settlement.get::<String, _>("credit_status"),
        "pending_settlement"
    );
    assert_eq!(settlement.get::<i64, _>("settlement_amount"), 20_000);
    assert_eq!(settlement.get::<String, _>("settlement_status"), "pending");
    assert_eq!(settlement.get::<String, _>("adapter"), "placeholder");
    assert_eq!(settlement.get::<String, _>("target_chain"), "base-sepolia");
    assert_eq!(settlement.get::<String, _>("target_token"), "eth");
    assert_eq!(
        settlement.get::<String, _>("recipient_address"),
        "0x1111111111111111111111111111111111111111"
    );
    assert!(settlement
        .get::<String, _>("idempotency_key")
        .starts_with("paper_share_credit:"));
}

fn proxy_worker(name: impl Into<String>, accepted_shares: u64, total_hashes: u64) -> ProxyWorker {
    let name = name.into();

    ProxyWorker {
        name: name.clone(),
        address: "127.0.0.1".to_string(),
        connections: 1,
        accepted_shares,
        rejected_shares: 0,
        invalid_shares: 0,
        total_hashes,
        last_share_timestamp_ms: Some(1_780_435_091_271),
        hashrates: vec![0.83, 0.13, 0.02],
        raw: serde_json::json!([
            name,
            "127.0.0.1",
            1,
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
