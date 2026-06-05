use clap::{CommandFactory, Parser};
use drip_cli::commands::{render_error, run, Cli, CliError, Commands};
use pretty_assertions::assert_eq;

#[test]
fn user_facing_command_is_drip() {
    assert_eq!(Cli::command().get_name(), "drip");
}

#[test]
fn parses_start_with_voucher_interval_and_pool_url() {
    let cli = Cli::parse_from([
        "drip",
        "--pool-url",
        "pool.example.com:443",
        "start",
        "--threads",
        "2",
        "--voucher-interval-seconds",
        "60",
    ]);

    assert_eq!(cli.pool_url, "pool.example.com:443");
    match cli.command {
        Some(Commands::Start {
            threads,
            voucher_interval_seconds,
            ..
        }) => {
            assert_eq!(threads, Some(2));
            assert_eq!(voucher_interval_seconds, Some(60));
        }
        other => panic!("expected start command, got {other:?}"),
    }
}

#[test]
fn parses_redemption_commands() {
    let claim = Cli::parse_from(["drip", "claim", "--refresh", "--yes"]);
    match claim.command {
        Some(Commands::Claim { refresh, yes }) => {
            assert_eq!(refresh, true);
            assert_eq!(yes, true);
        }
        other => panic!("expected claim command, got {other:?}"),
    }

    let withdraw = Cli::parse_from([
        "drip",
        "withdraw",
        "base-sepolia",
        "eth",
        "0x1111111111111111111111111111111111111111",
        "--refresh",
        "--yes",
    ]);
    match withdraw.command {
        Some(Commands::Withdraw {
            chain,
            token,
            recipient_address,
            refresh,
            yes,
        }) => {
            assert_eq!(chain, "base-sepolia");
            assert_eq!(token, "eth");
            assert_eq!(
                recipient_address,
                "0x1111111111111111111111111111111111111111"
            );
            assert_eq!(refresh, true);
            assert_eq!(yes, true);
        }
        other => panic!("expected withdraw command, got {other:?}"),
    }
}

#[test]
fn help_contains_cli_only_commands() {
    let help = Cli::command().render_help().to_string();

    assert!(help.contains("drip start --threads 2"));
    assert!(help.contains("identity"));
    assert!(help.contains("checkpoint"));
    assert!(help.contains("restore"));
    assert!(help.contains("withdraw"));
    assert!(!help.contains("enroll"));
    assert!(!help.contains("leaderboard"));
}

#[tokio::test]
async fn bare_drip_returns_actionable_usage() {
    let cli = Cli::try_parse_from(["drip"]).expect("bare drip should parse before validation");
    let error = run(cli)
        .await
        .expect_err("bare drip should fail usage validation");

    assert_eq!(error.to_string(), "missing command");
    assert_eq!(
        render_error(&error),
        [
            "error: missing command",
            "",
            "Run one of:",
            "  drip start --threads 2",
            "  drip status",
            "  drip withdraw base-sepolia eth 0x...",
            "",
            "See: drip --help",
        ]
        .join("\n")
    );
}

#[test]
fn missing_voucher_error_is_actionable() {
    let error = CliError::MissingVoucher;

    assert_eq!(
        render_error(&error),
        [
            "error: no local voucher found",
            "",
            "Run:",
            "  drip checkpoint",
            "",
            "or mine until the next voucher checkpoint completes.",
        ]
        .join("\n")
    );
}
