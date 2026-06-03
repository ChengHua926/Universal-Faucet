use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::Value;
use sqlx::PgPool;
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    net::{tcp::OwnedReadHalf, tcp::OwnedWriteHalf, TcpListener, TcpStream},
    sync::Mutex,
};

use crate::{
    auth::{find_worker_auth_record, verify_worker_login, AuthError},
    config::GateConfig,
    shares::{JobRecord, ShareDecision, SharePolicy, ShareTracker, StalePolicy},
    stats::{GateStats, ShareOutcome},
    stratum::{
        error_response, extract_job, extract_login, extract_submit, parse_json_line, request_id,
        request_id_key, response_result, rewrite_login_password, serialize_json_line, JobMessage,
        ResponseResult, StratumMessageError,
    },
};

#[derive(Debug, Clone)]
pub struct GateState {
    pool: PgPool,
    stats: GateStats,
    share_tracker: ShareTracker,
    config: Arc<GateConfig>,
}

impl GateState {
    pub fn new(pool: PgPool, config: GateConfig) -> Self {
        Self {
            pool,
            stats: GateStats::default(),
            share_tracker: ShareTracker::default(),
            config: Arc::new(config),
        }
    }

    pub fn stats(&self) -> GateStats {
        self.stats.clone()
    }
}

#[derive(Debug, Error)]
pub enum GateError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("auth error: {0}")]
    Auth(#[from] AuthError),
    #[error("stratum message error: {0}")]
    StratumMessage(#[from] StratumMessageError),
}

pub async fn run_gate(state: GateState) -> Result<(), GateError> {
    let stats_state = state.clone();
    let stats_addr = state.config.stats_addr;
    tokio::spawn(async move {
        if let Err(error) = run_stats_server(stats_state, stats_addr).await {
            eprintln!("gate stats server failed: {error}");
        }
    });

    run_stratum_listener(state).await
}

pub async fn run_stratum_listener(state: GateState) -> Result<(), GateError> {
    let listener = TcpListener::bind(state.config.bind_addr).await?;
    run_stratum_listener_on(state, listener).await
}

pub async fn run_stratum_listener_on(
    state: GateState,
    listener: TcpListener,
) -> Result<(), GateError> {
    loop {
        let (miner, peer_addr) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(state, miner, peer_addr).await {
                eprintln!("gate connection {peer_addr} failed: {error}");
            }
        });
    }
}

async fn run_stats_server(state: GateState, addr: SocketAddr) -> Result<(), GateError> {
    let app = Router::new()
        .route("/1/workers", get(workers))
        .route("/health", get(health))
        .with_state(state);
    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(serde_json::json!({
        "service": "xpool-gate",
        "status": "ok"
    }))
}

async fn workers(State(state): State<GateState>, headers: HeaderMap) -> Response {
    let expected = format!("Bearer {}", state.config.proxy_api_token);
    let authorized = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(|value| value == expected)
        .unwrap_or(false);

    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    Json(state.stats.workers_response()).into_response()
}

async fn handle_connection(
    state: GateState,
    miner: TcpStream,
    peer_addr: SocketAddr,
) -> Result<(), GateError> {
    let (miner_read, miner_write) = miner.into_split();
    let mut miner_lines = BufReader::new(miner_read).lines();
    let Some((worker_name, login_message)) =
        read_authenticated_login(&state, &mut miner_lines).await?
    else {
        return Ok(());
    };

    let upstream = TcpStream::connect(&state.config.upstream_addr).await?;
    let (upstream_read, upstream_write) = upstream.into_split();
    let session = Arc::new(SessionState::new(
        state,
        peer_addr.ip().to_string(),
        miner_write,
        upstream_write,
    ));
    session.set_worker(worker_name).await;
    session.write_upstream(&login_message).await?;

    let miner_session = session.clone();
    let mut miner_task =
        tokio::spawn(async move { pump_miner_to_upstream(miner_session, miner_lines).await });

    let upstream_session = session.clone();
    let mut upstream_task =
        tokio::spawn(async move { pump_upstream_to_miner(upstream_session, upstream_read).await });

    let result = tokio::select! {
        result = &mut miner_task => {
            upstream_task.abort();
            let _ = upstream_task.await;
            flatten_join(result)
        }
        result = &mut upstream_task => {
            miner_task.abort();
            let _ = miner_task.await;
            flatten_join(result)
        }
    };

    session.disconnect().await;
    result
}

async fn read_authenticated_login(
    state: &GateState,
    lines: &mut Lines<BufReader<OwnedReadHalf>>,
) -> Result<Option<(String, Value)>, GateError> {
    let Some(line) = next_line_with_timeout(lines, Duration::from_secs(10)).await? else {
        return Ok(None);
    };
    let Ok(mut value) = parse_json_line(&line) else {
        return Ok(None);
    };
    let Some(login) = extract_login(&value) else {
        return Ok(None);
    };
    let Some(record) = find_worker_auth_record(&state.pool, &login.worker_name).await? else {
        return Ok(None);
    };

    if !verify_worker_login(&record, &login.worker_name, &login.password)? {
        return Ok(None);
    }

    rewrite_login_password(&mut value, &state.config.upstream_password)?;
    Ok(Some((login.worker_name, value)))
}

fn flatten_join(
    result: Result<Result<(), GateError>, tokio::task::JoinError>,
) -> Result<(), GateError> {
    match result {
        Ok(inner) => inner,
        Err(error) => Err(GateError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            error,
        ))),
    }
}

struct SessionState {
    gate: GateState,
    ip: String,
    worker_name: Mutex<Option<String>>,
    policy: Mutex<SharePolicy>,
    pending_submits: Mutex<HashMap<String, String>>,
    miner_write: Mutex<OwnedWriteHalf>,
    upstream_write: Mutex<OwnedWriteHalf>,
}

