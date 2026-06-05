use clap::Parser;
use xpool_cli::commands::{render_error, run, Cli};

#[tokio::main]
async fn main() {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("{}", render_error(&error));
        std::process::exit(1);
    }
}
