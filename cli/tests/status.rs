use drip_cli::{
    api::{MinerStatus, OnionStatus, PoolStatus, UpstreamStatus},
    commands::render_status_sections,
    voucher::Voucher,
};
use pretty_assertions::assert_eq;

#[test]
fn renders_faucet_pool_status_for_miner_and_voucher() {
    let pool = PoolStatus {
        hashrate: 1234.5,
        total_work: 42_000,
        active_miners: 3,
        upstream: UpstreamStatus {
            connected: true,
            last_change_unix: 1_780_000_000,
            consecutive_failures: 0,
            submit_rejects_total: 1,
            submit_accepts_total: 99,
        },
    };
    let miner = MinerStatus {
        miner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string(),
        cumulative_owed_atomic: 4_000_000_000_000,
        last_voucher_cumulative: 3_000_000_000_000,
        shares: 12,
        work: 24_000,
        last_share_ms: 1_780_000_000_123,
    };
    let onion = OnionStatus {
        onion: Some("abc123.onion".to_string()),
        stratum: Some("abc123.onion:3333".to_string()),
        api: Some("http://abc123.onion".to_string()),
    };
    let voucher = Voucher {
        user: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string(),
        cumulative_amount: "3000000000000".to_string(),
        signed_at: 1_780_000_000,
        signature: "0xsignature".to_string(),
    };

    assert_eq!(
        render_status_sections(
            Some(1234),
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            Some(&pool),
            Some(&onion),
            Some(&miner),
            Some(&voucher)
        ),
        vec![
            "Local miner".to_string(),
            "  status: running".to_string(),
            "  pid:    1234".to_string(),
            "".to_string(),
            "Identity".to_string(),
            "  address: 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string(),
            "".to_string(),
            "Pool".to_string(),
            "  upstream: connected".to_string(),
            "  hashrate: 1,234.50 H/s".to_string(),
            "  active miners: 3".to_string(),
            "  total work: 42,000".to_string(),
            "  tor stratum: abc123.onion:3333".to_string(),
            "".to_string(),
            "Miner credit".to_string(),
            "  owed atomic xmr:   4,000,000,000,000".to_string(),
            "  voucher watermark: 3,000,000,000,000".to_string(),
            "  shares:            12".to_string(),
            "  work:              24,000".to_string(),
            "  last share ms:     1,780,000,000,123".to_string(),
            "".to_string(),
            "Voucher".to_string(),
            "  cached cumulative: 3000000000000".to_string(),
            "  signed at:         1780000000".to_string(),
        ]
    );
}
