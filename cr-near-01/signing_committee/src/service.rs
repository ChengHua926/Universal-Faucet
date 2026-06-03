use std::{collections::HashMap, sync::Arc};

use anyhow::{bail, Context};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use ethers::types::Address;
use rand::{rngs::OsRng, RngCore};
use serde_json::json;
use threshold_signatures::participants::Participant;

use crate::{
    auth::{
        canonical_payload, normalize_hex32, parse_h256_bytes, parse_hex_bytes, recover_spender,
    },
    chain::ChainClient,
    config::Config,
    crypto,
    mpc::{MpcSignature, NearMpc, SigningPayload},
    transport::{manifest_digest, workflow_id_from_bytes, Mailbox, WireMessage},
    types::{
        BootstrapInitResponse, BootstrapSchemeInitResult, BootstrapSchemeStatus,
        BootstrapStatusResponse, Committee, DerivedKeyRequest, DerivedKeyResponse,
        InternalBootstrapRun, InternalSignRun, SignRequest, SignResponse, SignatureScheme,
    },
};

#[derive(Clone)]
pub struct AppState {
    cfg: Config,
    chain: ChainClient,
    committee: Committee,
    mpcs: HashMap<SignatureScheme, NearMpc>,
    mailbox: Arc<Mailbox>,
}

impl AppState {
    pub fn new(
        cfg: Config,
        chain: ChainClient,
        committee: Committee,
        mpcs: HashMap<SignatureScheme, NearMpc>,
        mailbox: Arc<Mailbox>,
    ) -> Self {
        Self {
            cfg,
            chain,
            committee,
            mpcs,
            mailbox,
        }
    }

    fn mpc_for(&self, scheme: SignatureScheme) -> anyhow::Result<&NearMpc> {
        self.mpcs
            .get(&scheme)
            .with_context(|| format!("no MPC runtime initialized for {scheme}"))
    }
}

pub async fn healthz() -> impl IntoResponse {
    StatusCode::NO_CONTENT
}

pub async fn bootstrap_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BootstrapStatusResponse>, ApiError> {
    let mut schemes = Vec::new();
    for scheme in SignatureScheme::all() {
        let mpc = state.mpc_for(scheme)?;
        let initialized = mpc.has_root().await;
        let mut public_key = None;
        if initialized {
            let pk = mpc.root_public_key_bytes().await?;
            public_key = Some(format!("0x{}", hex::encode(pk)));
        }
        let root_record_active = state.chain.load_root_record(scheme).await?.is_some();
        schemes.push(BootstrapSchemeStatus {
            scheme: scheme.to_string(),
            initialized,
            public_key,
            root_record_active,
        });
    }
    Ok(Json(BootstrapStatusResponse {
        committee_id: state.committee.committee_id,
        threshold: state.committee.threshold,
        active_members: state.committee.active_members().len(),
        schemes,
    }))
}

