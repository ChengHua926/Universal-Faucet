use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::Extension,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/enroll", post(enroll))
        .route("/api/payout-intents", post(create_payout_intent))
        .route("/api/leaderboard", get(leaderboard))
}

pub fn app_with_state(state: AppState) -> Router {
    app().layer(Extension(state))
}

#[derive(Clone)]
pub struct AppState {
    pool: PgPool,
    proxy_host: String,
    proxy_port: u16,
}

impl AppState {
    pub fn new(pool: PgPool, proxy_host: impl Into<String>, proxy_port: u16) -> Self {
        Self {
            pool,
            proxy_host: proxy_host.into(),
            proxy_port,
        }
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        service: "xpool-backend",
        status: "ok",
    })
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    service: &'static str,
    status: &'static str,
}

async fn enroll(
    Extension(state): Extension<AppState>,
    Json(request): Json<EnrollRequest>,
) -> Result<(StatusCode, Json<EnrollResponse>), ApiError> {
    let display_name = required_trimmed("display_name", &request.display_name)?;
    let machine_label = request
        .machine_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("device");

    let user_id = Uuid::new_v4();
    let worker_id = Uuid::new_v4();
    let worker_name = generate_worker_name();
    let worker_token = generate_worker_token();
    let token_hash = hash_worker_token(&worker_token)?;

    let mut transaction = state.pool.begin().await?;

    sqlx::query("INSERT INTO users (id, display_name) VALUES ($1, $2)")
        .bind(user_id)
        .bind(display_name)
        .execute(&mut *transaction)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO workers (id, user_id, worker_name, token_hash, machine_label)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(worker_id)
    .bind(user_id)
    .bind(&worker_name)
    .bind(&token_hash)
    .bind(machine_label)
    .execute(&mut *transaction)
    .await?;

    transaction.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(EnrollResponse {
            user_id,
            worker_id,
            worker_name,
            worker_token,
            proxy_host: state.proxy_host,
            proxy_port: state.proxy_port,
        }),
    ))
}

async fn leaderboard(
    Extension(state): Extension<AppState>,
) -> Result<Json<Vec<LeaderboardEntry>>, ApiError> {
    let rows = sqlx::query(
        r#"
        SELECT
          row_number() OVER (
            ORDER BY sum(pl.points) DESC, u.display_name ASC, u.id ASC
          )::bigint AS rank,
          u.display_name,
          sum(pl.points)::bigint AS points,
          sum(pl.accepted_share_delta)::bigint AS accepted_shares
        FROM users u
        JOIN point_ledger pl ON pl.user_id = u.id
        GROUP BY u.id, u.display_name
        ORDER BY points DESC, u.display_name ASC, u.id ASC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| LeaderboardEntry {
                rank: row.get("rank"),
                display_name: row.get("display_name"),
                points: row.get("points"),
                accepted_shares: row.get("accepted_shares"),
            })
            .collect(),
    ))
}

async fn create_payout_intent(
    Extension(state): Extension<AppState>,
    Json(request): Json<CreatePayoutIntentRequest>,
) -> Result<(StatusCode, Json<CreatePayoutIntentResponse>), ApiError> {
    let worker_name = required_trimmed("worker_name", &request.worker_name)?;
    let worker_token = required_trimmed("worker_token", &request.worker_token)?;
    let target_chain =
        required_trimmed("target_chain", &request.target_chain)?.to_ascii_lowercase();
    let target_token =
        required_trimmed("target_token", &request.target_token)?.to_ascii_lowercase();
    let recipient_address = required_trimmed("recipient_address", &request.recipient_address)?;
    let receive_pool_token = request.receive_pool_token.unwrap_or(false);

    let Some(worker) = sqlx::query(
        r#"
        SELECT id, user_id, token_hash
        FROM workers
        WHERE worker_name = $1
        "#,
    )
    .bind(worker_name)
    .fetch_optional(&state.pool)
    .await?
    else {
        return Err(ApiError::Unauthorized);
    };

    let worker_id: Uuid = worker.get("id");
    let user_id: Uuid = worker.get("user_id");
    let token_hash: String = worker.get("token_hash");

    verify_worker_token(worker_token, &token_hash)?;

    let payout_intent_id = Uuid::new_v4();

    sqlx::query(
        r#"
        INSERT INTO payout_intents (
          id,
          user_id,
          worker_id,
          target_chain,
          target_token,
          recipient_address,
          receive_pool_token
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(payout_intent_id)
    .bind(user_id)
    .bind(worker_id)
    .bind(&target_chain)
    .bind(&target_token)
    .bind(recipient_address)
    .bind(receive_pool_token)
    .execute(&state.pool)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(CreatePayoutIntentResponse {
            payout_intent_id,
            user_id,
            worker_id,
            target_chain,
            target_token,
            recipient_address: recipient_address.to_string(),
            receive_pool_token,
            status: "active",
        }),
    ))
}

fn required_trimmed<'a>(field_name: &'static str, value: &'a str) -> Result<&'a str, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request(format!("{field_name} is required")));
    }

    Ok(trimmed)
}

fn generate_worker_token() -> String {
    format!("xp_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn generate_worker_name() -> String {
    format!("w_{}", Uuid::new_v4().simple())
}

fn hash_worker_token(token: &str) -> Result<String, ApiError> {
    let salt_bytes = *Uuid::new_v4().as_bytes();
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|_| ApiError::Internal)?;
    Argon2::default()
        .hash_password(token.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError::Internal)
}

fn verify_worker_token(token: &str, token_hash: &str) -> Result<(), ApiError> {
    let parsed_hash = PasswordHash::new(token_hash).map_err(|_| ApiError::Internal)?;

    Argon2::default()
        .verify_password(token.as_bytes(), &parsed_hash)
        .map_err(|_| ApiError::Unauthorized)
}

#[derive(Debug, Deserialize)]
struct EnrollRequest {
    display_name: String,
    machine_label: Option<String>,
}

#[derive(Debug, Serialize)]
struct EnrollResponse {
    user_id: Uuid,
    worker_id: Uuid,
    worker_name: String,
    worker_token: String,
    proxy_host: String,
    proxy_port: u16,
}

#[derive(Debug, Serialize)]
struct LeaderboardEntry {
    rank: i64,
    display_name: String,
    points: i64,
    accepted_shares: i64,
}

#[derive(Debug, Deserialize)]
struct CreatePayoutIntentRequest {
    worker_name: String,
    worker_token: String,
    target_chain: String,
    target_token: String,
    recipient_address: String,
    receive_pool_token: Option<bool>,
}

#[derive(Debug, Serialize)]
struct CreatePayoutIntentResponse {
    payout_intent_id: Uuid,
    user_id: Uuid,
    worker_id: Uuid,
    target_chain: String,
    target_token: String,
    recipient_address: String,
    receive_pool_token: bool,
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("worker already enrolled")]
    Conflict,
    #[error("internal server error")]
    Internal,
}

impl ApiError {
    fn bad_request(message: String) -> Self {
        Self::BadRequest(message)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        if let sqlx::Error::Database(database_error) = &error {
            if database_error.constraint() == Some("workers_worker_name_key") {
                return Self::Conflict;
            }
        }

        Self::Internal
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Conflict => StatusCode::CONFLICT,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = Json(ErrorResponse {
            error: self.to_string(),
        });

        (status, body).into_response()
    }
}
