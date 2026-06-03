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

    pub async fn create_payout_intent(
        &self,
        request: &CreatePayoutIntentRequest<'_>,
    ) -> Result<CreatePayoutIntentResponse, ApiError> {
        let response = self
            .http
            .post(format!("{}/api/payout-intents", self.base_url))
            .json(request)
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

#[derive(Debug, Serialize)]
pub struct CreatePayoutIntentRequest<'a> {
    pub worker_name: &'a str,
    pub worker_token: &'a str,
    pub target_chain: &'a str,
    pub target_token: &'a str,
    pub recipient_address: &'a str,
    pub receive_pool_token: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnrollResponse {
    pub user_id: String,
    pub worker_id: String,
    pub worker_name: String,
    pub worker_token: String,
    pub proxy_host: String,
    pub proxy_port: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LeaderboardEntry {
    pub rank: i64,
    pub display_name: String,
    pub points: i64,
    pub accepted_shares: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreatePayoutIntentResponse {
    pub payout_intent_id: String,
    pub user_id: String,
    pub worker_id: String,
    pub target_chain: String,
    pub target_token: String,
    pub recipient_address: String,
    pub receive_pool_token: bool,
    pub status: String,
}
