use anyhow::{bail, Context};
use elliptic_curve::{bigint::U256, ops::Reduce, sec1::ToEncodedPoint, PrimeField};
use ethers::{types::Address, utils::keccak256};
use k256::{ecdsa::RecoveryId, AffinePoint};
use sha2::{Digest as Sha2Digest, Sha256};
use sha3::Keccak256;
use threshold_signatures::{
    ecdsa::{self, Scalar as EcdsaScalar, Signature as EcdsaSignature, Tweak as EcdsaTweak},
    frost::eddsa::{self, Ed25519Sha512},
    frost_core::Scalar as FrostScalar,
    frost_ed25519, Tweak as GenericTweak,
};

use crate::{auth::parse_hex_bytes, types::SignatureScheme};

pub type Ed25519Tweak = GenericTweak<Ed25519Sha512>;

pub fn ecdsa_message_digest(kind: &str, raw_hex: &str) -> anyhow::Result<[u8; 32]> {
    let raw = parse_hex_bytes(raw_hex)?;
    match kind {
        "raw32" => {
            if raw.len() != 32 {
                bail!(
                    "signature-kind raw32 requires a 32-byte message, got {} bytes",
                    raw.len()
                );
            }
            let mut out = [0u8; 32];
            out.copy_from_slice(&raw);
            Ok(out)
        }
        "eth-keccak" => Ok(keccak256(raw)),
        "btc-sha256" => Ok(Sha256::digest(raw).into()),
        other => bail!("unsupported ECDSA signature kind {other}"),
    }
}

pub fn ecdsa_digest_to_scalar(digest: [u8; 32]) -> EcdsaScalar {
    <EcdsaScalar as Reduce<U256>>::reduce_bytes(&digest.into())
}

pub fn derive_ecdsa_tweak(
    root_public_key: &[u8],
    asset_contract: Address,
    encumbered_account: [u8; 32],
) -> anyhow::Result<EcdsaTweak> {
    let mut counter = 0u8;
    loop {
        let bytes = derivation_hash(
            b"CROSSROADS_DERIVED_ECDSA_SECP256K1_TWEAK_V2",
            root_public_key,
            asset_contract,
            encumbered_account,
            counter,
        );
        if let Some(s) = EcdsaScalar::from_repr(bytes.into()).into_option() {
            if !bool::from(s.is_zero()) {
                return Ok(EcdsaTweak::new(s));
            }
        }
        counter = counter
            .checked_add(1)
            .context("secp256k1 tweak derivation counter overflow")?;
    }
}

pub fn derive_ed25519_tweak(
    root_public_key: &[u8],
    asset_contract: Address,
    encumbered_account: [u8; 32],
) -> anyhow::Result<Ed25519Tweak> {
    let bytes = derivation_hash(
        b"CROSSROADS_DERIVED_ED25519_TWEAK_V1",
        root_public_key,
        asset_contract,
        encumbered_account,
        0,
    );
    let scalar = FrostScalar::<Ed25519Sha512>::from_bytes_mod_order(bytes);
    Ok(GenericTweak::new(scalar))
}

fn derivation_hash(
    domain: &[u8],
    root_public_key: &[u8],
    asset_contract: Address,
    encumbered_account: [u8; 32],
    counter: u8,
) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(domain);
    h.update(root_public_key);
    h.update(asset_contract.as_bytes());
    h.update(encumbered_account);
    h.update([counter]);
    h.finalize().into()
}

pub fn ecdsa_affine_to_sec1(point: AffinePoint, compressed: bool) -> Vec<u8> {
    point.to_encoded_point(compressed).as_bytes().to_vec()
}

pub fn encode_ecdsa_signature(
    kind: &str,
    sig: &EcdsaSignature,
    digest: [u8; 32],
    public_key: AffinePoint,
) -> anyhow::Result<String> {
    let r = x_coordinate_32(sig.big_r)?;
    let s = ecdsa_scalar_32(sig.s);
    match kind {
        "btc-sha256" => Ok(format!("0x{}", hex::encode(der_encode_rs(&r, &s)))),
        "raw32" => Ok(format!("0x{}{}", hex::encode(r), hex::encode(s))),
        "eth-keccak" => {
            let recid = recover_id_for_sig(&r, &s, digest, public_key)?;
            let mut out = Vec::with_capacity(65);
            out.extend_from_slice(&r);
            out.extend_from_slice(&s);
            out.push(27 + recid.to_byte());
            Ok(format!("0x{}", hex::encode(out)))
        }
        other => bail!("unsupported ECDSA signature kind {other}"),
    }
}

