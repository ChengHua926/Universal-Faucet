use std::{collections::HashMap, fmt, str::FromStr};

use anyhow::{bail, Context};
use ethers::types::{Address, Bytes, H256};
use serde::{Deserialize, Serialize};
use threshold_signatures::participants::Participant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignatureScheme {
    EcdsaSecp256k1,
    Ed25519,
}

impl SignatureScheme {
    pub fn scheme_id(self) -> u8 {
        match self {
            Self::EcdsaSecp256k1 => 1,
            Self::Ed25519 => 2,
        }
    }

    pub fn canonical_name(self) -> &'static str {
        match self {
            Self::EcdsaSecp256k1 => "ecdsa-secp256k1",
            Self::Ed25519 => "ed25519",
        }
    }

    pub fn root_file_scheme(self) -> &'static str {
        match self {
            Self::EcdsaSecp256k1 => "near-threshold-signatures/robust-ecdsa-secp256k1",
            Self::Ed25519 => "near-threshold-signatures/frost-ed25519",
        }
    }

    pub fn from_scheme_id(id: u8) -> anyhow::Result<Self> {
        match id {
            1 => Ok(Self::EcdsaSecp256k1),
            2 => Ok(Self::Ed25519),
            other => bail!("unsupported signature scheme id {other}; expected 1 for ecdsa-secp256k1 or 2 for ed25519"),
        }
    }

    pub fn all() -> [Self; 2] {
        [Self::EcdsaSecp256k1, Self::Ed25519]
    }
}

impl fmt::Display for SignatureScheme {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_name())
    }
}

impl FromStr for SignatureScheme {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "1" | "ecdsa" | "ecdsa-secp256k1" | "secp256k1" => Ok(Self::EcdsaSecp256k1),
            "2" | "ed25519" | "eddsa" | "frost-ed25519" => Ok(Self::Ed25519),
            other => {
                bail!("unsupported signature scheme {other:?}; use ecdsa-secp256k1 or ed25519")
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitteeMember {
    pub id: String,
    pub participant: u32,
    pub admin: Address,
    pub endpoint: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Committee {
    pub contract: Address,
    pub committee_id: H256,
    pub threshold: usize,
    pub members: Vec<CommitteeMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootRecord {
    pub scheme_id: u8,
    pub public_key: Bytes,
    pub manifest_digest: H256,
    pub active: bool,
}

impl Committee {
    pub fn active_members(&self) -> Vec<CommitteeMember> {
        self.members.iter().filter(|m| m.active).cloned().collect()
    }

    pub fn validate_self(&self, self_id: &str) -> anyhow::Result<()> {
        if self.member_by_id(self_id).is_none() {
            bail!("self member id {self_id} is not present in bootstrap roster");
        }
        Ok(())
    }

    pub fn validate_for_all_schemes(&self) -> anyhow::Result<()> {
        let active = self.active_members();
        if active.len() < 2 {
            bail!("NEAR MPC DKG requires at least 2 active members");
        }
        if self.threshold < 2 || self.threshold > active.len() {
            bail!(
                "invalid threshold {}; must be between 2 and active member count {}",
                self.threshold,
                active.len()
            );
        }

        let expected = 2usize
            .checked_mul(
                self.threshold
                    .checked_sub(1)
                    .context("threshold must be >= 1")?,
            )
            .and_then(|x| x.checked_add(1))
            .context("threshold overflow")?;
        if active.len() != expected {
            bail!(
                "because ECDSA and Ed25519 are both enabled, the committee must satisfy NEAR robust ECDSA split-view-safe signing: active member count = 2*(threshold-1)+1; got {} active members and threshold {}, expected {expected}",
                active.len(), self.threshold
            );
        }
        Ok(())
    }

    pub fn member_by_id(&self, id: &str) -> Option<&CommitteeMember> {
        self.members.iter().find(|m| m.id.eq_ignore_ascii_case(id))
    }

    pub fn member_by_participant(&self, p: Participant) -> Option<&CommitteeMember> {
        let p: u32 = p.into();
        self.members.iter().find(|m| m.participant == p)
    }

    pub fn self_participant(&self, id: &str) -> anyhow::Result<Participant> {
        self.member_by_id(id)
            .map(|m| Participant::from(m.participant))
            .context("self member id is not in the committee")
    }

    pub fn participants(&self) -> Vec<Participant> {
        self.active_members()
            .iter()
            .map(|m| Participant::from(m.participant))
            .collect()
    }

    pub fn endpoints_by_participant(&self) -> HashMap<Participant, String> {
        self.active_members()
            .into_iter()
            .map(|m| (Participant::from(m.participant), m.endpoint))
            .collect()
    }

    pub fn coordinator(&self) -> anyhow::Result<Participant> {
        self.active_members()
            .first()
            .map(|m| Participant::from(m.participant))
            .context("empty committee")
    }

    pub fn max_malicious(&self) -> anyhow::Result<threshold_signatures::MaxMalicious> {
        Ok(threshold_signatures::MaxMalicious::from(self.threshold - 1))
    }

    pub fn reconstruction_lower_bound(&self) -> threshold_signatures::ReconstructionLowerBound {
        threshold_signatures::ReconstructionLowerBound::from(self.threshold)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignRequest {
    pub asset_contract: String,
    pub encumbered_account: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_encumbered_account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_message: Option<String>,
    pub user_signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthPayload {
    pub asset_contract: String,
    pub encumbered_account: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_encumbered_account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DerivedKeyRequest {
    pub asset_contract: String,
    pub encumbered_account: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DerivedKeyResponse {
    pub scheme: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignResponse {
    pub workflow_id: String,
    pub spender: Address,
    pub asset_contract: Address,
    pub encumbered_account: String,
    pub scheme: String,
    pub public_key: String,
    pub signature_kind: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapSchemeStatus {
    pub scheme: String,
    pub initialized: bool,
    pub public_key: Option<String>,
    pub root_record_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapStatusResponse {
    pub committee_id: H256,
    pub threshold: usize,
    pub active_members: usize,
    pub schemes: Vec<BootstrapSchemeStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapSchemeInitResult {
    pub workflow_id: String,
    pub scheme: String,
    pub public_key: String,
    pub root_record_submitted: bool,
    pub already_initialized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapInitResponse {
    pub results: Vec<BootstrapSchemeInitResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalBootstrapRun {
    pub workflow_id: String,
    pub participants: Vec<u32>,
    pub scheme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalSignRun {
    pub workflow_id: String,
    pub participants: Vec<u32>,
    pub coordinator: u32,
    pub request: SignRequest,
    pub scheme: String,
    pub entropy_hex: String,
}
