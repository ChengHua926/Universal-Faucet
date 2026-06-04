use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use pretty_assertions::assert_eq;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;
use xpool_backend::{
    collector::{record_proxy_workers, CollectorConfig},
    http::{app_with_state, AppState},
    proxy::workers::ProxyWorker,
};

#[tokio::test]
async fn live_worker_status_requires_token_and_returns_current_accounting_state() {
    let Some(database_url) = std::env::var("XPOOL_TEST_DATABASE_URL").ok() else {
        eprintln!("skipping live status integration test; set XPOOL_TEST_DATABASE_URL");
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
    let worker_id = enrolled["worker_id"].as_str().expect("worker id");
    let worker_name = enrolled["worker_name"].as_str().expect("worker name");
    let worker_token = enrolled["worker_token"].as_str().expect("worker token");

    let unauthorized_response = app_with_state(AppState::new(pool.clone(), "127.0.0.1", 3333))
        .oneshot(
            Request::builder()
                .uri(format!("/api/workers/{worker_id}/live"))
                .body(Body::empty())
                .expect("live request"),
        )
        .await
        .expect("unauthorized response");

    assert_eq!(unauthorized_response.status(), StatusCode::UNAUTHORIZED);

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

    record_proxy_workers(
        &pool,
        &[proxy_worker(worker_name, 3, 1, 0, 33_000, 2)],
        CollectorConfig::default(),
    )
    .await
    .expect("record proxy workers");

    let live_response = app_with_state(AppState::new(pool.clone(), "127.0.0.1", 3333))
        .oneshot(
            Request::builder()
                .uri(format!("/api/workers/{worker_id}/live"))
                .header("authorization", format!("Bearer {worker_token}"))
                .body(Body::empty())
                .expect("live request"),
        )
        .await
        .expect("live response");

    assert_eq!(live_response.status(), StatusCode::OK);

    let live_body = to_bytes(live_response.into_body(), usize::MAX)
        .await
        .expect("live body");
    let live: Value = serde_json::from_slice(&live_body).expect("live json");

    assert_eq!(live["worker_id"], worker_id);
    assert_eq!(live["worker_name"], worker_name);
    assert_eq!(live["display_name"], "alice");
    assert_eq!(live["machine_label"], "macbook1");
    assert_eq!(live["connected"], true);
    assert_eq!(live["connections"], 2);
    assert_eq!(live["accepted_shares"], 3);
    assert_eq!(live["rejected_shares"], 1);
    assert_eq!(live["invalid_shares"], 0);
    assert_eq!(live["total_hashes"], 33_000);
    assert_eq!(live["last_share_timestamp_ms"], 1_780_435_091_271i64);
    assert_eq!(live["hashrate_10s"], 0.83);
    assert_eq!(live["hashrate_60s"], 0.13);
    assert_eq!(live["hashrate_15m"], 0.02);
    assert_eq!(live["paper_share_points"], 30_000);
    assert_eq!(live["accepted_share_credits"], 3);
    assert_eq!(live["hash_credits"], 33_000);
    assert_eq!(live["active_payout_intent"]["target_chain"], "base-sepolia");
    assert_eq!(live["active_payout_intent"]["target_token"], "eth");
    assert_eq!(
        live["active_payout_intent"]["recipient_address"],
        "0x1111111111111111111111111111111111111111"
    );
    assert_eq!(live["settlement"]["pending_count"], 1);
    assert_eq!(live["settlement"]["pending_amount"], 30_000);
}

fn proxy_worker(
    name: impl Into<String>,
    accepted_shares: u64,
    rejected_shares: u64,
    invalid_shares: u64,
    total_hashes: u64,
    connections: u64,
) -> ProxyWorker {
    let name = name.into();

    ProxyWorker {
        name: name.clone(),
        address: "127.0.0.1".to_string(),
        connections,
        accepted_shares,
        rejected_shares,
        invalid_shares,
        total_hashes,
        last_share_timestamp_ms: Some(1_780_435_091_271),
        hashrates: vec![0.83, 0.13, 0.02],
        raw: serde_json::json!([
            name,
            "127.0.0.1",
            connections,
            accepted_shares,
            rejected_shares,
            invalid_shares,
            total_hashes,
            1780435091271i64,
            0.83,
            0.13,
            0.02
        ]),
    }
}

async fn reset_database(pool: &PgPool) {
    for table in [
        "settlement_requests",
        "paper_share_credits",
        "payout_intents",
        "point_ledger",
        "worker_stat_snapshots",
        "live_worker_stats",
        "mining_sessions",
        "workers",
        "users",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(pool)
            .await
            .unwrap_or_else(|error| panic!("delete {table}: {error}"));
    }
}