pub fn encode_ed25519_signature(sig: &frost_ed25519::Signature) -> anyhow::Result<String> {
    let bytes = sig
        .serialize()
        .map_err(|e| anyhow::anyhow!("serialize Ed25519 signature: {e}"))?;
    Ok(format!("0x{}", hex::encode(bytes)))
}

fn recover_id_for_sig(
    r: &[u8; 32],
    s: &[u8; 32],
    digest: [u8; 32],
    expected: AffinePoint,
) -> anyhow::Result<RecoveryId> {
    let ksig = k256::ecdsa::Signature::from_scalars(*r, *s).context("build k256 signature")?;
    let expected_key =
        k256::ecdsa::VerifyingKey::from_affine(expected).context("build expected verifying key")?;
    for v in 0..=1u8 {
        let rid = RecoveryId::try_from(v).context("build recovery id")?;
        if let Ok(key) = k256::ecdsa::VerifyingKey::recover_from_prehash(&digest, &ksig, rid) {
            if key == expected_key {
                return Ok(rid);
            }
        }
    }
    bail!("could not determine ECDSA recovery id")
}

fn x_coordinate_32(point: AffinePoint) -> anyhow::Result<[u8; 32]> {
    let encoded = point.to_encoded_point(false);
    let x = encoded.x().context("missing x coordinate")?;
    let mut out = [0u8; 32];
    out.copy_from_slice(x);
    Ok(out)
}

fn ecdsa_scalar_32(scalar: EcdsaScalar) -> [u8; 32] {
    let bytes = scalar.to_repr();
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes.as_ref());
    out
}

fn der_int(x: &[u8; 32]) -> Vec<u8> {
    let mut v = x.to_vec();
    while v.len() > 1 && v[0] == 0 {
        v.remove(0);
    }
    if v[0] & 0x80 != 0 {
        v.insert(0, 0);
    }
    v
}

fn der_encode_rs(r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
    let r = der_int(r);
    let s = der_int(s);
    let mut out = Vec::with_capacity(6 + r.len() + s.len());
    out.push(0x30);
    out.push((4 + r.len() + s.len()) as u8);
    out.push(0x02);
    out.push(r.len() as u8);
    out.extend_from_slice(&r);
    out.push(0x02);
    out.push(s.len() as u8);
    out.extend_from_slice(&s);
    out
}

pub fn ecdsa_root_public_key_point(root: &ecdsa::KeygenOutput) -> AffinePoint {
    root.public_key.to_element().to_affine()
}

pub fn ecdsa_derived_public_key(root: &ecdsa::KeygenOutput, tweak: &EcdsaTweak) -> AffinePoint {
    tweak
        .derive_verifying_key(&root.public_key)
        .to_element()
        .to_affine()
}

pub fn ed25519_public_key_bytes(
    public_key: &frost_ed25519::VerifyingKey,
) -> anyhow::Result<Vec<u8>> {
    public_key
        .serialize()
        .map_err(|e| anyhow::anyhow!("serialize Ed25519 public key: {e}"))
}

pub fn ed25519_root_public_key_bytes(root: &eddsa::KeygenOutput) -> anyhow::Result<Vec<u8>> {
    ed25519_public_key_bytes(&root.public_key)
}

pub fn ed25519_derived_keygen_output(
    root: &eddsa::KeygenOutput,
    tweak: &Ed25519Tweak,
) -> eddsa::KeygenOutput {
    eddsa::KeygenOutput {
        private_share: tweak.derive_signing_share(&root.private_share),
        public_key: tweak.derive_verifying_key(&root.public_key),
    }
}

pub fn public_key_display_prefix(scheme: SignatureScheme) -> &'static str {
    match scheme {
        SignatureScheme::EcdsaSecp256k1 => "secp256k1",
        SignatureScheme::Ed25519 => "ed25519",
    }
}
