use pretty_assertions::assert_eq;
use xpool_cli::{
    config::StoredConfig,
    xmrig::{generate_xmrig_config, XmrigSettings},
};

#[test]
fn generates_xmrig_config_for_proxy_worker() {
    let stored = StoredConfig {
        api_base_url: "http://127.0.0.1:8081".to_string(),
        user_id: "user-id".to_string(),
        worker_id: "worker-id".to_string(),
        worker_name: "w_32e47f31771c457f96a19e617421a327".to_string(),
        worker_token: "xp_secret".to_string(),
        proxy_host: "localhost".to_string(),
        proxy_port: 3333,
        machine_label: "macbook1".to_string(),
    };

    let config = generate_xmrig_config(
        &stored,
        XmrigSettings {
            threads: 2,
            tls: false,
            log_file: None,
        },
    );
    let json = serde_json::to_value(config).expect("json");

    assert_eq!(json["autosave"], false);
    assert_eq!(json["cpu"]["enabled"], true);
    assert_eq!(json["cpu"]["rx"], serde_json::json!([-1, -1]));
    assert!(json["cpu"].get("max-threads-hint").is_none());
    assert_eq!(json["pools"][0]["url"], "localhost:3333");
    assert_eq!(
        json["pools"][0]["user"],
        "w_32e47f31771c457f96a19e617421a327"
    );
    assert_eq!(json["pools"][0]["pass"], "xp_secret");
    assert_eq!(
        json["pools"][0]["rig-id"],
        "w_32e47f31771c457f96a19e617421a327"
    );
    assert_eq!(json["pools"][0]["keepalive"], true);
    assert_eq!(json["pools"][0]["tls"], false);

    let object = json.as_object().expect("object");
    assert!(
        !object.contains_key("worker_token"),
        "XMRig config should pass the token as pool password, not as a separate field"
    );
    assert!(object.get("log-file").is_none());
}
