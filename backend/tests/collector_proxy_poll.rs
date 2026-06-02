use axum::{
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use pretty_assertions::assert_eq;
use sqlx::{PgPool, Row};
use uuid::Uuid;
use xpool_backend::collector::{collect_proxy_workers_once, CollectorConfig, ProxyApiConfig};

#[tokio::test]
async fn collect_once_fetches_proxy_workers_and_records_point_deltas() {
    let Some(database_url) = std::env::var("XPOOL_TEST_DATABASE_URL").ok() else {
        eprintln!("skipping collector proxy poll integration test; set XPOOL_TEST_DATABASE_URL");
        return;
    };

    let pool = PgPool::connect(&database_url).await.expect("connect db");
    reset_database(&pool).await;
    insert_worker(&pool, "alice", "alice.macbook1").await;

    let proxy_url = spawn_proxy_api().await;
    let summary = collect_proxy_workers_once(
        &pool,
        &ProxyApiConfig::new(proxy_url, "devtoken"),
        CollectorConfig::default(),
    )
    .await
    .expect("collect proxy workers");

    assert_eq!(summary.observed_workers, 1);
    assert_eq!(summary.matched_workers, 1);
    assert_eq!(summary.credited_points, 60_000);
    assert_eq!(leaderboard_points(&pool).await, (60_000, 6));
}

async fn spawn_proxy_api() -> String {
    let app = Router::new().route("/1/workers", get(proxy_workers));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind proxy test server");
    let addr = listener.local_addr().expect("local addr");

    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("proxy test server");
    });

    format!("http://{addr}")
}

async fn proxy_workers(headers: HeaderMap) -> impl IntoResponse {
    let authorized = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some("Bearer devtoken");

    if !authorized {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({})));
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "hashrate": {
                "total": [0.83, 0.13, 0.02, 0.0, 0.0, 0.36]
            },
            "mode": "rig_id",
            "workers": [
                ["alice.macbook1", "127.0.0.1", 1, 6, 0, 0, 60000, 1780435091271i64, 0.83, 0.13, 0.02, 0.0, 0.0]
            ]
        })),
    )
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

async fn leaderboard_points(pool: &PgPool) -> (i64, i64) {
    let row = sqlx::query(
        r#"
        SELECT
          COALESCE(sum(points), 0)::bigint AS points,
          COALESCE(sum(accepted_share_delta), 0)::bigint AS shares
        FROM point_ledger
        "#,
    )
    .fetch_one(pool)
    .await
    .expect("ledger totals");

    (row.get("points"), row.get("shares"))
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
