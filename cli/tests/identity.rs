use drip_cli::identity::{generate_identity, identity_from_private_key_hex};

#[test]
fn derives_ethereum_address_from_private_key() {
    let identity = identity_from_private_key_hex(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    )
    .expect("identity");

    assert_eq!(
        identity.address,
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
    assert_eq!(
        identity.private_key,
        "0x0000000000000000000000000000000000000000000000000000000000000001"
    );
}

#[test]
fn rejects_non_32_byte_private_keys() {
    let error = identity_from_private_key_hex("0x1234").expect_err("invalid key");

    assert_eq!(error.to_string(), "private key must be 32 bytes");
}

#[test]
fn generated_identity_has_hex_private_key_and_address() {
    let identity = generate_identity();

    assert!(identity.private_key.starts_with("0x"));
    assert_eq!(identity.private_key.len(), 66);
    assert!(identity.address.starts_with("0x"));
    assert_eq!(identity.address.len(), 42);
}
