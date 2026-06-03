use anyhow::{bail, Context};
use ethers::{
    types::{Address, Signature},
    utils::hash_message,
};

use crate::types::{AuthPayload, SignRequest};

pub fn canonical_payload(req: &SignRequest) -> anyhow::Result<Vec<u8>> {
    let payload = AuthPayload {
        asset_contract: normalize_address_string(&req.asset_contract)?,
        encumbered_account: normalize_hex32(&req.encumbered_account)?,
        message: normalize_hex(&req.message)?,
        policy_encumbered_account: req
            .policy_encumbered_account
            .as_ref()
            .map(|enc| normalize_hex32(enc))
            .transpose()?,
        policy_message: req
            .policy_message
            .as_ref()
            .map(|m| normalize_hex(m))
            .transpose()?,
    };
    serde_json::to_vec(&payload).context("serialize canonical user payload")
}

pub fn recover_spender(req: &SignRequest) -> anyhow::Result<Address> {
    let payload = canonical_payload(req)?;
    let digest = hash_message(payload);
    let sig: Signature = req
        .user_signature
        .parse()
        .context("invalid user_signature")?;
    sig.recover(digest).context("recover EIP-191 signer")
}

pub fn normalize_address_string(input: &str) -> anyhow::Result<String> {
    let address: Address = input.parse().context("invalid address")?;
    Ok(format!("{address:?}").to_lowercase())
}

pub fn parse_hex_bytes(input: &str) -> anyhow::Result<Vec<u8>> {
    let stripped = input
        .trim()
        .strip_prefix("0x")
        .or_else(|| input.trim().strip_prefix("0X"))
        .unwrap_or(input.trim());
    if stripped.len() % 2 != 0 {
        bail!("hex string must have even length");
    }
    hex::decode(stripped).context("invalid hex")
}

pub fn normalize_hex(input: &str) -> anyhow::Result<String> {
    let b = parse_hex_bytes(input)?;
    Ok(format!("0x{}", hex::encode(b)))
}

pub fn normalize_hex32(input: &str) -> anyhow::Result<String> {
    let b = parse_hex_bytes(input)?;
    if b.len() != 32 {
        bail!("expected 32-byte hex value, got {} bytes", b.len());
    }
    Ok(format!("0x{}", hex::encode(b)))
}

pub fn parse_h256_bytes(input: &str) -> anyhow::Result<[u8; 32]> {
    let b = parse_hex_bytes(input)?;
    if b.len() != 32 {
        bail!("expected 32-byte hex value, got {} bytes", b.len());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&b);
    Ok(out)
}
