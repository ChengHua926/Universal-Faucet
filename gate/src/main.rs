use sqlx::postgres::PgPoolOptions;
use xpool_gate::{
    config::GateConfig,
    gate::{run_gate, GateState},
};

#[tokio::main]
async fn main() {
    let config = GateConfig::from_env();
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .expect("connect database");
    let state = GateState::new(pool, config);

    run_gate(state).await.expect("run gate");
}
