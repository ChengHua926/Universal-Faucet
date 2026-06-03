use std::{net::SocketAddr, time::Duration};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateConfig {
    pub bind_addr: SocketAddr,
    pub upstream_addr: String,
    pub stats_addr: SocketAddr,
    pub database_url: String,
    pub upstream_password: String,
    pub proxy_api_token: String,
    pub same_height_grace: Duration,
    pub paper_share_difficulty: u64,
}

impl GateConfig {
    pub fn from_env() -> Self {
        Self {
            bind_addr: env_parse("GATE_BIND_ADDR", "0.0.0.0:3333"),
            upstream_addr: std::env::var("GATE_UPSTREAM_ADDR")
                .unwrap_or_else(|_| "127.0.0.1:3334".to_string()),
            stats_addr: env_parse("GATE_STATS_ADDR", "0.0.0.0:8082"),
            database_url: std::env::var("DATABASE_URL").unwrap_or_else(|_| {
                "postgres://xpool:xpool@127.0.0.1:15432/xpool?sslmode=disable".to_string()
            }),
            upstream_password: std::env::var("GATE_UPSTREAM_PASSWORD")
                .unwrap_or_else(|_| "xpool-dev".to_string()),
            proxy_api_token: std::env::var("GATE_API_TOKEN")
                .or_else(|_| std::env::var("XMRIG_PROXY_API_TOKEN"))
                .unwrap_or_else(|_| "devtoken".to_string()),
            same_height_grace: Duration::from_millis(env_parse(
                "GATE_SAME_HEIGHT_GRACE_MS",
                "1000",
            )),
            paper_share_difficulty: env_parse("PAPER_SHARE_DIFFICULTY", "10000"),
        }
    }
}

fn env_parse<T>(name: &str, default: &str) -> T
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let value = std::env::var(name).unwrap_or_else(|_| default.to_string());
    value
        .parse()
        .unwrap_or_else(|error| panic!("invalid {name}={value}: {error}"))
}
