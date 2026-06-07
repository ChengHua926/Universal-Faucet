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

    pub fn with_tor_socks5(
        base_url: impl Into<String>,
        tor_socks5: Option<&str>,
    ) -> Result<Self, ApiError> {
        let mut builder = reqwest::Client::builder();
        if let Some(proxy) = tor_socks5.filter(|value| !value.trim().is_empty()) {
            builder = builder.proxy(reqwest::Proxy::all(reqwest_socks5_url(proxy))?);
        }

        Ok(Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: builder.build()?,
        })
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

    pub async fn pool_status(&self) -> Result<PoolStatus, ApiError> {
        let response = self
            .http
            .get(format!("{}/pool", self.base_url))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(ApiError::HttpStatus(response.status().as_u16()));
        }

        response.json().await.map_err(ApiError::Http)
    }

    pub async fn onion_status(&self) -> Result<OnionStatus, ApiError> {
        let response = self
            .http
            .get(format!("{}/onion", self.base_url))
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

fn reqwest_socks5_url(proxy: &str) -> String {
    let trimmed = proxy.trim();
    if let Some(rest) = trimmed.strip_prefix("socks5://") {
        format!("socks5h://{rest}")
    } else if trimmed.starts_with("socks5h://") {
        trimmed.to_string()
    } else {
        format!("socks5h://{trimmed}")
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
    pub miner: String,
    pub cumulative_owed_atomic: i64,
    pub last_voucher_cumulative: i64,
    pub shares: u64,
    pub work: u64,
    pub last_share_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoolStatus {
    pub hashrate: f64,
    pub total_work: u64,
    pub active_miners: usize,
    pub upstream: UpstreamStatus,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamStatus {
    pub connected: bool,
    pub last_change_unix: i64,
    pub consecutive_failures: u32,
    pub submit_rejects_total: u64,
    pub submit_accepts_total: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OnionStatus {
    #[serde(default)]
    pub onion: Option<String>,
    #[serde(default)]
    pub stratum: Option<String>,
    #[serde(default)]
    pub api: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MinerState {
    pub user: String,
    pub earned_cumulative: i64,
    pub last_voucher_cumulative: i64,
    pub on_chain_claimed: String,
    pub available_to_voucher: i64,
}
