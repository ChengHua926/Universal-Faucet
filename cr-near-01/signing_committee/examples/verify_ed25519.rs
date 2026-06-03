use threshold_signatures::{
    frost_core::{Signature, VerifyingKey},
    frost_ed25519::Ed25519Sha512,
};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let public_key = parse_hex(
        &args
            .next()
            .ok_or_else(|| anyhow::anyhow!("missing public key hex"))?,
    )?;
    let signature = parse_hex(
        &args
            .next()
            .ok_or_else(|| anyhow::anyhow!("missing signature hex"))?,
    )?;
    let message = parse_hex(
        &args
            .next()
            .ok_or_else(|| anyhow::anyhow!("missing message hex"))?,
    )?;
    if args.next().is_some() {
        anyhow::bail!("usage: cargo run --example verify_ed25519 -- <public-key-hex> <signature-hex> <message-hex>");
    }

    let public_key = VerifyingKey::<Ed25519Sha512>::deserialize(&public_key)
        .map_err(|e| anyhow::anyhow!("deserialize Ed25519 verifying key: {e:?}"))?;
    let signature = Signature::<Ed25519Sha512>::deserialize(&signature)
        .map_err(|e| anyhow::anyhow!("deserialize Ed25519 signature: {e:?}"))?;
    public_key
        .verify(&message, &signature)
        .map_err(|e| anyhow::anyhow!("verify Ed25519 signature: {e:?}"))?;
    Ok(())
}

fn parse_hex(input: &str) -> anyhow::Result<Vec<u8>> {
    let stripped = input
        .trim()
        .strip_prefix("0x")
        .or_else(|| input.trim().strip_prefix("0X"))
        .unwrap_or(input.trim());
    if stripped.len() % 2 != 0 {
        anyhow::bail!("hex input has odd length");
    }
    hex::decode(stripped).map_err(Into::into)
}
