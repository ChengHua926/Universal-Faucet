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
    #[serde(rename = "max-threads-hint")]
    pub max_threads_hint: usize,
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
            max_threads_hint: settings.threads,
        },
        pools: vec![XmrigPoolConfig {
            url: format!("{}:{}", config.proxy_host, config.proxy_port),
            user: config.worker_name.clone(),
            pass: config.proxy_password.clone(),
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
