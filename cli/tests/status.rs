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
            "server connected true".to_string(),
            "worker w_32e47f31771c457f96a19e617421a327 (alice / macbook1)".to_string(),
            "shares accepted=3 rejected=1 invalid=0".to_string(),
            "hashes 33000".to_string(),
            "hashrate 10s=0.83 60s=0.13 15m=0.02".to_string(),
            "paper-share points=30000 shares=3 hashes=33000".to_string(),
            "intent base-sepolia eth 0x1111111111111111111111111111111111111111 active".to_string(),
            "settlement pending=1 submitted=0 confirmed=0 failed=0 pending_amount=30000"
                .to_string(),
        ]
    );
}
