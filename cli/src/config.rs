use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredConfig {
    pub api_base_url: String,
    pub user_id: String,
    pub worker_id: String,
    pub worker_name: String,
    pub worker_token: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub proxy_password: String,
    pub machine_label: String,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read config {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to write config {path}: {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse config {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to encode config: {0}")]
    Encode(serde_json::Error),
    #[error("could not determine home directory; set XPOOL_HOME")]
    MissingHome,
}

pub fn load_config(path: &Path) -> Result<StoredConfig, ConfigError> {
    let bytes = fs::read(path).map_err(|source| ConfigError::Read {
        path: path.to_path_buf(),
        source,
    })?;

    serde_json::from_slice(&bytes).map_err(|source| ConfigError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

pub fn save_config(path: &Path, config: &StoredConfig) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| ConfigError::Write {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    let body = serde_json::to_vec_pretty(config).map_err(ConfigError::Encode)?;
    fs::write(path, body).map_err(|source| ConfigError::Write {
        path: path.to_path_buf(),
        source,
    })
}

pub fn default_config_path() -> Result<PathBuf, ConfigError> {
    if let Ok(xpool_home) = std::env::var("XPOOL_HOME") {
        return Ok(PathBuf::from(xpool_home).join("config.json"));
    }

    let home = std::env::var("HOME").map_err(|_| ConfigError::MissingHome)?;
    Ok(PathBuf::from(home).join(".xpool").join("config.json"))
}

pub fn default_xmrig_config_path() -> Result<PathBuf, ConfigError> {
    if let Ok(xpool_home) = std::env::var("XPOOL_HOME") {
        return Ok(PathBuf::from(xpool_home).join("xmrig-config.json"));
    }

    let home = std::env::var("HOME").map_err(|_| ConfigError::MissingHome)?;
    Ok(PathBuf::from(home).join(".xpool").join("xmrig-config.json"))
}

pub fn default_pid_path() -> Result<PathBuf, ConfigError> {
    if let Ok(xpool_home) = std::env::var("XPOOL_HOME") {
        return Ok(PathBuf::from(xpool_home).join("xmrig.pid"));
    }

    let home = std::env::var("HOME").map_err(|_| ConfigError::MissingHome)?;
    Ok(PathBuf::from(home).join(".xpool").join("xmrig.pid"))
}

pub fn default_log_path() -> Result<PathBuf, ConfigError> {
    if let Ok(xpool_home) = std::env::var("XPOOL_HOME") {
        return Ok(PathBuf::from(xpool_home).join("xmrig.log"));
    }

    let home = std::env::var("HOME").map_err(|_| ConfigError::MissingHome)?;
    Ok(PathBuf::from(home).join(".xpool").join("xmrig.log"))
}
