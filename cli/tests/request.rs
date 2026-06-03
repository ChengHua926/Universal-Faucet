use clap::{CommandFactory, Parser};
use pretty_assertions::assert_eq;
use xpool_cli::commands::{Cli, Commands};

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
        Commands::Request {
            chain,
            token,
            recipient_address,
            receive_pool_token,
        } => {
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
