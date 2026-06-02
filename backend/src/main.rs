use std::net::SocketAddr;
use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use xpool_backend::collector::{run_collector_loop, CollectorConfig, ProxyApiConfig};
use xpool_backend::http::{app_with_state, AppState};

#[tokio::main]
async fn main() {
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8081".to_string());
    let addr: SocketAddr = bind_addr
        .parse()
        .unwrap_or_else(|error| panic!("invalid BIND_ADDR {bind_addr}: {error}"));
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let proxy_host = std::env::var("PROXY_HOST").unwrap_or_else(|_| "localhost".to_string());
    let proxy_port = std::env::var("PROXY_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3333);
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("failed to connect to database");

    if let Ok(proxy_api_url) = std::env::var("XMRIG_PROXY_API_URL") {
        let proxy_api_token =
            std::env::var("XMRIG_PROXY_API_TOKEN").unwrap_or_else(|_| "devtoken".to_string());
        let points_per_accepted_share = std::env::var("POINTS_PER_ACCEPTED_SHARE")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1);
        let interval_ms = std::env::var("COLLECTOR_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(2_000);

        tokio::spawn(run_collector_loop(
            pool.clone(),
            ProxyApiConfig::new(proxy_api_url, proxy_api_token),
            CollectorConfig {
                points_per_accepted_share,
            },
            Duration::from_millis(interval_ms),
        ));
    }

    let state = AppState::new(pool, proxy_host, proxy_port);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|error| panic!("failed to bind {addr}: {error}"));

    axum::serve(listener, app_with_state(state))
        .await
        .expect("backend server failed");
}
