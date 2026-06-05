use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use clap::{Parser, Subcommand};
use thiserror::Error;

use crate::{
    api::{ApiClient, ApiError, CreatePayoutIntentRequest, LiveWorkerStatus},
    config::{
        default_config_path, default_log_path, default_pid_path, default_xmrig_config_path,
        load_config, save_config, ConfigError, StoredConfig,
    },
    xmrig::resolve_xmrig_path,
    xmrig::{default_threads, generate_xmrig_config, XmrigSettings},
};

const GRACEFUL_STOP_WAIT_ATTEMPTS: usize = 150;

#[derive(Debug, Parser)]
#[command(name = "drip")]
#[command(about = "Mine proof-of-work for faucet credit")]
#[command(
    after_help = "Examples:\n  drip enroll --name alice\n  drip base-sepolia eth 0x1111111111111111111111111111111111111111\n  drip start --threads 2\n  drip status\n\nEnvironment:\n  DRIP_API_BASE_URL  Backend API URL\n  DRIP_HOME          Local profile/log directory"
)]
pub struct Cli {
    #[arg(
        long,
        env = "DRIP_API_BASE_URL",
        default_value = "http://127.0.0.1:8081",
        global = true,
        help = "Backend API URL"
    )]
    pub api_base_url: String,
    #[arg(value_name = "CHAIN", help = "Target chain for faucet output")]
    pub chain: Option<String>,
    #[arg(value_name = "TOKEN", help = "Target token for faucet output")]
    pub token: Option<String>,
    #[arg(
        value_name = "RECIPIENT_ADDRESS",
        help = "Recipient address on target chain"
    )]
    pub recipient_address: Option<String>,
    #[arg(long, help = "Receive internal pool token instead of routed output")]
    pub receive_pool_token: bool,
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    #[command(about = "Enroll this device")]
    Enroll {
        #[arg(long, help = "User-visible name")]
        name: String,
        #[arg(long, help = "Device label, defaults to HOSTNAME or device")]
        machine_label: Option<String>,
    },
    #[command(about = "Set faucet output destination")]
    Request {
        #[arg(help = "Target chain for faucet output")]
        chain: String,
        #[arg(help = "Target token for faucet output")]
        token: String,
        #[arg(help = "Recipient address on target chain")]
        recipient_address: String,
        #[arg(long, help = "Receive internal pool token instead of routed output")]
        receive_pool_token: bool,
    },
    #[command(about = "Start local proof-of-work")]
    Start {
        #[arg(long, help = "CPU threads to use")]
        threads: Option<usize>,
        #[arg(long, help = "Path to XMRig binary")]
        xmrig_path: Option<PathBuf>,
    },
    #[command(about = "Resume local proof-of-work")]
    Resume {
        #[arg(long, help = "CPU threads to use")]
        threads: Option<usize>,
        #[arg(long, help = "Path to XMRig binary")]
        xmrig_path: Option<PathBuf>,
    },
    #[command(about = "Pause local proof-of-work")]
    Pause,
    #[command(about = "Stop local proof-of-work")]
    Stop,
    #[command(about = "Show local miner and server credit status")]
    Status,
    #[command(about = "Show current credit leaderboard")]
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
    #[error("failed to stop miner pid {pid}; signal command exited with {status}")]
    StopFailed { pid: u32, status: String },
    #[error("missing faucet request")]
    Usage,
}

pub fn render_error(error: &CliError) -> String {
    match error {
        CliError::Usage => [
            "error: missing faucet request",
            "",
            "Run one of:",
            "  drip enroll --name alice",
            "  drip base-sepolia eth 0x...",
            "  drip status",
            "",
            "See: drip --help",
        ]
        .join("\n"),
        CliError::Config(ConfigError::Read { source, .. })
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            [
                "error: no drip profile found",
                "",
                "Run:",
                "  drip enroll --name <name>",
                "",
                "Then request faucet output:",
                "  drip base-sepolia eth 0x...",
            ]
            .join("\n")
        }
        CliError::AlreadyRunning(pid) => [
            format!("error: miner is already running with pid {pid}"),
            String::new(),
            "Run:".to_string(),
            "  drip status".to_string(),
            "  drip stop".to_string(),
        ]
        .join("\n"),
        CliError::NotRunning => [
            "error: miner is not running".to_string(),
            String::new(),
            "Run:".to_string(),
            "  drip start --threads 1".to_string(),
            "  drip status".to_string(),
        ]
        .join("\n"),
        CliError::Api(error) => [
            format!("error: backend unavailable ({error})"),
            String::new(),
            "Check:".to_string(),
            "  DRIP_API_BASE_URL".to_string(),
            "  docker compose -f infra/docker-compose.yml ps".to_string(),
        ]
        .join("\n"),
        _ => format!("error: {error}"),
    }
}

