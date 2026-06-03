use pretty_assertions::assert_eq;
use serde_json::json;
use xpool_gate::{
    shares::ShareSubmit,
    stratum::{
        error_response, extract_job, extract_login, extract_submit, rewrite_login_password,
        JobMessage, LoginMessage,
    },
};

#[test]
fn extracts_and_rewrites_login_password() {
    let mut line = json!({
        "id": 1,
        "jsonrpc": "2.0",
        "method": "login",
        "params": {
            "login": "w_abc",
            "pass": "xp_worker_token",
            "rigid": "w_abc",
            "agent": "XMRig/6.26.0"
        }
    });

    assert_eq!(
        extract_login(&line),
        Some(LoginMessage {
            worker_name: "w_abc".to_string(),
            password: "xp_worker_token".to_string(),
        })
    );

    rewrite_login_password(&mut line, "xpool-dev").expect("rewrite");

    assert_eq!(line["params"]["login"], "w_abc");
    assert_eq!(line["params"]["pass"], "xpool-dev");
}

#[test]
fn extracts_job_from_login_response_and_job_notification() {
    let login_response = json!({
        "id": 1,
        "jsonrpc": "2.0",
        "error": null,
        "result": {
            "id": "rpc-session",
            "job": {
                "job_id": "job-a",
                "blob": "blob-a",
                "height": 100,
                "target": "ffff0011"
            },
            "status": "OK"
        }
    });
    let notification = json!({
        "jsonrpc": "2.0",
        "method": "job",
        "params": {
            "job_id": "job-b",
            "blob": "blob-b",
            "height": 100,
            "target": "ffff0011"
        }
    });

    assert_eq!(
        extract_job(&login_response),
        Some(JobMessage {
            job_id: "job-a".to_string(),
            height: 100,
            blob: "blob-a".to_string(),
        })
    );
    assert_eq!(
        extract_job(&notification),
        Some(JobMessage {
            job_id: "job-b".to_string(),
            height: 100,
            blob: "blob-b".to_string(),
        })
    );
}

#[test]
fn extracts_submit_fields() {
    let line = json!({
        "id": 3,
        "jsonrpc": "2.0",
        "method": "submit",
        "params": {
            "id": "rpc-session",
            "job_id": "job-a",
            "nonce": "00000001",
            "result": "abcd",
            "algo": "rx/0",
            "sig": "signature",
            "commitment": "commitment"
        }
    });

    assert_eq!(
        extract_submit(&line),
        Some(ShareSubmit {
            job_id: "job-a".to_string(),
            nonce: "00000001".to_string(),
            result: "abcd".to_string(),
            algorithm: Some("rx/0".to_string()),
            signature: Some("signature".to_string()),
            commitment: Some("commitment".to_string()),
        })
    );
}

#[test]
fn builds_jsonrpc_error_response() {
    assert_eq!(
        error_response(&json!(5), "Duplicate share"),
        json!({
            "id": 5,
            "jsonrpc": "2.0",
            "error": {
                "code": -1,
                "message": "Duplicate share"
            }
        })
    );
}
