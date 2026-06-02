use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use pretty_assertions::assert_eq;
use serde_json::Value;
use sqlx::{PgPool, Row};
use tower::ServiceExt;
use uuid::Uuid;
use xpool_backend::http::{app_with_state, AppState};

#[tokio::test]
async fn enroll_creates_user_worker_and_returns_proxy_credentials() {
    let Some(database_url) = std::env::var("XPOOL_TEST_DATABASE_URL").ok() else {
        eprintln!("skipping enroll integration test; set XPOOL_TEST_DATABASE_URL");
        return;
    };

    let pool = PgPool::connect(&database_url).await.expect("connect db");
    reset_database(&pool).await;

    let response = app_with_state(AppState::new(pool.clone(), "127.0.0.1", 3333))
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
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::CREATED);

    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body bytes");
    let json: Value = serde_json::from_slice(&body).expect("json body");

    assert_eq!(json["worker_name"], "alice.macbook1");
    assert_eq!(json["proxy_host"], "127.0.0.1");
    assert_eq!(json["proxy_port"], 3333);

    let user_id = Uuid::parse_str(json["user_id"].as_str().expect("user id")).expect("uuid");
    let worker_id = Uuid::parse_str(json["worker_id"].as_str().expect("worker id")).expect("uuid");
    let worker_token = json["worker_token"]
        .as_str()
        .expect("worker token")
        .to_owned();

    assert!(worker_token.starts_with("xp_"));
    assert!(worker_token.len() >= 67);

    let row = sqlx::query(
        r#"
        SELECT u.display_name, w.worker_name, w.machine_label, w.token_hash
        FROM workers w
        JOIN users u ON u.id = w.user_id
        WHERE u.id = $1 AND w.id = $2
        "#,
    )
    .bind(user_id)
    .bind(worker_id)
    .fetch_one(&pool)
    .await
    .expect("stored enrollment");

    let token_hash: String = row.get("token_hash");
    assert_eq!(row.get::<String, _>("display_name"), "alice");
    assert_eq!(row.get::<String, _>("worker_name"), "alice.macbook1");
    assert_eq!(row.get::<String, _>("machine_label"), "macbook1");
    assert_ne!(token_hash, worker_token);
    assert!(token_hash.starts_with("$argon2"));
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
