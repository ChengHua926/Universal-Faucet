use std::{net::SocketAddr, time::Duration};

use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use pretty_assertions::assert_eq;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use uuid::Uuid;
use xpool_gate::{
    config::GateConfig,
    gate::{run_stratum_listener_on, GateState},
};

#[tokio::test]
async fn gate_rewrites_login_counts_upstream_accepts_and_blocks_duplicate_submit() {
    let Some(database_url) = std::env::var("XPOOL_TEST_DATABASE_URL").ok() else {
        eprintln!("skipping tcp gate integration test; set XPOOL_TEST_DATABASE_URL");
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect database");
    let worker_name = "w_tcp_valid";
    cleanup_worker(&pool, worker_name).await;
    insert_worker(&pool, worker_name, "xp_tcp_secret").await;

    let upstream_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind upstream");
    let upstream_addr = upstream_listener.local_addr().expect("upstream addr");
    let gate_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind gate");
    let gate_addr = gate_listener.local_addr().expect("gate addr");
    let stats_addr = free_addr().await;
    let config = GateConfig {
        bind_addr: gate_addr,
        upstream_addr: upstream_addr.to_string(),
        stats_addr,
        database_url,
        upstream_password: "xpool-dev".to_string(),
        proxy_api_token: "devtoken".to_string(),
        same_height_grace: Duration::from_secs(1),
        paper_share_difficulty: 10_000,
    };
    let state = GateState::new(pool.clone(), config);
    let stats = state.stats();
    let gate_task = tokio::spawn(run_stratum_listener_on(state, gate_listener));
    let upstream_task = tokio::spawn(fake_upstream(upstream_listener));

    let mut miner = BufReader::new(
        TcpStream::connect(gate_addr)
            .await
            .expect("connect gate as miner"),
    );

    write_json(
        miner.get_mut(),
        json!({
            "id": 1,
            "jsonrpc": "2.0",
                "method": "login",
                "params": {
                "login": worker_name,
                "pass": "xp_tcp_secret",
                "rigid": worker_name
            }
        }),
    )
    .await;
    assert_eq!(read_json(&mut miner).await["result"]["status"], "OK");

    let first_submit = json!({
        "id": 2,
        "jsonrpc": "2.0",
        "method": "submit",
        "params": {
            "id": "rpc-session",
            "job_id": "job-a",
            "nonce": "00000001",
            "result": "result-a",
            "algo": "rx/0"
        }
    });

    write_json(miner.get_mut(), first_submit.clone()).await;
    assert_eq!(read_json(&mut miner).await["result"]["status"], "OK");

    write_json(miner.get_mut(), first_submit).await;
    let duplicate_response = read_json(&mut miner).await;
    assert_eq!(duplicate_response["error"]["message"], "Duplicate share");

    let upstream_seen = upstream_task.await.expect("upstream join");
    assert_eq!(upstream_seen.login_password, "xpool-dev");
    assert_eq!(upstream_seen.submit_count, 1);

    gate_task.abort();
    cleanup_worker(&pool, worker_name).await;

    let response = stats.workers_response();
    assert_eq!(response["workers"][0][3], 1);
    assert_eq!(response["workers"][0][4], 1);
}

#[tokio::test]
async fn invalid_worker_token_does_not_open_upstream_connection() {
    let Some(database_url) = std::env::var("XPOOL_TEST_DATABASE_URL").ok() else {
        eprintln!("skipping tcp gate integration test; set XPOOL_TEST_DATABASE_URL");
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect database");
    let worker_name = "w_tcp_invalid";
    cleanup_worker(&pool, worker_name).await;
    insert_worker(&pool, worker_name, "xp_tcp_secret").await;

    let upstream_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind upstream");
    let upstream_addr = upstream_listener.local_addr().expect("upstream addr");
    let gate_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind gate");
    let gate_addr = gate_listener.local_addr().expect("gate addr");
    let stats_addr = free_addr().await;
    let config = GateConfig {
        bind_addr: gate_addr,
        upstream_addr: upstream_addr.to_string(),
        stats_addr,
        database_url,
        upstream_password: "xpool-dev".to_string(),
        proxy_api_token: "devtoken".to_string(),
        same_height_grace: Duration::from_secs(1),
        paper_share_difficulty: 10_000,
    };
    let state = GateState::new(pool.clone(), config);
    let gate_task = tokio::spawn(run_stratum_listener_on(state, gate_listener));

    let mut miner = BufReader::new(
        TcpStream::connect(gate_addr)
            .await
            .expect("connect gate as miner"),
    );
    write_json(
        miner.get_mut(),
        json!({
            "id": 1,
            "jsonrpc": "2.0",
            "method": "login",
            "params": {
                "login": worker_name,
                "pass": "wrong-token",
                "rigid": worker_name
            }
        }),
    )
    .await;

    let mut line = String::new();
    let bytes_read = tokio::time::timeout(Duration::from_millis(500), miner.read_line(&mut line))
        .await
        .expect("gate should close invalid miner promptly")
        .expect("read miner close");
    assert_eq!(bytes_read, 0);

    let upstream_accept =
        tokio::time::timeout(Duration::from_millis(200), upstream_listener.accept()).await;
    assert!(
        upstream_accept.is_err(),
        "invalid miner must not consume an upstream proxy connection"
    );

    gate_task.abort();
    cleanup_worker(&pool, worker_name).await;
}

struct UpstreamSeen {
    login_password: String,
    submit_count: usize,
}

async fn fake_upstream(listener: TcpListener) -> UpstreamSeen {
    let (stream, _) = listener.accept().await.expect("accept upstream");
    let mut upstream = BufReader::new(stream);

    let login = read_json(&mut upstream).await;
    let login_password = login["params"]["pass"]
        .as_str()
        .expect("login pass")
        .to_string();
    write_json(
        upstream.get_mut(),
        json!({
            "id": 1,
            "jsonrpc": "2.0",
            "error": null,
            "result": {
                "id": "rpc-session",
                "job": {
                    "job_id": "job-a",
                    "blob": "blob-a",
                    "height": 100,
                    "target": "ffff0011"
                },
                "status": "OK"
            }
        }),
    )
    .await;

    let _submit = read_json(&mut upstream).await;
    write_json(
        upstream.get_mut(),
        json!({
            "id": 2,
            "jsonrpc": "2.0",
            "error": null,
            "result": {
                "status": "OK"
            }
        }),
    )
    .await;

    let forwarded_duplicate =
        tokio::time::timeout(Duration::from_millis(200), read_json(&mut upstream)).await;
    let submit_count = if forwarded_duplicate.is_ok() { 2 } else { 1 };

    UpstreamSeen {
        login_password,
        submit_count,
    }
}

async fn read_json(reader: &mut BufReader<TcpStream>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).await.expect("read line");
    serde_json::from_str(&line).expect("json line")
}

async fn write_json(stream: &mut TcpStream, value: Value) {
    let mut bytes = serde_json::to_vec(&value).expect("serialize json");
    bytes.push(b'\n');
    stream.write_all(&bytes).await.expect("write json");
}

async fn free_addr() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    listener.local_addr().expect("addr")
}

async fn insert_worker(pool: &PgPool, worker_name: &str, token: &str) {
    let salt = SaltString::encode_b64(b"1234567890123456").expect("salt");
    let token_hash = Argon2::default()
        .hash_password(token.as_bytes(), &salt)
        .expect("hash")
        .to_string();

    let user_id: Uuid =
        sqlx::query_scalar("INSERT INTO users (display_name) VALUES ($1) RETURNING id")
            .bind(worker_name)
            .fetch_one(pool)
            .await
            .expect("insert user");
    sqlx::query(
        "INSERT INTO workers (user_id, worker_name, token_hash, machine_label) VALUES ($1, $2, $3, 'test')",
    )
        .bind(user_id)
        .bind(worker_name)
        .bind(token_hash)
        .execute(pool)
        .await
        .expect("insert worker");
}

async fn cleanup_worker(pool: &PgPool, worker_name: &str) {
    sqlx::query("DELETE FROM users WHERE display_name = $1")
        .bind(worker_name)
        .execute(pool)
        .await
        .expect("delete test user");
}
