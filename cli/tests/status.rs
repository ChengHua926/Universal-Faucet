use pretty_assertions::assert_eq;
use xpool_cli::{
    api::{ActivePayoutIntent, LiveWorkerStatus, SettlementSummary},
    commands::render_live_worker_status,
};

#[test]
fn renders_live_worker_status_for_cli_output() {
    let status = LiveWorkerStatus {
        user_id: "user-id".to_string(),
        worker_id: "worker-id".to_string(),
        worker_name: "w_32e47f31771c457f96a19e617421a327".to_string(),
        display_name: "alice".to_string(),
        machine_label: Some("macbook1".to_string()),
        connected: true,
        connections: 2,
        accepted_shares: 3,
        rejected_shares: 1,
        invalid_shares: 0,
        total_hashes: 33_000,
        last_share_timestamp_ms: Some(1_780_435_091_271),
        hashrate_10s: Some(0.83),
        hashrate_60s: Some(0.13),
        hashrate_15m: Some(0.02),
        observed_at: Some("2026-06-04 01:00:00+00".to_string()),
        updated_at: Some("2026-06-04 01:00:00+00".to_string()),
        paper_share_points: 30_000,
        accepted_share_credits: 3,
        hash_credits: 33_000,
        active_payout_intent: Some(ActivePayoutIntent {
            id: "intent-id".to_string(),
            target_chain: "base-sepolia".to_string(),
            target_token: "eth".to_string(),
            recipient_address: "0x1111111111111111111111111111111111111111".to_string(),
            receive_pool_token: false,
            status: "active".to_string(),
        }),
        settlement: SettlementSummary {
            pending_count: 1,
            submitted_count: 0,
            confirmed_count: 0,
            failed_count: 0,
            pending_amount: 30_000,
        },
    };

    assert_eq!(
        render_live_worker_status(&status),
        vec![
            "Worker".to_string(),
            "  name:        w_32e47f31771c457f96a19e617421a327".to_string(),
            "  user/device: alice / macbook1".to_string(),
            "  server:      connected (2 connections)".to_string(),
            "".to_string(),
            "Mining".to_string(),
            "  shares:      3 accepted, 1 rejected, 0 invalid".to_string(),
            "  hashes:      33,000".to_string(),
            "  hashrate:    0.83 H/s 10s, 0.13 H/s 60s, 0.02 H/s 15m".to_string(),
            "".to_string(),
            "Credit".to_string(),
            "  paper-share: 30,000 points".to_string(),
            "  source:      3 accepted shares, 33,000 hashes".to_string(),
            "".to_string(),
            "Payout".to_string(),
            "  intent:      active -> base-sepolia eth".to_string(),
            "  recipient:   0x1111111111111111111111111111111111111111".to_string(),
            "  settlement:  1 pending (30,000), 0 submitted, 0 confirmed, 0 failed".to_string(),
        ]
    );
}
