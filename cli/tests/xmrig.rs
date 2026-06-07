use drip_cli::{
    config::{StoredConfig, StoredIdentity},
    xmrig::{
        bundled_xmrig_path_for, generate_xmrig_config, packaged_xmrig_path_for_exe, XmrigSettings,
    },
};
use pretty_assertions::assert_eq;
use std::path::Path;

#[test]
fn generates_xmrig_config_using_ethereum_address_as_username() {
    let stored = StoredConfig {
        api_base_url: "http://127.0.0.1:8081".to_string(),
        mining_pool_url: "pool.example.com:443".to_string(),
        mining_pool_tls: true,
        tor_socks5: None,
        voucher_interval_seconds: 300,
        identity: StoredIdentity {
            address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string(),
            private_key: "0x0000000000000000000000000000000000000000000000000000000000000001"
                .to_string(),
        },
    };

    let config = generate_xmrig_config(
        &stored,
        XmrigSettings {
            threads: 2,
            log_file: None,
        },
    );
    let json = serde_json::to_value(config).expect("json");

    assert_eq!(json["autosave"], false);
    assert_eq!(json["cpu"]["enabled"], true);
    assert_eq!(json["cpu"]["rx"], serde_json::json!([-1, -1]));
    assert_eq!(json["pools"][0]["url"], "pool.example.com:443");
    assert_eq!(
        json["pools"][0]["user"],
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
    assert_eq!(json["pools"][0]["pass"], "x");
    assert_eq!(
        json["pools"][0]["rig-id"],
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
    assert_eq!(json["pools"][0]["keepalive"], true);
    assert_eq!(json["pools"][0]["tls"], true);

    let object = json.as_object().expect("object");
    assert!(
        !object.contains_key("private_key"),
        "XMRig config must never expose the local Ethereum private key"
    );
}

#[test]
fn generates_xmrig_config_with_tor_socks5_proxy() {
    let stored = StoredConfig {
        api_base_url: "http://vj3o34twitcqk7jxopms5mpoxeurqjfdpvlpnxgmkveld3nggmzsmtid.onion"
            .to_string(),
        mining_pool_url: "vj3o34twitcqk7jxopms5mpoxeurqjfdpvlpnxgmkveld3nggmzsmtid.onion:3333"
            .to_string(),
        mining_pool_tls: false,
        tor_socks5: Some("socks5://localhost:9050".to_string()),
        voucher_interval_seconds: 300,
        identity: StoredIdentity {
            address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string(),
            private_key: "0x0000000000000000000000000000000000000000000000000000000000000001"
                .to_string(),
        },
    };

    let config = generate_xmrig_config(
        &stored,
        XmrigSettings {
            threads: 1,
            log_file: None,
        },
    );
    let json = serde_json::to_value(config).expect("json");

    assert_eq!(
        json["pools"][0]["url"],
        "vj3o34twitcqk7jxopms5mpoxeurqjfdpvlpnxgmkveld3nggmzsmtid.onion:3333"
    );
    assert_eq!(json["pools"][0]["tls"], false);
    assert_eq!(json["pools"][0]["socks5"], "localhost:9050");
}

#[test]
fn resolves_darwin_arm64_bundled_xmrig_path() {
    let path = bundled_xmrig_path_for("macos", "aarch64").expect("bundled path");

    assert!(path.ends_with("cli/third_party/xmrig/darwin-arm64/xmrig"));
}

#[test]
fn resolves_packaged_xmrig_next_to_drip_binary() {
    let path = packaged_xmrig_path_for_exe(
        "linux",
        "x86_64",
        Path::new("/opt/drip-release/drip-linux-amd64/drip"),
    )
    .expect("packaged path");

    assert_eq!(
        path,
        Path::new("/opt/drip-release/drip-linux-amd64/third_party/xmrig/linux-amd64/xmrig")
    );
}
