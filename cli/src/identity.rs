use k256::ecdsa::SigningKey;
use rand_core::OsRng;
use sha3::{Digest, Keccak256};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalIdentity {
    pub address: String,
    pub private_key: String,
}

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("private key must be 32 bytes")]
    InvalidLength,
    #[error("private key is not valid secp256k1 scalar")]
    InvalidScalar,
    #[error("private key must be hex")]
    InvalidHex(#[from] hex::FromHexError),
}

pub fn generate_identity() -> LocalIdentity {
    let signing_key = SigningKey::random(&mut OsRng);
    identity_from_signing_key(signing_key)
}

pub fn identity_from_private_key_hex(value: &str) -> Result<LocalIdentity, IdentityError> {
    let normalized = value.strip_prefix("0x").unwrap_or(value);
    let bytes = hex::decode(normalized)?;
    if bytes.len() != 32 {
        return Err(IdentityError::InvalidLength);
    }

    let signing_key = SigningKey::from_slice(&bytes).map_err(|_| IdentityError::InvalidScalar)?;
    Ok(identity_from_signing_key(signing_key))
}

fn identity_from_signing_key(signing_key: SigningKey) -> LocalIdentity {
    let private_key = format!("0x{}", hex::encode(signing_key.to_bytes()));
    let verifying_key = signing_key.verifying_key();
    let encoded = verifying_key.to_encoded_point(false);
    let public_key = encoded.as_bytes();
    let hash = Keccak256::digest(&public_key[1..]);
    let address = format!("0x{}", hex::encode(&hash[12..]));

    LocalIdentity {
        address,
        private_key,
    }
}
