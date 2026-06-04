use clap::{CommandFactory, Parser};
use pretty_assertions::assert_eq;
use xpool_cli::commands::{run, Cli, Commands};

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

    assert_eq!(
        error.to_string(),
        "usage: drip <chain> <token> <recipient-address> or drip <command>"
    );
}
