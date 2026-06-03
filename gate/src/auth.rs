use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};
use sqlx::{PgPool, Row};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerAuthRecord {
    pub worker_name: String,
    pub token_hash: String,
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("stored token hash is invalid")]
    InvalidHash,
}

pub async fn find_worker_auth_record(
    pool: &PgPool,
    worker_name: &str,
) -> Result<Option<WorkerAuthRecord>, AuthError> {
    let row = sqlx::query("SELECT worker_name, token_hash FROM workers WHERE worker_name = $1")
        .bind(worker_name)
        .fetch_optional(pool)
        .await?;

    Ok(row.map(|row| WorkerAuthRecord {
        worker_name: row.get("worker_name"),
        token_hash: row.get("token_hash"),
    }))
}

pub fn verify_worker_login(
    record: &WorkerAuthRecord,
    worker_name: &str,
    token: &str,
) -> Result<bool, AuthError> {
    if record.worker_name != worker_name {
        return Ok(false);
    }

    let hash = PasswordHash::new(&record.token_hash).map_err(|_| AuthError::InvalidHash)?;

    Ok(Argon2::default()
        .verify_password(token.as_bytes(), &hash)
        .is_ok())
}
