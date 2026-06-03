mod auth;
mod chain;
mod config;
mod crypto;
mod mpc;
mod service;
mod transport;
mod types;

use std::{collections::HashMap, net::SocketAddr, sync::Arc};

use anyhow::Context;
use axum::{
    routing::{get, post},
    Router,
};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::{
    chain::ChainClient, config::Config, mpc::NearMpc, service::AppState, transport::Mailbox,
    types::SignatureScheme,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cfg = Config::parse_and_validate()?;
    let chain = ChainClient::new(&cfg)
        .await
        .context("initializing chain client")?;
    let committee = chain
        .load_committee()
        .await
        .context("loading committee from bootstrap contract")?;
    committee.validate_self(&cfg.self_member_id)?;
    committee.validate_for_all_schemes()?;

    let mailbox = Arc::new(Mailbox::default());
    let mut mpcs = HashMap::new();
    for scheme in SignatureScheme::all() {
        let mpc = NearMpc::load_or_new(
            cfg.root_share_file(scheme),
            committee.clone(),
            scheme,
            mailbox.clone(),
        )
        .await?;
        if let Some(active) = chain.load_root_record(scheme).await? {
            mpc.verify_active_root(&active).await.with_context(|| {
                format!("active {scheme} root record does not match local root share")
            })?;
        }
        mpcs.insert(scheme, mpc);
    }

    let state = Arc::new(AppState::new(cfg.clone(), chain, committee, mpcs, mailbox));

    let router = Router::new()
        .route("/healthz", get(service::healthz))
        .route("/v1/bootstrap/status", get(service::bootstrap_status))
        .route("/v1/bootstrap/init", post(service::bootstrap_init))
        .route("/v1/derived-key", post(service::derived_key))
        .route("/v1/sign", post(service::sign))
        .route(
            "/v1/internal/bootstrap/run",
            post(service::internal_bootstrap_run),
        )
        .route("/v1/internal/run-sign", post(service::internal_run_sign))
        .route(
            "/v1/internal/mpc/message",
            post(service::internal_mpc_message),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = cfg
        .listen
        .parse()
        .context("invalid --listen socket address")?;
    tracing::info!(%addr, self_member_id = %cfg.self_member_id, "committee node listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C handler")
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {}, }
}