pub async fn run(cli: Cli) -> Result<(), CliError> {
    let Cli {
        api_base_url,
        chain,
        token,
        recipient_address,
        receive_pool_token,
        command,
    } = cli;

    match command {
        Some(Commands::Enroll {
            name,
            machine_label,
        }) => enroll(&api_base_url, &name, machine_label).await,
        Some(Commands::Request {
            chain,
            token,
            recipient_address,
            receive_pool_token,
        }) => request_payout_intent(&chain, &token, &recipient_address, receive_pool_token).await,
        Some(Commands::Start {
            threads,
            xmrig_path,
        }) => start(threads, xmrig_path).await,
        Some(Commands::Resume {
            threads,
            xmrig_path,
        }) => start(threads, xmrig_path).await,
        Some(Commands::Pause | Commands::Stop) => stop(),
        Some(Commands::Status) => status().await,
        Some(Commands::Leaderboard) => leaderboard(&api_base_url).await,
        None => {
            let (Some(chain), Some(token), Some(recipient_address)) =
                (chain, token, recipient_address)
            else {
                return Err(CliError::Usage);
            };

            request_payout_intent(&chain, &token, &recipient_address, receive_pool_token).await
        }
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
        machine_label,
    };

    save_config(&default_config_path()?, &config)?;

    println!("Enrolled");
    println!("  worker: {}", config.worker_name);
    println!("  device: {}", config.machine_label);
    println!("  proxy:  {}:{}", config.proxy_host, config.proxy_port);
    println!();
    println!("Next:");
    println!("  drip base-sepolia eth 0x...");
    println!("  drip start --threads 1");
    Ok(())
}

async fn request_payout_intent(
    chain: &str,
    token: &str,
    recipient_address: &str,
    receive_pool_token: bool,
) -> Result<(), CliError> {
    let config = load_config(&default_config_path()?)?;
    let response = ApiClient::new(&config.api_base_url)
        .create_payout_intent(&CreatePayoutIntentRequest {
            worker_name: &config.worker_name,
            worker_token: &config.worker_token,
            target_chain: chain,
            target_token: token,
            recipient_address,
            receive_pool_token,
        })
        .await?;

    println!("Payout intent");
    println!("  id:        {}", response.payout_intent_id);
    println!(
        "  target:    {} {}",
        response.target_chain, response.target_token
    );
    println!("  recipient: {}", response.recipient_address);
    println!("  mode:      {}", payout_mode(response.receive_pool_token));
    println!("  status:    {}", response.status);
    println!();
    println!("Next:");
    println!("  drip start --threads 1");
    println!("  drip status");

    Ok(())
}

async fn leaderboard(api_base_url: &str) -> Result<(), CliError> {
    let entries = ApiClient::new(api_base_url).leaderboard().await?;

    if entries.is_empty() {
        println!("Leaderboard");
        println!("  no accepted work yet");
        return Ok(());
    }

    println!("Leaderboard");
    println!("  rank  user                 points        shares");
    for entry in entries {
        println!(
            "  {:>4}  {:<18} {:>12} {:>12}",
            entry.rank,
            truncate_for_table(&entry.display_name, 18),
            format_number(entry.points),
            format_number(entry.accepted_shares)
        );
    }

    Ok(())
}

async fn start(threads: Option<usize>, xmrig_path: Option<PathBuf>) -> Result<(), CliError> {
    let pid_path = default_pid_path()?;

    if let Some(pid) = read_pid(&pid_path)? {
        if process_is_running(pid) {
            return Err(CliError::AlreadyRunning(pid));
        }
    }

    let config = load_config(&default_config_path()?)?;
    let thread_count = threads.unwrap_or_else(default_threads);
    let log_path = default_log_path()?;
    let xmrig_path = resolve_xmrig_path(xmrig_path.as_deref());
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
    let mut command = Command::new(&xmrig_path);
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

    println!("Mining started");
    println!("  pid:     {pid}");
    println!("  threads: {thread_count}");
    println!("  worker:  {}", config.worker_name);
    println!("  log:     {}", log_path.display());
    println!();
    println!("Observe:");
    println!("  drip status");

    Ok(())
}

