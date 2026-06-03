use std::{path::PathBuf, time::Duration};

use anyhow::{bail, Context};
use clap::Parser;
use ethers::types::Address;

use crate::types::SignatureScheme;

/// Default bootstrap contract address. Override for local/dev deployments.
/// Replace this value with the canonical address before a production release.
pub const DEFAULT_BOOTSTRAP_CONTRACT: &str = "0x0000000000000000000000000000000000000c0f";

#[derive(Debug, Clone, Parser)]
#[command(
    name = "crossroads-committee",
    about = "Crossroads signing committee using NEAR threshold-signatures"
)]
pub struct Config {
    #[arg(long, env = "COMMITTEE_LISTEN", default_value = "0.0.0.0:8080")]
    pub listen: String,

    #[arg(long, env = "COMMITTEE_SELF_MEMBER_ID")]
    pub self_member_id: String,

    #[arg(long, env = "EVM_RPC_URL")]
    pub evm_rpc_url: String,

    #[arg(long, env = "BOOTSTRAP_CONTRACT", default_value = DEFAULT_BOOTSTRAP_CONTRACT)]
    pub bootstrap_contract: String,

    /// Local root share for the NEAR robust secp256k1 ECDSA root.
    #[arg(
        long,
        env = "ECDSA_ROOT_SHARE_FILE",
        default_value = "./secrets/root-ecdsa.json"
    )]
    pub ecdsa_root_share_file: PathBuf,

    /// Local root share for the NEAR FROST Ed25519 root.
    #[arg(
        long,
        env = "ED25519_ROOT_SHARE_FILE",
        default_value = "./secrets/root-ed25519.json"
    )]
    pub ed25519_root_share_file: PathBuf,

    /// Admin private key used only to submit root public key records after DKG.
    /// The node can run without this, but then operators must submit records externally.
    #[arg(long, env = "ADMIN_PRIVATE_KEY")]
    pub admin_private_key: Option<String>,

    #[arg(long, env = "PUBLIC_ENDPOINT")]
    pub public_endpoint_override: Option<String>,

    #[arg(long, env = "REQUEST_TIMEOUT_SECS", default_value_t = 120)]
    pub request_timeout_secs: u64,

    #[arg(long, env = "MPC_ROUND_TIMEOUT_SECS", default_value_t = 180)]
    pub mpc_round_timeout_secs: u64,

    /// ECDSA prehash/encoding mode for ECDSA asset contracts.
    /// Ed25519 asset contracts always sign the raw bytes represented by `message`.
    #[arg(long, env = "ECDSA_SIGNATURE_KIND", default_value = "raw32")]
    pub ecdsa_signature_kind: String,
}

impl Config {
    pub fn parse_and_validate() -> anyhow::Result<Self> {
        let cfg = Config::parse();
        if cfg.self_member_id.trim().is_empty() {
            bail!("--self-member-id is required");
        }
        let _: Address = cfg
            .bootstrap_contract
            .parse()
            .context("invalid bootstrap contract address")?;
        match cfg.ecdsa_signature_kind.as_str() {
            "raw32" | "eth-keccak" | "btc-sha256" => {}
            other => bail!("unsupported --ecdsa-signature-kind {other:?}; use raw32, eth-keccak, or btc-sha256"),
        }
        Ok(cfg)
    }

    pub fn root_share_file(&self, scheme: SignatureScheme) -> PathBuf {
        match scheme {
            SignatureScheme::EcdsaSecp256k1 => self.ecdsa_root_share_file.clone(),
            SignatureScheme::Ed25519 => self.ed25519_root_share_file.clone(),
        }
    }

    pub fn request_timeout(&self) -> Duration {
        Duration::from_secs(self.request_timeout_secs)
    }
    pub fn mpc_round_timeout(&self) -> Duration {
        Duration::from_secs(self.mpc_round_timeout_secs)
    }
    pub fn bootstrap_address(&self) -> anyhow::Result<Address> {
        self.bootstrap_contract
            .parse()
            .context("invalid bootstrap contract address")
    }
}