impl SessionState {
    fn new(
        gate: GateState,
        ip: String,
        miner_write: OwnedWriteHalf,
        upstream_write: OwnedWriteHalf,
    ) -> Self {
        let stale_policy = StalePolicy {
            same_height_grace: gate.config.same_height_grace,
        };
        Self {
            policy: Mutex::new(SharePolicy::with_tracker(
                stale_policy,
                gate.share_tracker.clone(),
            )),
            gate,
            ip,
            worker_name: Mutex::new(None),
            pending_submits: Mutex::new(HashMap::new()),
            upstream_write: Mutex::new(upstream_write),
            miner_write: Mutex::new(miner_write),
        }
    }

    async fn set_worker(&self, worker_name: String) {
        self.gate.stats.record_login(&worker_name, &self.ip);
        *self.worker_name.lock().await = Some(worker_name);
    }

    async fn worker_name(&self) -> Option<String> {
        self.worker_name.lock().await.clone()
    }

    async fn disconnect(&self) {
        if let Some(worker_name) = self.worker_name().await {
            self.gate.stats.record_disconnect(&worker_name);
        }
    }

    async fn write_upstream(&self, value: &Value) -> Result<(), GateError> {
        let mut upstream = self.upstream_write.lock().await;
        upstream.write_all(&serialize_json_line(value)).await?;
        Ok(())
    }

    async fn write_miner(&self, value: &Value) -> Result<(), GateError> {
        let mut miner = self.miner_write.lock().await;
        miner.write_all(&serialize_json_line(value)).await?;
        Ok(())
    }

    async fn record_pending_submit(&self, request: &Value, worker_name: &str) {
        if let Some(key) = request_id_key(request) {
            self.pending_submits
                .lock()
                .await
                .insert(key, worker_name.to_string());
        }
    }

    async fn take_pending_submit(&self, response: &Value) -> Option<String> {
        let key = request_id_key(response)?;
        self.pending_submits.lock().await.remove(&key)
    }
}

async fn pump_miner_to_upstream(
    session: Arc<SessionState>,
    mut lines: Lines<BufReader<OwnedReadHalf>>,
) -> Result<(), GateError> {
    while let Some(line) = lines.next_line().await? {
        let value = match parse_json_line(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if extract_login(&value).is_some() {
            return Ok(());
        }

        if let Some(submit) = extract_submit(&value) {
            let Some(worker_name) = session.worker_name().await else {
                continue;
            };

            let decision = session
                .policy
                .lock()
                .await
                .evaluate(&submit, Instant::now());
            match decision {
                ShareDecision::Accept => {
                    session.record_pending_submit(&value, &worker_name).await;
                    session.write_upstream(&value).await?;
                }
                ShareDecision::Duplicate => {
                    session.gate.stats.record_share(
                        &worker_name,
                        ShareOutcome::Rejected,
                        unix_ms(),
                    );
                    let response = error_response(&request_id(&value), "Duplicate share");
                    session.write_miner(&response).await?;
                }
                ShareDecision::Stale => {
                    session.gate.stats.record_share(
                        &worker_name,
                        ShareOutcome::Rejected,
                        unix_ms(),
                    );
                    let response = error_response(&request_id(&value), "Stale share");
                    session.write_miner(&response).await?;
                }
                ShareDecision::UnknownJob => {
                    session
                        .gate
                        .stats
                        .record_share(&worker_name, ShareOutcome::Invalid, unix_ms());
                    let response = error_response(&request_id(&value), "Invalid job id");
                    session.write_miner(&response).await?;
                }
            }
            continue;
        }

        session.write_upstream(&value).await?;
    }

    Ok(())
}

async fn pump_upstream_to_miner(
    session: Arc<SessionState>,
    upstream_read: OwnedReadHalf,
) -> Result<(), GateError> {
    let mut lines = BufReader::new(upstream_read).lines();
    while let Some(line) = next_line_with_timeout(&mut lines, Duration::from_secs(3600)).await? {
        if let Ok(value) = parse_json_line(&line) {
            if let Some(worker_name) = session.take_pending_submit(&value).await {
                match response_result(&value) {
                    Some(ResponseResult::Accepted) => session.gate.stats.record_share(
                        &worker_name,
                        ShareOutcome::Accepted {
                            hashes: session.gate.config.paper_share_difficulty,
                        },
                        unix_ms(),
                    ),
                    Some(ResponseResult::Rejected) => session.gate.stats.record_share(
                        &worker_name,
                        ShareOutcome::Rejected,
                        unix_ms(),
                    ),
                    None => {}
                }
            }

            if let Some(job) = extract_job(&value) {
                update_policy_job(&session, job).await;
            }

            session.write_miner(&value).await?;
        } else {
            let mut miner = session.miner_write.lock().await;
            miner.write_all(line.as_bytes()).await?;
            miner.write_all(b"\n").await?;
        }
    }

    Ok(())
}

async fn next_line_with_timeout(
    lines: &mut Lines<BufReader<OwnedReadHalf>>,
    timeout: Duration,
) -> Result<Option<String>, GateError> {
    Ok(tokio::time::timeout(timeout, lines.next_line())
        .await
        .unwrap_or(Ok(None))?)
}

async fn update_policy_job(session: &SessionState, job: JobMessage) {
    let mut policy = session.policy.lock().await;
    let record = JobRecord {
        job_id: job.job_id,
        height: job.height,
        blob: job.blob,
        received_at: Instant::now(),
        replaced_at: None,
    };

    policy.replace_current_job(record, Instant::now());
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}
