use pretty_assertions::assert_eq;
use xpool_backend::proxy::workers::{parse_workers_response, ProxyWorker};

#[test]
fn parses_xmrig_proxy_worker_rows() {
    let body = r#"
    {
      "hashrate": {
        "total": [0.88, 0.11, 0.01, 0.0, 0.0, 0.09]
      },
      "mode": "rig_id",
      "workers": [
        ["alice.macbook1", "127.0.0.1", 1, 44, 0, 0, 44000, 1780428243786, 0.51, 0.07, 0.01, 0.0, 0.0],
        ["bob.macbook1", "127.0.0.1", 1, 22, 0, 0, 22000, 1780428244488, 0.36, 0.03, 0.0, 0.0, 0.0]
      ]
    }
    "#;

    let workers = parse_workers_response(body).expect("valid proxy response");

    assert_eq!(
        workers,
        vec![
            ProxyWorker {
                name: "alice.macbook1".to_string(),
                address: "127.0.0.1".to_string(),
                connections: 1,
                accepted_shares: 44,
                rejected_shares: 0,
                invalid_shares: 0,
                total_hashes: 44000,
                last_share_timestamp_ms: Some(1780428243786),
                hashrates: vec![0.51, 0.07, 0.01, 0.0, 0.0],
                raw: serde_json::json!([
                    "alice.macbook1",
                    "127.0.0.1",
                    1,
                    44,
                    0,
                    0,
                    44000,
                    1780428243786i64,
                    0.51,
                    0.07,
                    0.01,
                    0.0,
                    0.0
                ]),
            },
            ProxyWorker {
                name: "bob.macbook1".to_string(),
                address: "127.0.0.1".to_string(),
                connections: 1,
                accepted_shares: 22,
                rejected_shares: 0,
                invalid_shares: 0,
                total_hashes: 22000,
                last_share_timestamp_ms: Some(1780428244488),
                hashrates: vec![0.36, 0.03, 0.0, 0.0, 0.0],
                raw: serde_json::json!([
                    "bob.macbook1",
                    "127.0.0.1",
                    1,
                    22,
                    0,
                    0,
                    22000,
                    1780428244488i64,
                    0.36,
                    0.03,
                    0.0,
                    0.0,
                    0.0
                ]),
            }
        ]
    );
}

#[test]
fn rejects_short_worker_rows() {
    let body = r#"{ "hashrate": { "total": [] }, "mode": "rig_id", "workers": [["too-short"]] }"#;

    let error = parse_workers_response(body).expect_err("short rows should fail");

    assert!(
        error.to_string().contains("too few fields"),
        "unexpected error: {error}"
    );
}
