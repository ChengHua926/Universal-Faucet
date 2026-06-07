use std::{
    fs,
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::identity::{generate_identity, LocalIdentity};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredConfig {
    pub api_base_url: String,
    pub mining_pool_url: String,
    pub mining_pool_tls: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tor_socks5: Option<String>,
    pub voucher_interval_seconds: u64,
    pub identity: StoredIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredIdentity {
    pub address: String,
    pub private_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDefaults {
    pub api_base_url: String,
    pub mining_pool_url: String,
    pub mining_pool_tls: bool,
    pub tor_socks5: Option<String>,
    pub voucher_interval_seconds: u64,
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
    #[error("could not determine config directory; set DRIP_HOME")]
    MissingHome,
}

impl From<LocalIdentity> for StoredIdentity {
    fn from(value: LocalIdentity) -> Self {
        Self {
            address: value.address,
            private_key: value.private_key,
        }
    }
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

pub fn load_or_create_config(
    path: &Path,
    defaults: &ConfigDefaults,
) -> Result<(StoredConfig, bool), ConfigError> {
    match load_config(path) {
        Ok(config) => Ok((config, false)),
        Err(ConfigError::Read { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            let config = StoredConfig {
                api_base_url: defaults.api_base_url.clone(),
                mining_pool_url: defaults.mining_pool_url.clone(),
                mining_pool_tls: defaults.mining_pool_tls,
                tor_socks5: defaults.tor_socks5.clone(),
                voucher_interval_seconds: defaults.voucher_interval_seconds,
                identity: generate_identity().into(),
            };
            save_config(path, &config)?;
            Ok((config, true))
        }
        Err(error) => Err(error),
    }
}

pub fn default_config_path() -> Result<PathBuf, ConfigError> {
    Ok(default_home_dir()?.join("config.json"))
}

pub fn default_xmrig_config_path() -> Result<PathBuf, ConfigError> {
    Ok(default_home_dir()?.join("xmrig-config.json"))
}

pub fn default_pid_path() -> Result<PathBuf, ConfigError> {
    Ok(default_home_dir()?.join("xmrig.pid"))
}

pub fn default_voucher_loop_pid_path() -> Result<PathBuf, ConfigError> {
    Ok(default_home_dir()?.join("voucher-loop.pid"))
}

pub fn default_log_path() -> Result<PathBuf, ConfigError> {
    Ok(default_home_dir()?.join("xmrig.log"))
}

pub fn default_voucher_loop_log_path() -> Result<PathBuf, ConfigError> {
    Ok(default_home_dir()?.join("voucher-loop.log"))
}

pub fn default_voucher_path() -> Result<PathBuf, ConfigError> {
    Ok(default_home_dir()?.join("voucher.json"))
}

fn default_home_dir() -> Result<PathBuf, ConfigError> {
    if let Ok(drip_home) = std::env::var("DRIP_HOME") {
        return Ok(PathBuf::from(drip_home));
    }

    if let Some(project_dirs) = ProjectDirs::from("", "", "drip") {
        return Ok(project_dirs.config_dir().to_path_buf());
    }

    Err(ConfigError::MissingHome)
}
