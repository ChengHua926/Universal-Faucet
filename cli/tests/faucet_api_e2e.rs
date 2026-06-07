use std::{
    fs,
    io::{self, Read, Write},
    net::TcpListener,
    process::Command,
    sync::mpsc,
    thread,
};

const ADDRESS: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const PRIVATE_KEY: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";

#[test]
fn status_reads_faucet_pool_and_miner_api() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let Some((base_url, requests)) = spawn_json_server(vec![
        (
            "/pool",
            r#"{
              "hashrate": 1234.5,
              "total_work": 42000,
              "active_miners": 3,
              "upstream": {
                "connected": true,
                "last_change_unix": 1780000000,
                "consecutive_failures": 0,
                "submit_rejects_total": 1,
                "submit_accepts_total": 99
              }
            }"#,
        ),
        (
            &format!("/miner/{ADDRESS}"),
            r#"{
              "miner": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
              "cumulative_owed_atomic": 4000000000000,
              "last_voucher_cumulative": 3000000000000,
              "shares": 12,
              "work": 24000,
              "last_share_ms": 1780000000123
            }"#,
        ),
        (
            "/onion",
            r#"{
              "onion": "abc123.onion",
              "stratum": "abc123.onion:3333",
              "api": "http://abc123.onion"
            }"#,
        ),
    ]) else {
        return;
    };
    write_config(temp_dir.path(), &base_url);

    let output = Command::new(env!("CARGO_BIN_EXE_drip"))
        .env("DRIP_HOME", temp_dir.path())
        .arg("status")
        .output()
        .expect("run drip status");

    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(stdout.contains("upstream: connected"), "{stdout}");
    assert!(
        stdout.contains("owed atomic xmr:   4,000,000,000,000"),
        "{stdout}"
    );
    assert!(
        stdout.contains("voucher watermark: 3,000,000,000,000"),
        "{stdout}"
    );
    assert!(stdout.contains("shares:            12"), "{stdout}");
    assert!(
        stdout.contains("tor stratum: abc123.onion:3333"),
        "{stdout}"
    );
    assert_eq!(
        requests.into_iter().collect::<Vec<_>>(),
        vec!["GET /pool", &format!("GET /miner/{ADDRESS}"), "GET /onion"]
    );
}

#[test]
fn checkpoint_requests_and_caches_faucet_voucher() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let Some((base_url, requests)) = spawn_json_server(vec![(
        "/voucher",
        r#"{
          "user": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
          "cumulative_amount": "4000000000000",
          "marginal": 1000000000000,
          "signed_at": 1780000000,
          "signature": "0xsignature",
          "earned_cumulative": 4000000000000,
          "last_voucher_cumulative": 4000000000000,
          "on_chain_claimed": "3000000000000"
        }"#,
    )]) else {
        return;
    };
    write_config(temp_dir.path(), &base_url);

    let output = Command::new(env!("CARGO_BIN_EXE_drip"))
        .env("DRIP_HOME", temp_dir.path())
        .arg("checkpoint")
        .output()
        .expect("run drip checkpoint");

    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let voucher = fs::read_to_string(temp_dir.path().join("voucher.json")).expect("voucher file");
    assert!(voucher.contains(r#""cumulative_amount": "4000000000000""#));
    assert!(voucher.contains(r#""signature": "0xsignature""#));
    assert_eq!(
        requests.into_iter().collect::<Vec<_>>(),
        vec!["POST /voucher"]
    );
}

fn write_config(home: &std::path::Path, api_base_url: &str) {
    fs::write(
        home.join("config.json"),
        format!(
            r#"{{
              "api_base_url": "{api_base_url}",
              "mining_pool_url": "127.0.0.1:3333",
              "mining_pool_tls": false,
              "voucher_interval_seconds": 300,
              "identity": {{
                "address": "{ADDRESS}",
                "private_key": "{PRIVATE_KEY}"
              }}
            }}"#
        ),
    )
    .expect("write config");
}

fn spawn_json_server(routes: Vec<(&str, &str)>) -> Option<(String, mpsc::Receiver<String>)> {
    match try_spawn_json_server(routes) {
        Ok(server) => Some(server),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            eprintln!("skipping faucet API e2e: local mock server bind denied: {error}");
            None
        }
        Err(error) => panic!("bind mock server: {error}"),
    }
}

fn try_spawn_json_server(
    routes: Vec<(&str, &str)>,
) -> io::Result<(String, mpsc::Receiver<String>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let base_url = format!("http://{}", listener.local_addr()?);
    let (tx, rx) = mpsc::channel();
    let routes: Vec<(String, String)> = routes
        .into_iter()
        .map(|(path, body)| (path.to_string(), body.to_string()))
        .collect();

    thread::spawn(move || {
        for (expected_path, body) in routes {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 8192];
            let read = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..read]);
            let request_line = request.lines().next().expect("request line");
            let mut parts = request_line.split_whitespace();
            let method = parts.next().expect("method");
            let path = parts.next().expect("path");
            assert_eq!(path, expected_path);
            tx.send(format!("{method} {path}")).expect("send request");

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        }
    });

    Ok((base_url, rx))
}
