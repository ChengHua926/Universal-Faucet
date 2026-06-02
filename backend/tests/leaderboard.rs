use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use pretty_assertions::assert_eq;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
use xpool_backend::http::{app_with_state, AppState};

#[tokio::test]
async fn leaderboard_returns_ranked_point_totals() {
    let Some(database_url) = std::env::var("XPOOL_TEST_DATABASE_URL").ok() else {
        eprintln!("skipping leaderboard integration test; set XPOOL_TEST_DATABASE_URL");
        return;
    };

    let pool = PgPool::connect(&database_url).await.expect("connect db");
    reset_database(&pool).await;

    let alice_worker_id = insert_user_worker(&pool, "alice", "alice.macbook1").await;
    let bob_worker_id = insert_user_worker(&pool, "bob", "bob.desktop1").await;
    insert_points(&pool, alice_worker_id, 5, 5).await;
    insert_points(&pool, bob_worker_id, 9, 9).await;
    insert_points(&pool, alice_worker_id, 7, 7).await;

    let response = app_with_state(AppState::new(pool, "127.0.0.1", 3333))
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/leaderboard")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body bytes");
    let json: Value = serde_json::from_slice(&body).expect("json body");

    assert_eq!(
        json,
        serde_json::json!([
            {
                "rank": 1,
                "display_name": "alice",
                "points": 12,
                "accepted_shares": 12
            },
            {
                "rank": 2,
                "display_name": "bob",
                "points": 9,
                "accepted_shares": 9
            }
        ])
    );
}

async fn insert_user_worker(pool: &PgPool, display_name: &str, worker_name: &str) -> Uuid {
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
        VALUES ($1, $2, $3, 'test-token-hash', 'test-device')
        "#,
    )
    .bind(worker_id)
    .bind(user_id)
    .bind(worker_name)
    .execute(pool)
    .await
    .expect("insert worker");

    worker_id
}

async fn insert_points(pool: &PgPool, worker_id: Uuid, points: i64, accepted_share_delta: i64) {
    sqlx::query(
        r#"
        INSERT INTO point_ledger (user_id, worker_id, points, accepted_share_delta, hash_delta)
        SELECT user_id, id, $2, $3, $4
        FROM workers
        WHERE id = $1
        "#,
    )
    .bind(worker_id)
    .bind(points)
    .bind(accepted_share_delta)
    .bind(accepted_share_delta * 10_000)
    .execute(pool)
    .await
    .expect("insert points");
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
