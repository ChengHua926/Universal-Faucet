use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::voucher::Voucher;

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

    pub async fn miner_status(&self, address: &str) -> Result<MinerStatus, ApiError> {
        let response = self
            .http
            .get(format!("{}/miner/{}", self.base_url, address))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(ApiError::HttpStatus(response.status().as_u16()));
        }

        response.json().await.map_err(ApiError::Http)
    }

    pub async fn state(&self, address: &str) -> Result<MinerState, ApiError> {
        let response = self
            .http
            .get(format!("{}/state/{}", self.base_url, address))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(ApiError::HttpStatus(response.status().as_u16()));
        }

        response.json().await.map_err(ApiError::Http)
    }

    pub async fn request_voucher(&self, address: &str) -> Result<VoucherOut, ApiError> {
        let response = self
            .http
            .post(format!("{}/voucher", self.base_url))
            .json(&VoucherRequest {
                user: address,
                amount: None,
            })
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(ApiError::HttpStatus(response.status().as_u16()));
        }

        response.json().await.map_err(ApiError::Http)
    }

    pub async fn restore(&self, voucher: &Voucher) -> Result<(), ApiError> {
        let response = self
            .http
            .post(format!("{}/restore", self.base_url))
            .json(voucher)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(ApiError::HttpStatus(response.status().as_u16()));
        }

        Ok(())
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
struct VoucherRequest<'a> {
    user: &'a str,
    amount: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VoucherOut {
    pub user: String,
    pub cumulative_amount: String,
    pub marginal: Option<i64>,
    pub signed_at: i64,
    pub signature: String,
    pub earned_cumulative: Option<serde_json::Value>,
    pub last_voucher_cumulative: Option<serde_json::Value>,
    pub on_chain_claimed: Option<String>,
}

impl From<VoucherOut> for Voucher {
    fn from(value: VoucherOut) -> Self {
        Self {
            user: value.user,
            cumulative_amount: value.cumulative_amount,
            signed_at: value.signed_at,
            signature: value.signature,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MinerStatus {
    pub address: String,
    #[serde(default)]
    pub hashrate: Option<f64>,
    #[serde(default)]
    pub accepted_shares: Option<i64>,
    #[serde(default)]
    pub rejected_shares: Option<i64>,
    #[serde(default)]
    pub owed: Option<String>,
    #[serde(default)]
    pub paid: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MinerState {
    pub user: String,
    pub cumulative_amount: String,
}