pub async fn bootstrap_init(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BootstrapInitResponse>, ApiError> {
    let mut results = Vec::new();
    for scheme in SignatureScheme::all() {
        let mpc = state.mpc_for(scheme)?;
        let workflow_id = workflow_id_from_bytes(
            "bootstrap",
            format!("{:?}:{scheme}", state.committee.committee_id).as_bytes(),
        );
        let (public_key, already_initialized) = if mpc.has_root().await {
            (mpc.root_public_key_bytes().await?, true)
        } else {
            let body = InternalBootstrapRun {
                workflow_id: workflow_id.clone(),
                participants: participant_u32s(&state.committee),
                scheme: scheme.to_string(),
            };
            let peer_handles = start_peers(&state, "/v1/internal/bootstrap/run", &body).await?;
            let public_key = mpc
                .bootstrap_root(workflow_id.clone(), &state.cfg.self_member_id)
                .await?;
            wait_peers(peer_handles).await?;
            (public_key, false)
        };
        let root_record_submitted = if state.chain.load_root_record(scheme).await?.is_some() {
            false
        } else {
            state
                .chain
                .submit_root_record(scheme, public_key.clone(), manifest_digest(scheme))
                .await?
        };
        results.push(BootstrapSchemeInitResult {
            workflow_id,
            scheme: scheme.to_string(),
            public_key: format!("0x{}", hex::encode(public_key)),
            root_record_submitted,
            already_initialized,
        });
    }
    Ok(Json(BootstrapInitResponse { results }))
}

pub async fn internal_bootstrap_run(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InternalBootstrapRun>,
) -> Result<Response, ApiError> {
    validate_participants(&state.committee, &body.participants)?;
    let scheme = parse_scheme(&body.scheme)?;
    let mpc = state.mpc_for(scheme)?;
    if mpc.has_root().await {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    mpc.bootstrap_root(body.workflow_id, &state.cfg.self_member_id)
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn derived_key(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DerivedKeyRequest>,
) -> Result<Json<DerivedKeyResponse>, ApiError> {
    let asset: Address = body
        .asset_contract
        .parse()
        .context("invalid asset_contract")?;
    let scheme = state.chain.asset_signature_scheme(asset).await?;
    let enc = parse_h256_bytes(&body.encumbered_account)?;
    let material = state
        .mpc_for(scheme)?
        .derived_public_key(asset, enc)
        .await?;
    Ok(Json(DerivedKeyResponse {
        scheme: scheme.to_string(),
        public_key: format!("0x{}", hex::encode(material.public_key())),
    }))
}

pub async fn sign(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SignRequest>,
) -> Result<Json<SignResponse>, ApiError> {
    let spender = recover_spender(&req)?;
    let asset: Address = req
        .asset_contract
        .parse()
        .context("invalid asset_contract")?;
    let scheme = state.chain.asset_signature_scheme(asset).await?;
    let enc = parse_h256_bytes(&req.encumbered_account)?;
    let policy_enc = parse_h256_bytes(
        req.policy_encumbered_account
            .as_ref()
            .unwrap_or(&req.encumbered_account),
    )?;
    let policy_message = req.policy_message.as_ref().unwrap_or(&req.message);
    let tx_data = parse_hex_bytes(policy_message)?;
    let allowed = state
        .chain
        .can_sign(asset, spender, policy_enc, tx_data.clone())
        .await?;
    if !allowed {
        return Err(ApiError::forbidden("asset canSign returned false"));
    }

    let canonical = canonical_payload(&req)?;
    let workflow_id = workflow_id_from_bytes(
        "sign",
        &[canonical.as_slice(), scheme.to_string().as_bytes()].concat(),
    );
    let mut entropy = [0u8; 32];
    OsRng.fill_bytes(&mut entropy);
    let body = InternalSignRun {
        workflow_id: workflow_id.clone(),
        participants: participant_u32s(&state.committee),
        coordinator: state
            .committee
            .self_participant(&state.cfg.self_member_id)?
            .into(),
        request: req.clone(),
        scheme: scheme.to_string(),
        entropy_hex: format!("0x{}", hex::encode(entropy)),
    };
    let peer_handles = start_peers(&state, "/v1/internal/run-sign", &body).await?;
    let payload = signing_payload(&state.cfg, scheme, &req.message)?;
    let coordinator = Participant::from(body.coordinator);
    let sig = state
        .mpc_for(scheme)?
        .sign(
            workflow_id.clone(),
            &state.cfg.self_member_id,
            asset,
            enc,
            payload,
            entropy,
            coordinator,
        )
        .await?
        .context("coordinator returned no signature")?;
    wait_peers(peer_handles).await?;
    let material = state
        .mpc_for(scheme)?
        .derived_public_key(asset, enc)
        .await?;
    let (signature_kind, signature) = encode_signature(&state.cfg, sig)?;
    Ok(Json(SignResponse {
        workflow_id,
        spender,
        asset_contract: asset,
        encumbered_account: normalize_hex32(&req.encumbered_account)?,
        scheme: scheme.to_string(),
        public_key: format!("0x{}", hex::encode(material.public_key())),
        signature_kind,
        signature,
    }))
}

pub async fn internal_run_sign(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InternalSignRun>,
) -> Result<Response, ApiError> {
    validate_participants(&state.committee, &body.participants)?;
    let requested_scheme = parse_scheme(&body.scheme)?;
    let spender = recover_spender(&body.request)?;
    let asset: Address = body
        .request
        .asset_contract
        .parse()
        .context("invalid asset_contract")?;
    let asset_scheme = state.chain.asset_signature_scheme(asset).await?;
    if asset_scheme != requested_scheme {
        return Err(anyhow::anyhow!(
            "internal signing scheme mismatch; asset currently reports {asset_scheme}, request expected {requested_scheme}"
        )
        .into());
    }
    let enc = parse_h256_bytes(&body.request.encumbered_account)?;
    let policy_enc = parse_h256_bytes(
        body.request
            .policy_encumbered_account
            .as_ref()
            .unwrap_or(&body.request.encumbered_account),
    )?;
    let policy_message = body
        .request
        .policy_message
        .as_ref()
        .unwrap_or(&body.request.message);
    let tx_data = parse_hex_bytes(policy_message)?;
    if !state
        .chain
        .can_sign(asset, spender, policy_enc, tx_data)
        .await?
    {
        return Err(ApiError::forbidden("asset canSign returned false"));
    }
    let payload = signing_payload(&state.cfg, requested_scheme, &body.request.message)?;
    let entropy = parse_h256_bytes(&body.entropy_hex)?;
    let coordinator = Participant::from(body.coordinator);
    let _ = state
        .mpc_for(requested_scheme)?
        .sign(
            body.workflow_id,
            &state.cfg.self_member_id,
            asset,
            enc,
            payload,
            entropy,
            coordinator,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn internal_mpc_message(
    State(state): State<Arc<AppState>>,
    Json(wire): Json<WireMessage>,
) -> Result<Response, ApiError> {
    let self_p = state
        .committee
        .self_participant(&state.cfg.self_member_id)?;
    let self_u32: u32 = self_p.into();
    if wire.to != self_u32 {
        return Err(ApiError::bad_request(
            "message addressed to a different participant",
        ));
    }
    state.mailbox.push(wire).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn signing_payload(
    cfg: &Config,
    scheme: SignatureScheme,
    message_hex: &str,
) -> anyhow::Result<SigningPayload> {
    match scheme {
        SignatureScheme::EcdsaSecp256k1 => Ok(SigningPayload::EcdsaDigest(
            crypto::ecdsa_message_digest(&cfg.ecdsa_signature_kind, message_hex)?,
        )),
        SignatureScheme::Ed25519 => Ok(SigningPayload::Ed25519Message(parse_hex_bytes(
            message_hex,
        )?)),
    }
}

fn encode_signature(cfg: &Config, sig: MpcSignature) -> anyhow::Result<(String, String)> {
    match sig {
        MpcSignature::Ecdsa {
            signature,
            digest,
            public_key,
        } => Ok((
            cfg.ecdsa_signature_kind.clone(),
            crypto::encode_ecdsa_signature(
                &cfg.ecdsa_signature_kind,
                &signature,
                digest,
                public_key,
            )?,
        )),
        MpcSignature::Ed25519 { signature } => Ok((
            "ed25519-rfc8032-raw".to_string(),
            crypto::encode_ed25519_signature(&signature)?,
        )),
    }
}

type PeerHandle = tokio::task::JoinHandle<anyhow::Result<()>>;

async fn start_peers<T: serde::Serialize>(
    state: &Arc<AppState>,
    path: &str,
    body: &T,
) -> anyhow::Result<Vec<PeerHandle>> {
    let client = reqwest::Client::new();
    let self_p = state
        .committee
        .self_participant(&state.cfg.self_member_id)?;
    let peers = state.committee.active_members();
    let mut handles = Vec::new();
    let payload = serde_json::to_value(body)?;
    for peer in peers {
        let p = Participant::from(peer.participant);
        if p == self_p {
            continue;
        }
        let url = format!("{}{}", peer.endpoint.trim_end_matches('/'), path);
        let client = client.clone();
        let payload = payload.clone();
        handles.push(tokio::spawn(async move {
            let response = client
                .post(&url)
                .json(&payload)
                .send()
                .await
                .with_context(|| format!("call peer {url}"))?;
            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                bail!("peer {url} returned {status}: {text}");
            }
            Ok::<_, anyhow::Error>(())
        }));
    }
    Ok(handles)
}

async fn wait_peers(handles: Vec<PeerHandle>) -> anyhow::Result<()> {
    for h in handles {
        h.await.context("peer task panicked")??;
    }
    Ok(())
}

fn participant_u32s(committee: &Committee) -> Vec<u32> {
    committee
        .participants()
        .into_iter()
        .map(Into::into)
        .collect()
}

fn validate_participants(committee: &Committee, got: &[u32]) -> anyhow::Result<()> {
    let expected = participant_u32s(committee);
    if got != expected {
        bail!(
            "participants mismatch; expected {:?}, got {:?}",
            expected,
            got
        );
    }
    Ok(())
}

fn parse_scheme(raw: &str) -> anyhow::Result<SignatureScheme> {
    raw.parse()
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: msg.into(),
        }
    }
    fn forbidden(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: msg.into(),
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("{:#}", err),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}
