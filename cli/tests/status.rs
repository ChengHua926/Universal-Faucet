use drip_cli::{api::MinerStatus, commands::render_status_sections, voucher::Voucher};
use pretty_assertions::assert_eq;

#[test]
fn renders_cli_only_status_for_miner_and_voucher() {
    let status = MinerStatus {
        address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string(),
        hashrate: Some(1234.5),
        accepted_shares: Some(12),
        rejected_shares: Some(1),
        owed: Some("4000000000000".to_string()),
        paid: Some("1000000000000".to_string()),
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
            Some(&status),
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
            "  hashrate: 1,234.50 H/s".to_string(),
            "  shares:   12 accepted, 1 rejected".to_string(),
            "  owed:     4000000000000".to_string(),
            "  paid:     1000000000000".to_string(),
            "".to_string(),
            "Voucher".to_string(),
            "  cached cumulative: 3000000000000".to_string(),
            "  signed at:         1780000000".to_string(),
        ]
    );
}
