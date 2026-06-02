use pretty_assertions::assert_eq;
use xpool_cli::config::{load_config, save_config, StoredConfig};

#[test]
fn saves_and_loads_worker_config() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let config_path = temp_dir.path().join(".xpool").join("config.json");
    let config = StoredConfig {
        api_base_url: "http://127.0.0.1:8081".to_string(),
        user_id: "user-id".to_string(),
        worker_id: "worker-id".to_string(),
        worker_name: "w_32e47f31771c457f96a19e617421a327".to_string(),
        worker_token: "xp_secret".to_string(),
        proxy_host: "localhost".to_string(),
        proxy_port: 3333,
        proxy_password: "xpool-dev".to_string(),
        machine_label: "macbook1".to_string(),
    };

    save_config(&config_path, &config).expect("save config");
    let loaded = load_config(&config_path).expect("load config");

    assert_eq!(loaded, config);
}
