use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{bail, Context};
use ethers::types::Address;
use k256::AffinePoint;
use rand::{rngs::OsRng, RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use threshold_signatures::{
    ecdsa::{
        self, robust_ecdsa, RerandomizationArguments, Secp256K1Sha256, Signature as EcdsaSignature,
        Tweak as EcdsaTweak,
    },
    frost::eddsa::{self, sign as eddsa_sign, Ed25519Sha512},
    frost_ed25519, keygen,
    participants::{Participant, ParticipantList},
    protocol::{Action, Protocol},
};
use tokio::fs;

use crate::{
    crypto,
    transport::{HttpTransport, Mailbox},
    types::{Committee, RootRecord, SignatureScheme},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "scheme", content = "keygen_output")]
enum RootKeyShare {
    EcdsaSecp256k1(ecdsa::KeygenOutput),
    Ed25519(eddsa::KeygenOutput),
}

impl RootKeyShare {
    fn scheme(&self) -> SignatureScheme {
        match self {
            Self::EcdsaSecp256k1(_) => SignatureScheme::EcdsaSecp256k1,
            Self::Ed25519(_) => SignatureScheme::Ed25519,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RootShareFile {
    version: u32,
    committee_id: String,
    root: RootKeyShare,
}

pub enum DerivedKeyMaterial {
    Ecdsa {
        public_key: Vec<u8>,
        affine: AffinePoint,
        tweak: EcdsaTweak,
    },
    Ed25519 {
        public_key: Vec<u8>,
        tweak: crypto::Ed25519Tweak,
    },
}

impl DerivedKeyMaterial {
    pub fn public_key(&self) -> &[u8] {
        match self {
            Self::Ecdsa { public_key, .. } | Self::Ed25519 { public_key, .. } => public_key,
        }
    }
}

pub enum SigningPayload {
    EcdsaDigest([u8; 32]),
    Ed25519Message(Vec<u8>),
}

pub enum MpcSignature {
    Ecdsa {
        signature: EcdsaSignature,
        digest: [u8; 32],
        public_key: AffinePoint,
    },
    Ed25519 {
        signature: frost_ed25519::Signature,
    },
}

#[derive(Clone)]
pub struct NearMpc {
    root_share_file: PathBuf,
    committee: Committee,
    scheme: SignatureScheme,
    mailbox: Arc<Mailbox>,
    root: Arc<tokio::sync::RwLock<Option<RootKeyShare>>>,
}

impl NearMpc {
    pub async fn load_or_new(
        root_share_file: PathBuf,
        committee: Committee,
        scheme: SignatureScheme,
        mailbox: Arc<Mailbox>,
    ) -> anyhow::Result<Self> {
        let root = match fs::read(&root_share_file).await {
            Ok(bytes) => {
                let parsed: RootShareFile =
                    serde_json::from_slice(&bytes).context("parse root share file")?;
                if parsed.committee_id != format!("{:?}", committee.committee_id) {
                    bail!(
                        "root share file belongs to committee {}, current committee is {:?}",
                        parsed.committee_id,
                        committee.committee_id
                    );
                }
                if parsed.root.scheme() != scheme {
                    bail!(
                        "root share file contains scheme {}, this node is configured for {}",
                        parsed.root.scheme(),
                        scheme
                    );
                }
                Some(parsed.root)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e).context("read root share file"),
        };
        Ok(Self {
            root_share_file,
            committee,
            scheme,
            mailbox,
            root: Arc::new(tokio::sync::RwLock::new(root)),
        })
    }

    pub fn scheme(&self) -> SignatureScheme {
        self.scheme
    }

    pub async fn has_root(&self) -> bool {
        self.root.read().await.is_some()
    }

    pub async fn root_public_key_bytes(&self) -> anyhow::Result<Vec<u8>> {
        let root = self.root.read().await;
        let root = root
            .as_ref()
            .context("committee root key is not initialized")?;
        match root {
            RootKeyShare::EcdsaSecp256k1(root) => Ok(crypto::ecdsa_affine_to_sec1(
                crypto::ecdsa_root_public_key_point(root),
                true,
            )),
            RootKeyShare::Ed25519(root) => crypto::ed25519_root_public_key_bytes(root),
        }
    }

    pub async fn derived_public_key(
        &self,
        asset: Address,
        enc: [u8; 32],
    ) -> anyhow::Result<DerivedKeyMaterial> {
        let root = self.root.read().await;
        let root = root
            .as_ref()
            .context("committee root key is not initialized")?;
        match root {
            RootKeyShare::EcdsaSecp256k1(root) => {
                let root_pub =
                    crypto::ecdsa_affine_to_sec1(crypto::ecdsa_root_public_key_point(root), true);
                let tweak = crypto::derive_ecdsa_tweak(&root_pub, asset, enc)?;
                let derived = crypto::ecdsa_derived_public_key(root, &tweak);
                Ok(DerivedKeyMaterial::Ecdsa {
                    public_key: crypto::ecdsa_affine_to_sec1(derived, true),
                    affine: derived,
                    tweak,
                })
            }
            RootKeyShare::Ed25519(root) => {
                let root_pub = crypto::ed25519_root_public_key_bytes(root)?;
                let tweak = crypto::derive_ed25519_tweak(&root_pub, asset, enc)?;
                let derived = crypto::ed25519_derived_keygen_output(root, &tweak);
                Ok(DerivedKeyMaterial::Ed25519 {
                    public_key: crypto::ed25519_public_key_bytes(&derived.public_key)?,
                    tweak,
                })
            }
        }
    }

    pub async fn verify_active_root(&self, active: &RootRecord) -> anyhow::Result<()> {
        if !active.active {
            return Ok(());
        }
        let record_scheme = SignatureScheme::from_scheme_id(active.scheme_id)?;
        if record_scheme != self.scheme {
            bail!(
                "active root has scheme {}, this node is configured for {}",
                record_scheme,
                self.scheme
            );
        }
        let root = self.root.read().await;
        if root.is_none() {
            return Ok(());
        }
        let local = self.root_public_key_bytes().await?;
        if active.public_key.as_ref() != local.as_slice() {
            bail!(
                "active {} root public key does not match local root share",
                self.scheme
            );
        }
        Ok(())
    }

    pub async fn bootstrap_root(
        &self,
        workflow_id: String,
        self_id: &str,
    ) -> anyhow::Result<Vec<u8>> {
        let participants = self.committee.participants();
        let me = self.committee.self_participant(self_id)?;
        match self.scheme {
            SignatureScheme::EcdsaSecp256k1 => {
                let protocol = keygen::<Secp256K1Sha256>(
                    &participants,
                    me,
                    self.committee.reconstruction_lower_bound(),
                    seeded_rng(),
                )
                .context("start NEAR secp256k1 keygen")?;
                let output = self
                    .run_protocol(protocol, workflow_id, me)
                    .await?
                    .context("keygen returned no output")?;
                let root = RootKeyShare::EcdsaSecp256k1(output.clone());
                self.persist_root(&root).await?;
                *self.root.write().await = Some(root);
                Ok(crypto::ecdsa_affine_to_sec1(
                    crypto::ecdsa_root_public_key_point(&output),
                    true,
                ))
            }
            SignatureScheme::Ed25519 => {
                let protocol = keygen::<Ed25519Sha512>(
                    &participants,
                    me,
                    self.committee.reconstruction_lower_bound(),
                    seeded_rng(),
                )
                .context("start NEAR Ed25519 keygen")?;
                let output = self
                    .run_protocol(protocol, workflow_id, me)
                    .await?
                    .context("keygen returned no output")?;
                let public_key = crypto::ed25519_root_public_key_bytes(&output)?;
                let root = RootKeyShare::Ed25519(output);
                self.persist_root(&root).await?;
                *self.root.write().await = Some(root);
                Ok(public_key)
            }
        }
    }

    pub async fn sign(
        &self,
        workflow_id: String,
        self_id: &str,
        asset: Address,
        enc: [u8; 32],
        payload: SigningPayload,
        entropy: [u8; 32],
        coordinator: Participant,
    ) -> anyhow::Result<Option<MpcSignature>> {
        let root_guard = self.root.read().await;
        let root = root_guard
            .as_ref()
            .context("committee root key is not initialized")?
            .clone();
        drop(root_guard);

        match (root, payload) {
            (RootKeyShare::EcdsaSecp256k1(root), SigningPayload::EcdsaDigest(digest)) => {
                let root_for_public_key = root.clone();
                let out = self
                    .sign_ecdsa(
                        workflow_id,
                        self_id,
                        asset,
                        enc,
                        digest,
                        entropy,
                        coordinator,
                        root,
                    )
                    .await?;
                Ok(out.map(|signature| {
                    let root_master_public =
                        crypto::ecdsa_root_public_key_point(&root_for_public_key);
                    let root_pub = crypto::ecdsa_affine_to_sec1(root_master_public, true);
                    let tweak = crypto::derive_ecdsa_tweak(&root_pub, asset, enc)
                        .expect("tweak derivation already succeeded during signing");
                    let public_key = tweak
                        .derive_verifying_key(&root_for_public_key.public_key)
                        .to_element()
                        .to_affine();
                    MpcSignature::Ecdsa {
                        signature,
                        digest,
                        public_key,
                    }
                }))
            }
            (RootKeyShare::Ed25519(root), SigningPayload::Ed25519Message(message)) => {
                let out = self
                    .sign_ed25519(workflow_id, self_id, asset, enc, message, coordinator, root)
                    .await?;
                Ok(out.map(|signature| MpcSignature::Ed25519 { signature }))
            }
            (RootKeyShare::EcdsaSecp256k1(_), _) => {
                bail!("node is configured for ECDSA but received an Ed25519 payload")
            }
            (RootKeyShare::Ed25519(_), _) => {
                bail!("node is configured for Ed25519 but received an ECDSA payload")
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn sign_ecdsa(
        &self,
        workflow_id: String,
        self_id: &str,
        asset: Address,
        enc: [u8; 32],
        digest: [u8; 32],
        entropy: [u8; 32],
        coordinator: Participant,
        root: ecdsa::KeygenOutput,
    ) -> anyhow::Result<Option<EcdsaSignature>> {
        let participants = self.committee.participants();
        let me = self.committee.self_participant(self_id)?;
        let root_master_public = crypto::ecdsa_root_public_key_point(&root);
        let root_pub = crypto::ecdsa_affine_to_sec1(root_master_public, true);
        let tweak = crypto::derive_ecdsa_tweak(&root_pub, asset, enc)?;
        let public_key = tweak
            .derive_verifying_key(&root.public_key)
            .to_element()
            .to_affine();
        let max_malicious = self.committee.max_malicious()?;
        let msg_scalar = crypto::ecdsa_digest_to_scalar(digest);

        let presign_protocol = robust_ecdsa::presign::presign(
            &participants,
            me,
            robust_ecdsa::PresignArguments {
                keygen_out: root.clone(),
                max_malicious,
            },
            seeded_rng(),
        )
        .context("start NEAR robust ECDSA presign")?;
        let presign = self
            .run_protocol(presign_protocol, format!("{workflow_id}:presign"), me)
            .await?
            .context("presign returned no output")?;
        let participant_list =
            ParticipantList::new(&participants).context("duplicate participants")?;
        let args = RerandomizationArguments::new(
            root_master_public,
            tweak,
            digest,
            presign.big_r,
            participant_list,
            entropy,
        );
        let rerandomized =
            robust_ecdsa::RerandomizedPresignOutput::rerandomize_presign(&presign, &args)
                .context("rerandomize NEAR presignature")?;
        let sign_protocol = robust_ecdsa::sign::sign(
            &participants,
            coordinator,
            max_malicious,
            me,
            public_key,
            rerandomized,
            msg_scalar,
        )
        .context("start NEAR robust ECDSA sign")?;
        Ok(self
            .run_protocol(sign_protocol, format!("{workflow_id}:sign"), me)
            .await?
            .flatten())
    }

    async fn sign_ed25519(
        &self,
        workflow_id: String,
        self_id: &str,
        asset: Address,
        enc: [u8; 32],
        message: Vec<u8>,
        coordinator: Participant,
        root: eddsa::KeygenOutput,
    ) -> anyhow::Result<Option<frost_ed25519::Signature>> {
        let participants = self.committee.participants();
        let me = self.committee.self_participant(self_id)?;
        let root_pub = crypto::ed25519_root_public_key_bytes(&root)?;
        let tweak = crypto::derive_ed25519_tweak(&root_pub, asset, enc)?;
        let derived = crypto::ed25519_derived_keygen_output(&root, &tweak);
        let protocol = eddsa_sign::sign(
            &participants,
            self.committee.reconstruction_lower_bound(),
            me,
            coordinator,
            derived,
            message,
            seeded_rng(),
        )
        .context("start NEAR Ed25519 FROST sign")?;
        Ok(self
            .run_protocol(protocol, format!("{workflow_id}:sign"), me)
            .await?
            .flatten())
    }

    async fn run_protocol<P>(
        &self,
        mut protocol: P,
        workflow_id: String,
        me: Participant,
    ) -> anyhow::Result<Option<P::Output>>
    where
        P: Protocol + Send,
        P::Output: Send + 'static,
    {
        let http = HttpTransport::new(
            self.committee.endpoints_by_participant(),
            me,
            workflow_id.clone(),
        );
        loop {
            match protocol.poke().context("poke NEAR MPC protocol")? {
                Action::Wait => {
                    let msg = self
                        .mailbox
                        .recv(&workflow_id, Duration::from_secs(180))
                        .await?;
                    protocol
                        .message(msg.from, msg.data)
                        .context("deliver NEAR MPC message")?;
                }
                Action::SendMany(data) => http.send_many(data).await?,
                Action::SendPrivate(to, data) => http.send_private(to, data).await?,
                Action::Return(output) => {
                    self.mailbox.clear(&workflow_id).await;
                    return Ok(Some(output));
                }
            }
        }
    }

    async fn persist_root(&self, root: &RootKeyShare) -> anyhow::Result<()> {
        if let Some(parent) = self.root_share_file.parent() {
            fs::create_dir_all(parent)
                .await
                .context("create root share directory")?;
        }
        let doc = RootShareFile {
            version: 2,
            committee_id: format!("{:?}", self.committee.committee_id),
            root: root.clone(),
        };
        let tmp = self.root_share_file.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&doc)?)
            .await
            .context("write root share temp file")?;
        fs::rename(tmp, &self.root_share_file)
            .await
            .context("rename root share file")?;
        Ok(())
    }
}

fn seeded_rng() -> ChaCha20Rng {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    ChaCha20Rng::from_seed(seed)
}
