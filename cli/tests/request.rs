use clap::{CommandFactory, Parser};
use pretty_assertions::assert_eq;
use xpool_cli::commands::{render_error, run, Cli, CliError, Commands};

#[test]
fn user_facing_command_is_drip() {
    assert_eq!(Cli::command().get_name(), "drip");
}

#[test]
fn parses_faucet_request_command() {
    let cli = Cli::parse_from([
        "drip",
        "request",
        "base-sepolia",
        "eth",
        "0x1111111111111111111111111111111111111111",
        "--receive-pool-token",
    ]);

    match cli.command {
        Some(Commands::Request {
            chain,
            token,
            recipient_address,
            receive_pool_token,
        }) => {
            assert_eq!(chain, "base-sepolia");
            assert_eq!(token, "eth");
            assert_eq!(
                recipient_address,
                "0x1111111111111111111111111111111111111111"
            );
            assert_eq!(receive_pool_token, true);
        }
        other => panic!("expected request command, got {other:?}"),
    }
}

#[test]
fn parses_direct_faucet_request() {
    let cli = Cli::try_parse_from([
        "drip",
        "base-sepolia",
        "eth",
        "0x1111111111111111111111111111111111111111",
        "--receive-pool-token",
    ])
    .expect("direct request should parse");

    assert!(cli.command.is_none());
    assert_eq!(cli.chain.as_deref(), Some("base-sepolia"));
    assert_eq!(cli.token.as_deref(), Some("eth"));
    assert_eq!(
        cli.recipient_address.as_deref(),
        Some("0x1111111111111111111111111111111111111111")
    );
    assert_eq!(cli.receive_pool_token, true);
}

#[tokio::test]
async fn direct_request_requires_complete_tuple() {
    let cli = Cli::try_parse_from(["drip"]).expect("bare drip should parse before validation");
    let error = run(cli)
        .await
        .expect_err("bare drip should fail usage validation");

    assert_eq!(error.to_string(), "missing faucet request");
    assert_eq!(
        render_error(&error),
        [
            "error: missing faucet request",
            "",
            "Run one of:",
            "  drip enroll --name alice",
            "  drip base-sepolia eth 0x...",
            "  drip status",
            "",
            "See: drip --help",
        ]
        .join("\n")
    );
}

#[test]
fn help_contains_product_examples_and_command_descriptions() {
    let help = Cli::command().render_help().to_string();

    assert!(help.contains("Usage: drip [OPTIONS] [CHAIN] [TOKEN] [RECIPIENT_ADDRESS] [COMMAND]"));
    assert!(help.contains("drip base-sepolia eth 0x1111111111111111111111111111111111111111"));
    assert!(help.contains("Enroll this device"));
    assert!(help.contains("Start local proof-of-work"));
    assert!(help.contains("Show local miner and server credit status"));
}

#[test]
fn config_errors_tell_user_to_enroll_first() {
    let error = CliError::Config(xpool_cli::config::ConfigError::Read {
        path: "/tmp/drip/config.json".into(),
        source: std::io::Error::from(std::io::ErrorKind::NotFound),
    });

    assert_eq!(
        render_error(&error),
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
    );
}
