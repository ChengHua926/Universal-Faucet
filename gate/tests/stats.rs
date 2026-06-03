use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pretty_assertions::assert_eq;
use xpool_gate::stats::{GateStats, ShareOutcome};

#[test]
fn records_accepted_rejected_and_invalid_worker_rows() {
    let stats = GateStats::default();
    let now_ms = unix_ms();

    stats.record_login("w_alice", "127.0.0.1");
    stats.record_login("w_alice", "127.0.0.1");
    stats.record_share("w_alice", ShareOutcome::Accepted { hashes: 10_000 }, now_ms);
    stats.record_share("w_alice", ShareOutcome::Rejected, now_ms + 1);
    stats.record_share("w_alice", ShareOutcome::Invalid, now_ms + 2);
    stats.record_disconnect("w_alice");

    let response = stats.workers_response();
    let workers = response["workers"].as_array().expect("workers array");

    assert_eq!(workers.len(), 1);
    assert_eq!(workers[0][0], "w_alice");
    assert_eq!(workers[0][1], "127.0.0.1");
    assert_eq!(workers[0][2], 1);
    assert_eq!(workers[0][3], 1);
    assert_eq!(workers[0][4], 1);
    assert_eq!(workers[0][5], 1);
    assert_eq!(workers[0][6], 10_000);
    assert_eq!(workers[0][7], now_ms + 2);
}

#[test]
fn disconnect_does_not_underflow_connections() {
    let stats = GateStats::default();

    stats.record_disconnect("w_missing");
    stats.record_login("w_bob", "127.0.0.1");
    stats.record_disconnect("w_bob");
    stats.record_disconnect("w_bob");

    let response = stats.workers_response();
    assert_eq!(response["workers"][0][2], 0);
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}
