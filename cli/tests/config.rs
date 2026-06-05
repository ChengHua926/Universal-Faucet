use drip_cli::{
    config::{
        default_config_path, default_log_path, default_pid_path, default_voucher_path,
        default_xmrig_config_path, load_config, save_config, StoredConfig, StoredIdentity,
    },
    identity::identity_from_private_key_hex,
};
use pretty_assertions::assert_eq;

#[test]
fn saves_and_loads_cli_only_profile() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let config_path = temp_dir.path().join("config.json");
    let identity = identity_from_private_key_hex(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    )
    .expect("identity");
    let config = StoredConfig {
        api_base_url: "http://127.0.0.1:8081".to_string(),
        mining_pool_url: "pool.example.com:443".to_string(),
        mining_pool_tls: true,
        voucher_interval_seconds: 300,
        identity: StoredIdentity {
            address: identity.address,
            private_key: identity.private_key,
        },
    };

    save_config(&config_path, &config).expect("save config");
    let loaded = load_config(&config_path).expect("load config");

    assert_eq!(loaded, config);
}

#[test]
fn drip_home_controls_local_paths() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    std::env::set_var("DRIP_HOME", temp_dir.path());

    assert_eq!(
        default_config_path().expect("config path"),
        temp_dir.path().join("config.json")
    );
    assert_eq!(
        default_xmrig_config_path().expect("xmrig config path"),
        temp_dir.path().join("xmrig-config.json")
    );
    assert_eq!(
        default_pid_path().expect("pid path"),
        temp_dir.path().join("xmrig.pid")
    );
    assert_eq!(
        default_log_path().expect("log path"),
        temp_dir.path().join("xmrig.log")
    );
    assert_eq!(
        default_voucher_path().expect("voucher path"),
        temp_dir.path().join("voucher.json")
    );

    std::env::remove_var("DRIP_HOME");
}
