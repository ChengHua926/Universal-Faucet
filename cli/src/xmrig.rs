use std::{
    env,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::config::StoredConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmrigSettings {
    pub threads: usize,
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
    pub coin: String,
    #[serde(rename = "rig-id")]
    pub rig_id: String,
    pub keepalive: bool,
    pub tls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sni: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socks5: Option<String>,
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
            url: config.mining_pool_url.clone(),
            user: config.identity.address.clone(),
            pass: "x".to_string(),
            coin: "monero".to_string(),
            rig_id: config.identity.address.clone(),
            keepalive: true,
            tls: config.mining_pool_tls || is_stratum_ssl_pool_url(&config.mining_pool_url),
            sni: should_enable_sni(&config.mining_pool_url).then_some(true),
            socks5: config.tor_socks5.as_deref().map(xmrig_socks5_value),
        }],
    }
}

fn should_enable_sni(pool_url: &str) -> bool {
    let host = pool_host(pool_url).to_ascii_lowercase();
    host == "rofl.app" || host.ends_with(".rofl.app")
}

fn is_stratum_ssl_pool_url(pool_url: &str) -> bool {
    pool_url
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("stratum+ssl://")
}

fn pool_host(pool_url: &str) -> &str {
    let without_scheme = pool_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(pool_url);
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = host_port
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(host_port);
    host.trim_matches(&['[', ']'])
}

fn xmrig_socks5_value(proxy: &str) -> String {
    proxy
        .trim()
        .strip_prefix("socks5://")
        .or_else(|| proxy.trim().strip_prefix("socks5h://"))
        .unwrap_or_else(|| proxy.trim())
        .to_string()
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

    if let Some(path) = bundled_xmrig_path() {
        return path;
    }

    PathBuf::from("xmrig")
}

pub fn bundled_xmrig_path() -> Option<PathBuf> {
    let current_exe = env::current_exe().ok();
    bundled_xmrig_path_candidates_for(env::consts::OS, env::consts::ARCH, current_exe.as_deref())
        .into_iter()
        .find(|path| path.exists())
}

pub fn bundled_xmrig_path_for(target_os: &str, target_arch: &str) -> Option<PathBuf> {
    source_tree_xmrig_path_for(target_os, target_arch)
}

pub fn packaged_xmrig_path_for_exe(
    target_os: &str,
    target_arch: &str,
    exe_path: &Path,
) -> Option<PathBuf> {
    let platform = xmrig_platform(target_os, target_arch)?;
    Some(
        exe_path
            .parent()?
            .join("third_party")
            .join("xmrig")
            .join(platform)
            .join(xmrig_binary_name(target_os)),
    )
}

fn bundled_xmrig_path_candidates_for(
    target_os: &str,
    target_arch: &str,
    current_exe: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(exe_path) = current_exe {
        if let Some(path) = packaged_xmrig_path_for_exe(target_os, target_arch, exe_path) {
            candidates.push(path);
        }
    }

    if let Some(path) = source_tree_xmrig_path_for(target_os, target_arch) {
        candidates.push(path);
    }

    candidates
}

fn source_tree_xmrig_path_for(target_os: &str, target_arch: &str) -> Option<PathBuf> {
    let platform = xmrig_platform(target_os, target_arch)?;
    Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("third_party")
            .join("xmrig")
            .join(platform)
            .join(xmrig_binary_name(target_os)),
    )
}

fn xmrig_platform(target_os: &str, target_arch: &str) -> Option<&'static str> {
    let platform = match (target_os, target_arch) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-amd64",
        ("linux", "x86_64") => "linux-amd64",
        ("windows", "x86_64") => "windows-amd64",
        _ => return None,
    };

    Some(platform)
}

fn xmrig_binary_name(target_os: &str) -> &'static str {
    if target_os == "windows" {
        "xmrig.exe"
    } else {
        "xmrig"
    }
}