fn stop() -> Result<(), CliError> {
    let pid_path = default_pid_path()?;
    let Some(pid) = read_pid(&pid_path)? else {
        return Err(CliError::NotRunning);
    };

    if !process_is_running(pid) {
        let _ = fs::remove_file(&pid_path);
        println!("Mining stopped");
        println!("  removed stale pid: {pid}");
        return Ok(());
    }

    let status = signal_process(pid, "-INT")?;
    if !status.success() {
        return Err(CliError::StopFailed {
            pid,
            status: status.to_string(),
        });
    }

    for _ in 0..GRACEFUL_STOP_WAIT_ATTEMPTS {
        if !process_is_running(pid) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    if process_is_running(pid) {
        let status = signal_process(pid, "-TERM")?;
        if !status.success() {
            return Err(CliError::StopFailed {
                pid,
                status: status.to_string(),
            });
        }
    }

    let _ = fs::remove_file(&pid_path);
    println!("Mining stopped");
    println!("  pid: {pid}");

    Ok(())
}

async fn status() -> Result<(), CliError> {
    let pid_path = default_pid_path()?;
    let Some(pid) = read_pid(&pid_path)? else {
        println!("Local miner");
        println!("  status: stopped");
        print_server_status_if_enrolled().await?;
        return Ok(());
    };

    if process_is_running(pid) {
        println!("Local miner");
        println!("  status: running");
        println!("  pid:    {pid}");
    } else {
        println!("Local miner");
        println!("  status: stopped");
        println!("  stale pid: {pid}");
    }

    print_server_status_if_enrolled().await?;

    Ok(())
}

async fn print_server_status_if_enrolled() -> Result<(), CliError> {
    let config = match load_config(&default_config_path()?) {
        Ok(config) => config,
        Err(ConfigError::Read { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(())
        }
        Err(error) => return Err(error.into()),
    };

    match ApiClient::new(&config.api_base_url)
        .live_worker_status(&config.worker_id, &config.worker_token)
        .await
    {
        Ok(status) => {
            for line in render_live_worker_status(&status) {
                println!("{line}");
            }
        }
        Err(error) => {
            println!("server status unavailable: {error}");
        }
    }

    Ok(())
}

pub fn render_live_worker_status(status: &LiveWorkerStatus) -> Vec<String> {
    let machine_label = status.machine_label.as_deref().unwrap_or("device");
    let mut lines = vec![
        "Worker".to_string(),
        format!("  name:        {}", status.worker_name),
        format!("  user/device: {} / {}", status.display_name, machine_label),
        format!(
            "  server:      {} ({} {})",
            if status.connected {
                "connected"
            } else {
                "disconnected"
            },
            status.connections,
            plural(status.connections, "connection", "connections")
        ),
        String::new(),
        "Mining".to_string(),
        format!(
            "  shares:      {} accepted, {} rejected, {} invalid",
            format_number(status.accepted_shares),
            format_number(status.rejected_shares),
            format_number(status.invalid_shares)
        ),
        format!("  hashes:      {}", format_number(status.total_hashes)),
        format!(
            "  hashrate:    {} 10s, {} 60s, {} 15m",
            format_optional_hashrate(status.hashrate_10s),
            format_optional_hashrate(status.hashrate_60s),
            format_optional_hashrate(status.hashrate_15m)
        ),
        String::new(),
        "Credit".to_string(),
        format!(
            "  paper-share: {} points",
            format_number(status.paper_share_points)
        ),
        format!(
            "  source:      {} accepted shares, {} hashes",
            format_number(status.accepted_share_credits),
            format_number(status.hash_credits)
        ),
    ];

    lines.push(String::new());
    lines.push("Payout".to_string());
    if let Some(intent) = &status.active_payout_intent {
        lines.push(format!(
            "  intent:      {} -> {} {}",
            intent.status, intent.target_chain, intent.target_token
        ));
        lines.push(format!("  recipient:   {}", intent.recipient_address));
    } else {
        lines.push("  intent:      none".to_string());
        lines.push("  recipient:   n/a".to_string());
    }

    lines.push(format!(
        "  settlement:  {} pending ({}), {} submitted, {} confirmed, {} failed",
        format_number(status.settlement.pending_count),
        format_number(status.settlement.pending_amount),
        format_number(status.settlement.submitted_count),
        format_number(status.settlement.confirmed_count),
        format_number(status.settlement.failed_count)
    ));

    lines
}

fn format_optional_hashrate(value: Option<f64>) -> String {
    value
        .map(|value| format!("{value:.2} H/s"))
        .unwrap_or_else(|| "n/a".to_string())
}

fn format_number(value: i64) -> String {
    let mut digits = value.abs().to_string();
    let mut out = String::new();

    while digits.len() > 3 {
        let tail = digits.split_off(digits.len() - 3);
        if out.is_empty() {
            out = tail;
        } else {
            out = format!("{tail},{out}");
        }
    }

    if out.is_empty() {
        out = digits;
    } else {
        out = format!("{digits},{out}");
    }

    if value < 0 {
        format!("-{out}")
    } else {
        out
    }
}

fn plural(count: i64, singular: &'static str, plural: &'static str) -> &'static str {
    if count == 1 {
        singular
    } else {
        plural
    }
}

fn payout_mode(receive_pool_token: bool) -> &'static str {
    if receive_pool_token {
        "pool token"
    } else {
        "routed token"
    }
}

fn truncate_for_table(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.to_string();
    }

    let mut truncated = value
        .chars()
        .take(width.saturating_sub(1))
        .collect::<String>();
    truncated.push('~');
    truncated
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

fn signal_process(pid: u32, signal: &str) -> std::io::Result<std::process::ExitStatus> {
    Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .status()
}

fn default_machine_label() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| "device".to_string())
}
