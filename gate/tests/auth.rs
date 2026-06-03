use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use xpool_gate::auth::{verify_worker_login, WorkerAuthRecord};

#[test]
fn verifies_worker_token_hash() {
    let token = "xp_worker_secret";
    let salt = SaltString::encode_b64(b"1234567890123456").expect("salt");
    let token_hash = Argon2::default()
        .hash_password(token.as_bytes(), &salt)
        .expect("hash")
        .to_string();

    let record = WorkerAuthRecord {
        worker_name: "w_abc".to_string(),
        token_hash,
    };

    assert!(verify_worker_login(&record, "w_abc", token).expect("verify"));
    assert!(!verify_worker_login(&record, "w_abc", "wrong").expect("verify"));
    assert!(!verify_worker_login(&record, "w_other", token).expect("verify"));
}
