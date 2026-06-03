use std::{
    env,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::config::StoredConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmrigSettings {
    pub threads: usize,
    pub tls: bool,
    pub log_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct XmrigConfig {
    pub autosave: bool,
    #[serde(rename = "log-file", skip_serializing_if = "Option::is_none")]
    pub log_file: Option<String>,
    pub cpu: XmrigCpuConfig,
    pub pools: Vec<XmrigPoolConfig>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct XmrigCpuConfig {
    pub enabled: bool,
    pub rx: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct XmrigPoolConfig {
    pub url: String,
    pub user: String,
    pub pass: String,
    #[serde(rename = "rig-id")]
    pub rig_id: String,
    pub keepalive: bool,
    pub tls: bool,
}

pub fn generate_xmrig_config(config: &StoredConfig, settings: XmrigSettings) -> XmrigConfig {
    XmrigConfig {
        autosave: false,
        log_file: settings.log_file,
        cpu: XmrigCpuConfig {
            enabled: true,
            rx: vec![-1; settings.threads],
        },
        pools: vec![XmrigPoolConfig {
            url: format!("{}:{}", config.proxy_host, config.proxy_port),
            user: config.worker_name.clone(),
            pass: config.worker_token.clone(),
            rig_id: config.worker_name.clone(),
            keepalive: true,
            tls: settings.tls,
        }],
    }
}

pub fn default_threads() -> usize {
    let logical = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2);

    std::cmp::max(1, logical / 2)
}

pub fn resolve_xmrig_path(explicit: Option<&Path>) -> PathBuf {
    if let Some(path) = explicit {
        return path.to_path_buf();
    }

    if let Ok(path) = env::var("DRIP_XMRIG_PATH") {
        return PathBuf::from(path);
    }

    if let Ok(path) = env::var("XPOOL_XMRIG_PATH") {
        return PathBuf::from(path);
    }

    if let Some(path) = bundled_xmrig_path() {
        if path.exists() {
            return path;
        }
    }

    PathBuf::from("xmrig")
}

pub fn bundled_xmrig_path() -> Option<PathBuf> {
    bundled_xmrig_path_for(env::consts::OS, env::consts::ARCH)
}

pub fn bundled_xmrig_path_for(target_os: &str, target_arch: &str) -> Option<PathBuf> {
    let platform = match (target_os, target_arch) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-amd64",
        ("linux", "x86_64") => "linux-amd64",
        ("windows", "x86_64") => "windows-amd64",
        _ => return None,
    };

    Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("third_party")
            .join("xmrig")
            .join(platform)
            .join(if target_os == "windows" {
                "xmrig.exe"
            } else {
                "xmrig"
            }),
    )
}
