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
    api::{ApiClient, ApiError, MinerStatus, VoucherOut},
    config::{
        default_config_path, default_log_path, default_pid_path, default_voucher_loop_log_path,
        default_voucher_loop_pid_path, default_voucher_path, default_xmrig_config_path,
        load_config, load_or_create_config, save_config, ConfigDefaults, ConfigError, StoredConfig,
    },
    voucher::{load_voucher, save_latest_voucher, Voucher, VoucherError, VoucherWrite},
    xmrig::resolve_xmrig_path,
    xmrig::{default_threads, generate_xmrig_config, XmrigSettings},
};

const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:8081";
const DEFAULT_POOL_URL: &str = "127.0.0.1:3333";
const DEFAULT_VOUCHER_INTERVAL_SECONDS: u64 = 300;
const GRACEFUL_STOP_WAIT_ATTEMPTS: usize = 150;

#[derive(Debug, Parser)]
#[command(name = "drip")]
#[command(about = "Run local proof-of-work for faucet credit")]
#[command(
    after_help = "Examples:\n  drip start --threads 2\n  drip status\n  drip checkpoint\n  drip withdraw base-sepolia eth 0x1111111111111111111111111111111111111111\n\nEnvironment:\n  DRIP_API_BASE_URL  Pool backend HTTP API\n  DRIP_POOL_URL      Stratum mining pool URL\n  DRIP_POOL_TLS      Use TLS for Stratum mining pool\n  DRIP_XMRIG_PATH    Optional XMRig binary override\n  DRIP_HOME          Local profile/log/voucher directory"
)]
pub struct Cli {
    #[arg(
        long,
        env = "DRIP_API_BASE_URL",
        default_value = DEFAULT_API_BASE_URL,
        global = true,
        help = "Pool backend HTTP API"
    )]
    pub api_base_url: String,
    #[arg(
        long,
        env = "DRIP_POOL_URL",
        default_value = DEFAULT_POOL_URL,
        global = true,
        help = "Stratum mining pool URL for bundled XMRig"
    )]
    pub pool_url: String,
    #[arg(
        long,
        env = "DRIP_POOL_TLS",
        default_value_t = false,
        global = true,
        help = "Use TLS for the XMRig pool connection"
    )]
    pub pool_tls: bool,
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    #[command(about = "Show or create the local Ethereum mining identity")]
    Identity,
    #[command(about = "Start local proof-of-work and background voucher checkpoints")]
    Start {
        #[arg(long, help = "CPU threads to use")]
        threads: Option<usize>,
        #[arg(long, help = "Path to XMRig binary")]
        xmrig_path: Option<PathBuf>,
        #[arg(long, help = "Voucher checkpoint interval in seconds")]
        voucher_interval_seconds: Option<u64>,
    },
    #[command(about = "Resume local proof-of-work")]
    Resume {
        #[arg(long, help = "CPU threads to use")]
        threads: Option<usize>,
        #[arg(long, help = "Path to XMRig binary")]
        xmrig_path: Option<PathBuf>,
        #[arg(long, help = "Voucher checkpoint interval in seconds")]
        voucher_interval_seconds: Option<u64>,
    },
    #[command(about = "Stop local proof-of-work")]
    Stop,
    #[command(about = "Show local miner, pool, and voucher status")]
    Status,
    #[command(about = "Request and cache the latest cumulative voucher")]
    Checkpoint,
    #[command(about = "Replay the cached voucher to the pool backend")]
    Restore,
    #[command(about = "Prepare a local voucher claim")]
    Claim {
        #[arg(long, help = "Fetch a fresh voucher before preparing claim")]
        refresh: bool,
        #[arg(long, help = "Skip confirmation prompts when supported")]
        yes: bool,
    },
    #[command(about = "Prepare withdrawal into a target chain/token/address")]
    Withdraw {
        chain: String,
        token: String,
        recipient_address: String,
        #[arg(long, help = "Fetch a fresh voucher before preparing withdrawal")]
        refresh: bool,
        #[arg(long, help = "Skip confirmation prompts when supported")]
        yes: bool,
    },
    #[command(hide = true)]
    VoucherLoop {
        #[arg(long)]
        miner_pid: u32,
        #[arg(long)]
        interval_seconds: u64,
    },
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error("{0}")]
    Config(#[from] ConfigError),
    #[error("{0}")]
    Api(#[from] ApiError),
    #[error("{0}")]
    Voucher(#[from] VoucherError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to encode XMRig config: {0}")]
    Json(#[from] serde_json::Error),
    #[error("miner is already running with pid {0}")]
    AlreadyRunning(u32),
    #[error("miner is not running")]
    NotRunning,
    #[error("no local voucher found")]
    MissingVoucher,
    #[error("failed to stop process pid {pid}; signal command exited with {status}")]
    StopFailed { pid: u32, status: String },
    #[error("missing command")]
    Usage,
}

pub fn render_error(error: &CliError) -> String {
    match error {
        CliError::Usage => [
            "error: missing command",
            "",
            "Run one of:",
            "  drip start --threads 2",
            "  drip status",
            "  drip withdraw base-sepolia eth 0x...",
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
                "  drip start --threads 2",
                "",
                "This creates a local Ethereum identity and starts XMRig.",
            ]
            .join("\n")
        }
        CliError::MissingVoucher => [
            "error: no local voucher found",
            "",
            "Run:",
            "  drip checkpoint",
            "",
            "or mine until the next voucher checkpoint completes.",
        ]
        .join("\n"),
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
            "  drip start --threads 2".to_string(),
            "  drip status".to_string(),
        ]
        .join("\n"),
        CliError::Api(error) => [
            format!("error: pool backend unavailable ({error})"),
            String::new(),
            "Check:".to_string(),
            "  DRIP_API_BASE_URL".to_string(),
            "  network connectivity".to_string(),
        ]
        .join("\n"),
        _ => format!("error: {error}"),
    }
}

pub async fn run(cli: Cli) -> Result<(), CliError> {
    let Cli {
        api_base_url,
        pool_url,
        pool_tls,
        command,
    } = cli;

    match command {
        Some(Commands::Identity) => identity(&api_base_url, &pool_url, pool_tls),
        Some(Commands::Start {
            threads,
            xmrig_path,
            voucher_interval_seconds,
        })
        | Some(Commands::Resume {
            threads,
            xmrig_path,
            voucher_interval_seconds,
        }) => {
            start(
                &api_base_url,
                &pool_url,
                pool_tls,
                threads,
                xmrig_path,
                voucher_interval_seconds.unwrap_or(DEFAULT_VOUCHER_INTERVAL_SECONDS),
            )
            .await
        }
        Some(Commands::Stop) => stop(),
        Some(Commands::Status) => status().await,
        Some(Commands::Checkpoint) => checkpoint(true).await.map(|_| ()),
        Some(Commands::Restore) => restore().await,
        Some(Commands::Claim { refresh, yes }) => claim(refresh, yes).await,
        Some(Commands::Withdraw {
            chain,
            token,
            recipient_address,
            refresh,
            yes,
        }) => withdraw(&chain, &token, &recipient_address, refresh, yes).await,
        Some(Commands::VoucherLoop {
            miner_pid,
            interval_seconds,
        }) => voucher_loop(miner_pid, interval_seconds).await,
        None => Err(CliError::Usage),
    }
}

fn identity(api_base_url: &str, pool_url: &str, pool_tls: bool) -> Result<(), CliError> {
    let (config, created) = ensure_config(
        api_base_url,
        pool_url,
        pool_tls,
        DEFAULT_VOUCHER_INTERVAL_SECONDS,
    )?;

    println!("Identity");
    println!("  address: {}", config.identity.address);
    println!("  profile: {}", default_config_path()?.display());
    println!(
        "  status:  {}",
        if created { "created" } else { "existing" }
    );

    Ok(())
}

async fn start(
    api_base_url: &str,
    pool_url: &str,
    pool_tls: bool,
    threads: Option<usize>,
    xmrig_path: Option<PathBuf>,
    voucher_interval_seconds: u64,
) -> Result<(), CliError> {
    let pid_path = default_pid_path()?;

    if let Some(pid) = read_pid(&pid_path)? {
        if process_is_running(pid) {
            return Err(CliError::AlreadyRunning(pid));
        }
    }

    let (mut config, created) =
        ensure_config(api_base_url, pool_url, pool_tls, voucher_interval_seconds)?;
    config.voucher_interval_seconds = voucher_interval_seconds;
    save_config(&default_config_path()?, &config)?;

    let thread_count = threads.unwrap_or_else(default_threads);
    let log_path = default_log_path()?;
    let xmrig_path = resolve_xmrig_path(xmrig_path.as_deref());
    let xmrig_config = generate_xmrig_config(
        &config,
        XmrigSettings {
            threads: thread_count,
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
    detach_command(&mut command);

    let child = command.spawn()?;
    let pid = child.id();
    fs::write(&pid_path, format!("{pid}\n"))?;

    let voucher_pid = match spawn_voucher_loop(pid, voucher_interval_seconds) {
        Ok(voucher_pid) => voucher_pid,
        Err(error) => {
            let _ = stop_process(pid);
            let _ = fs::remove_file(&pid_path);
            return Err(error);
        }
    };

    println!("Mining started");
    println!("  address:  {}", config.identity.address);
    println!(
        "  identity: {}",
        if created { "created" } else { "existing" }
    );
    println!("  pid:      {pid}");
    println!("  threads:  {thread_count}");
    println!("  pool:     {}", config.mining_pool_url);
    println!("  voucher:  every {voucher_interval_seconds}s");
    println!("  helper:   pid {voucher_pid}");
    println!("  log:      {}", log_path.display());
    println!();
    println!("Observe:");
    println!("  drip status");

    Ok(())
}

fn stop() -> Result<(), CliError> {
    let miner_pid = read_pid(&default_pid_path()?)?;
    let voucher_pid = read_pid(&default_voucher_loop_pid_path()?)?;

    if miner_pid.is_none() && voucher_pid.is_none() {
        return Err(CliError::NotRunning);
    }

    if let Some(pid) = voucher_pid {
        stop_process(pid)?;
        let _ = fs::remove_file(default_voucher_loop_pid_path()?);
    }

    if let Some(pid) = miner_pid {
        stop_process(pid)?;
        let _ = fs::remove_file(default_pid_path()?);
    }

    println!("Mining stopped");
    if let Some(pid) = miner_pid {
        println!("  miner pid: {pid}");
    }
    if let Some(pid) = voucher_pid {
        println!("  voucher helper pid: {pid}");
    }

    Ok(())
}

async fn status() -> Result<(), CliError> {
    let config = load_config(&default_config_path()?)?;
    let miner_pid = read_pid(&default_pid_path()?)?.filter(|pid| process_is_running(*pid));
    let miner_status = ApiClient::new(&config.api_base_url)
        .miner_status(&config.identity.address)
        .await
        .ok();
    let voucher = match load_voucher(&default_voucher_path()?) {
        Ok(voucher) => Some(voucher),
        Err(VoucherError::Read { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            None
        }
        Err(error) => return Err(error.into()),
    };

    for line in render_status_sections(
        miner_pid,
        &config.identity.address,
        miner_status.as_ref(),
        voucher.as_ref(),
    ) {
        println!("{line}");
    }

    Ok(())
}

pub fn render_status_sections(
    miner_pid: Option<u32>,
    address: &str,
    miner_status: Option<&MinerStatus>,
    voucher: Option<&Voucher>,
) -> Vec<String> {
    let mut lines = vec![
        "Local miner".to_string(),
        format!(
            "  status: {}",
            if miner_pid.is_some() {
                "running"
            } else {
                "stopped"
            }
        ),
    ];

    if let Some(pid) = miner_pid {
        lines.push(format!("  pid:    {pid}"));
    }

    lines.push(String::new());
    lines.push("Identity".to_string());
    lines.push(format!("  address: {address}"));

    lines.push(String::new());
    lines.push("Pool".to_string());
    if let Some(status) = miner_status {
        lines.push(format!(
            "  hashrate: {}",
            format_optional_hashrate(status.hashrate)
        ));
        lines.push(format!(
            "  shares:   {} accepted, {} rejected",
            format_number(status.accepted_shares.unwrap_or_default()),
            format_number(status.rejected_shares.unwrap_or_default())
        ));
        lines.push(format!(
            "  owed:     {}",
            status.owed.as_deref().unwrap_or("n/a")
        ));
        lines.push(format!(
            "  paid:     {}",
            status.paid.as_deref().unwrap_or("n/a")
        ));
    } else {
        lines.push("  status:   unavailable".to_string());
    }

    lines.push(String::new());
    lines.push("Voucher".to_string());
    if let Some(voucher) = voucher {
        lines.push(format!(
            "  cached cumulative: {}",
            voucher.cumulative_amount
        ));
        lines.push(format!("  signed at:         {}", voucher.signed_at));
    } else {
        lines.push("  cached cumulative: none".to_string());
        lines.push("  signed at:         n/a".to_string());
    }

    lines
}

async fn checkpoint(verbose: bool) -> Result<VoucherOut, CliError> {
    let config = load_config(&default_config_path()?)?;
    let voucher_out = ApiClient::new(&config.api_base_url)
        .request_voucher(&config.identity.address)
        .await?;
    let voucher: Voucher = voucher_out.clone().into();
    let write = save_latest_voucher(&default_voucher_path()?, &voucher)?;

    if verbose {
        println!("Voucher checkpoint");
        println!("  address:    {}", voucher.user);
        println!("  cumulative: {}", voucher.cumulative_amount);
        println!("  signed_at:  {}", voucher.signed_at);
        println!(
            "  cache:      {}",
            match write {
                VoucherWrite::Stored => "updated",
                VoucherWrite::IgnoredOlder => "kept newer local voucher",
            }
        );
    }

    Ok(voucher_out)
}

async fn restore() -> Result<(), CliError> {
    let config = load_config(&default_config_path()?)?;
    let voucher = load_cached_voucher()?;
    ApiClient::new(&config.api_base_url)
        .restore(&voucher)
        .await?;

    println!("Voucher restored");
    println!("  address:    {}", voucher.user);
    println!("  cumulative: {}", voucher.cumulative_amount);

    Ok(())
}

async fn claim(refresh: bool, yes: bool) -> Result<(), CliError> {
    let refreshed = if refresh {
        Some(checkpoint(false).await?)
    } else {
        None
    };
    let voucher = load_cached_voucher()?;

    println!("Claim preview");
    println!("  owner:      {}", voucher.user);
    println!("  cumulative: {}", voucher.cumulative_amount);
    println!("  signed_at:  {}", voucher.signed_at);
    if let Some(refreshed) = refreshed {
        if let Some(on_chain_claimed) = refreshed.on_chain_claimed {
            println!("  claimed:    {on_chain_claimed}");
        }
    }
    println!("  confirm:    {}", if yes { "skipped" } else { "required" });
    println!();
    println!("Claim transaction submission needs the final MiningPoolToken RPC/config.");

    Ok(())
}

async fn withdraw(
    chain: &str,
    token: &str,
    recipient_address: &str,
    refresh: bool,
    yes: bool,
) -> Result<(), CliError> {
    if refresh {
        checkpoint(false).await?;
    }
    let voucher = load_cached_voucher()?;

    println!("Withdraw preview");
    println!("  owner:      {}", voucher.user);
    println!("  cumulative: {}", voucher.cumulative_amount);
    println!("  target:     {chain} {token}");
    println!("  recipient:  {recipient_address}");
    println!("  confirm:    {}", if yes { "skipped" } else { "required" });
    println!();
    println!("Relayer submission needs the final withdraw endpoint/config.");

    Ok(())
}

async fn voucher_loop(miner_pid: u32, interval_seconds: u64) -> Result<(), CliError> {
    while process_is_running(miner_pid) {
        if let Err(error) = checkpoint(false).await {
            eprintln!("voucher checkpoint failed: {error}");
        }

        tokio::time::sleep(Duration::from_secs(interval_seconds)).await;
    }

    Ok(())
}

fn ensure_config(
    api_base_url: &str,
    pool_url: &str,
    pool_tls: bool,
    voucher_interval_seconds: u64,
) -> Result<(StoredConfig, bool), CliError> {
    load_or_create_config(
        &default_config_path()?,
        &ConfigDefaults {
            api_base_url: api_base_url.to_string(),
            mining_pool_url: pool_url.to_string(),
            mining_pool_tls: pool_tls,
            voucher_interval_seconds,
        },
    )
    .map_err(CliError::from)
}

fn load_cached_voucher() -> Result<Voucher, CliError> {
    match load_voucher(&default_voucher_path()?) {
        Ok(voucher) => Ok(voucher),
        Err(VoucherError::Read { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            Err(CliError::MissingVoucher)
        }
        Err(error) => Err(error.into()),
    }
}

fn spawn_voucher_loop(miner_pid: u32, interval_seconds: u64) -> Result<u32, CliError> {
    let loop_log_path = default_voucher_loop_log_path()?;
    if let Some(parent) = loop_log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&loop_log_path)?;

    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("voucher-loop")
        .arg("--miner-pid")
        .arg(miner_pid.to_string())
        .arg("--interval-seconds")
        .arg(interval_seconds.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    detach_command(&mut command);

    let child = command.spawn()?;
    let pid = child.id();
    fs::write(default_voucher_loop_pid_path()?, format!("{pid}\n"))?;
    Ok(pid)
}

fn stop_process(pid: u32) -> Result<(), CliError> {
    if !process_is_running(pid) {
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
            return Ok(());
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

fn signal_process(pid: u32, signal: &str) -> std::io::Result<std::process::ExitStatus> {
    Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .status()
}

fn detach_command(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }

            libc::signal(libc::SIGHUP, libc::SIG_IGN);
            Ok(())
        });
    }
}

fn format_optional_hashrate(value: Option<f64>) -> String {
    value
        .map(|value| format!("{} H/s", format_decimal(value, 2)))
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

fn format_decimal(value: f64, precision: usize) -> String {
    let rendered = format!("{value:.precision$}");
    let Some((whole, fraction)) = rendered.split_once('.') else {
        return rendered;
    };
    let whole = whole.parse::<i64>().unwrap_or_default();
    format!("{}.{}", format_number(whole), fraction)
}
