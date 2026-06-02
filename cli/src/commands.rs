use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use clap::{Parser, Subcommand};
use thiserror::Error;

use crate::{
    api::{ApiClient, ApiError},
    config::{
        default_config_path, default_log_path, default_pid_path, default_xmrig_config_path,
        load_config, save_config, ConfigError, StoredConfig,
    },
    xmrig::{default_threads, generate_xmrig_config, XmrigSettings},
};

#[derive(Debug, Parser)]
#[command(name = "xpool")]
#[command(about = "CLI for the XPool mining points prototype")]
pub struct Cli {
    #[arg(
        long,
        env = "XPOOL_API_BASE_URL",
        default_value = "http://127.0.0.1:8081",
        global = true
    )]
    pub api_base_url: String,
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    Enroll {
        #[arg(long)]
        name: String,
        #[arg(long)]
        machine_label: Option<String>,
    },
    Start {
        #[arg(long)]
        threads: Option<usize>,
        #[arg(long, env = "XPOOL_XMRIG_PATH", default_value = "xmrig")]
        xmrig_path: PathBuf,
    },
    Resume {
        #[arg(long)]
        threads: Option<usize>,
        #[arg(long, env = "XPOOL_XMRIG_PATH", default_value = "xmrig")]
        xmrig_path: PathBuf,
    },
    Pause,
    Stop,
    Status,
    Leaderboard,
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error("{0}")]
    Config(#[from] ConfigError),
    #[error("{0}")]
    Api(#[from] ApiError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to encode XMRig config: {0}")]
    Json(#[from] serde_json::Error),
    #[error("miner is already running with pid {0}")]
    AlreadyRunning(u32),
    #[error("no local miner pid file found")]
    NotRunning,
    #[error("failed to stop miner pid {pid}; kill exited with {status}")]
    StopFailed { pid: u32, status: String },
}

pub async fn run(cli: Cli) -> Result<(), CliError> {
    match cli.command {
        Commands::Enroll {
            name,
            machine_label,
        } => enroll(&cli.api_base_url, &name, machine_label).await,
        Commands::Start {
            threads,
            xmrig_path,
        } => start(threads, &xmrig_path).await,
        Commands::Resume {
            threads,
            xmrig_path,
        } => start(threads, &xmrig_path).await,
        Commands::Pause | Commands::Stop => stop(),
        Commands::Status => status(),
        Commands::Leaderboard => leaderboard(&cli.api_base_url).await,
    }
}

async fn enroll(
    api_base_url: &str,
    display_name: &str,
    machine_label: Option<String>,
) -> Result<(), CliError> {
    let machine_label = machine_label.unwrap_or_else(default_machine_label);
    let response = ApiClient::new(api_base_url)
        .enroll(display_name, &machine_label)
        .await?;
    let config = StoredConfig {
        api_base_url: api_base_url.to_string(),
        user_id: response.user_id,
        worker_id: response.worker_id,
        worker_name: response.worker_name,
        worker_token: response.worker_token,
        proxy_host: response.proxy_host,
        proxy_port: response.proxy_port,
        proxy_password: response.proxy_password,
        machine_label,
    };

    save_config(&default_config_path()?, &config)?;

    println!("enrolled {}", config.worker_name);
    println!("proxy {}:{}", config.proxy_host, config.proxy_port);
    Ok(())
}

async fn leaderboard(api_base_url: &str) -> Result<(), CliError> {
    let entries = ApiClient::new(api_base_url).leaderboard().await?;

    if entries.is_empty() {
        println!("leaderboard is empty");
        return Ok(());
    }

    for entry in entries {
        println!(
            "{}. {} - {} points ({} shares)",
            entry.rank, entry.display_name, entry.points, entry.accepted_shares
        );
    }

    Ok(())
}

async fn start(threads: Option<usize>, xmrig_path: &Path) -> Result<(), CliError> {
    let pid_path = default_pid_path()?;

    if let Some(pid) = read_pid(&pid_path)? {
        if process_is_running(pid) {
            return Err(CliError::AlreadyRunning(pid));
        }
    }

    let config = load_config(&default_config_path()?)?;
    let thread_count = threads.unwrap_or_else(default_threads);
    let log_path = default_log_path()?;
    let xmrig_config = generate_xmrig_config(
        &config,
        XmrigSettings {
            threads: thread_count,
            tls: false,
            log_file: Some(log_path.to_string_lossy().to_string()),
        },
    );
    let xmrig_config_path = default_xmrig_config_path()?;

    if let Some(parent) = xmrig_config_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(
        &xmrig_config_path,
        serde_json::to_vec_pretty(&xmrig_config)?,
    )?;

    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let mut command = Command::new(xmrig_path);
    command
        .arg("-c")
        .arg(&xmrig_config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));

    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            // Keep XMRig alive after the short-lived CLI process exits.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }

            libc::signal(libc::SIGHUP, libc::SIG_IGN);
            Ok(())
        });
    }

    let child = command.spawn()?;
    let pid = child.id();

    fs::write(&pid_path, format!("{pid}\n"))?;

    println!("started miner pid {pid}");
    println!("threads {thread_count}");
    println!("worker {}", config.worker_name);
    println!("log {}", log_path.display());

    Ok(())
}

fn stop() -> Result<(), CliError> {
    let pid_path = default_pid_path()?;
    let Some(pid) = read_pid(&pid_path)? else {
        return Err(CliError::NotRunning);
    };

    let status = Command::new("kill").arg(pid.to_string()).status()?;
    if !status.success() {
        return Err(CliError::StopFailed {
            pid,
            status: status.to_string(),
        });
    }

    let _ = fs::remove_file(&pid_path);
    println!("stopped miner pid {pid}");

    Ok(())
}

fn status() -> Result<(), CliError> {
    let pid_path = default_pid_path()?;
    let Some(pid) = read_pid(&pid_path)? else {
        println!("miner stopped");
        return Ok(());
    };

    if process_is_running(pid) {
        println!("miner running pid {pid}");
    } else {
        println!("miner stopped; stale pid {pid}");
    }

    Ok(())
}

fn read_pid(path: &Path) -> Result<Option<u32>, CliError> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents.trim().parse().ok()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CliError::Io(error)),
    }
}

fn process_is_running(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn default_machine_label() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| "device".to_string())
}
