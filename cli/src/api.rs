use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct ApiClient {
    base_url: String,
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn enroll(
        &self,
        display_name: &str,
        machine_label: &str,
    ) -> Result<EnrollResponse, ApiError> {
        let response = self
            .http
            .post(format!("{}/api/enroll", self.base_url))
            .json(&EnrollRequest {
                display_name,
                machine_label,
            })
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(ApiError::HttpStatus(response.status().as_u16()));
        }

        response.json().await.map_err(ApiError::Http)
    }

    pub async fn leaderboard(&self) -> Result<Vec<LeaderboardEntry>, ApiError> {
        let response = self
            .http
            .get(format!("{}/api/leaderboard", self.base_url))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(ApiError::HttpStatus(response.status().as_u16()));
        }

        response.json().await.map_err(ApiError::Http)
    }
}

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("api request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("api returned HTTP {0}")]
    HttpStatus(u16),
}

#[derive(Debug, Serialize)]
struct EnrollRequest<'a> {
    display_name: &'a str,
    machine_label: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnrollResponse {
    pub user_id: String,
    pub worker_id: String,
    pub worker_name: String,
    pub worker_token: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub proxy_password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LeaderboardEntry {
    pub rank: i64,
    pub display_name: String,
    pub points: i64,
    pub accepted_shares: i64,
}
