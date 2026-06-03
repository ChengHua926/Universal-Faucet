use crate::types::SignatureScheme;
use std::{
    collections::{HashMap, VecDeque},
    time::Duration,
};

use anyhow::{bail, Context};
use ethers::types::H256;
use serde::{Deserialize, Serialize};
use threshold_signatures::{participants::Participant, protocol::MessageData};
use tokio::{
    sync::{Mutex, Notify},
    time::timeout,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub workflow_id: String,
    pub from: u32,
    pub to: u32,
    pub data: String,
}

#[derive(Debug, Clone)]
pub struct InboundMessage {
    pub from: Participant,
    pub data: MessageData,
}

#[derive(Default)]
pub struct Mailbox {
    inner: Mutex<HashMap<String, VecDeque<InboundMessage>>>,
    notify: Notify,
}

impl Mailbox {
    pub async fn push(&self, wire: WireMessage) -> anyhow::Result<()> {
        let data_hex = wire
            .data
            .trim()
            .strip_prefix("0x")
            .unwrap_or(wire.data.trim());
        let data = hex::decode(data_hex).context("decode MPC wire message data")?;
        let mut guard = self.inner.lock().await;
        guard
            .entry(wire.workflow_id)
            .or_default()
            .push_back(InboundMessage {
                from: Participant::from(wire.from),
                data,
            });
        drop(guard);
        self.notify.notify_waiters();
        Ok(())
    }

    pub async fn recv(&self, workflow_id: &str, wait: Duration) -> anyhow::Result<InboundMessage> {
        let fut = async {
            loop {
                if let Some(msg) = self.try_pop(workflow_id).await {
                    return msg;
                }
                self.notify.notified().await;
            }
        };
        timeout(wait, fut)
            .await
            .with_context(|| format!("timed out waiting for MPC message in workflow {workflow_id}"))
    }

    async fn try_pop(&self, workflow_id: &str) -> Option<InboundMessage> {
        let mut guard = self.inner.lock().await;
        guard.get_mut(workflow_id).and_then(VecDeque::pop_front)
    }

    pub async fn clear(&self, workflow_id: &str) {
        self.inner.lock().await.remove(workflow_id);
    }
}

#[derive(Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
    endpoints: HashMap<Participant, String>,
    me: Participant,
    workflow_id: String,
}

impl HttpTransport {
    pub fn new(
        endpoints: HashMap<Participant, String>,
        me: Participant,
        workflow_id: String,
    ) -> Self {
        Self {
            client: reqwest::Client::new(),
            endpoints,
            me,
            workflow_id,
        }
    }

    pub async fn send_private(&self, to: Participant, data: MessageData) -> anyhow::Result<()> {
        if to == self.me {
            return Ok(());
        }
        let endpoint = self
            .endpoints
            .get(&to)
            .with_context(|| format!("no endpoint for participant {:?}", to))?;
        let to_u32: u32 = to.into();
        let me_u32: u32 = self.me.into();
        let wire = WireMessage {
            workflow_id: self.workflow_id.clone(),
            from: me_u32,
            to: to_u32,
            data: format!("0x{}", hex::encode(data)),
        };
        let url = format!("{}/v1/internal/mpc/message", endpoint.trim_end_matches('/'));
        let response = self
            .client
            .post(url)
            .json(&wire)
            .send()
            .await
            .context("send MPC wire message")?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            bail!("peer {:?} rejected MPC message: {status}: {text}", to);
        }
        Ok(())
    }

    pub async fn send_many(&self, data: MessageData) -> anyhow::Result<()> {
        for participant in self.endpoints.keys().copied().collect::<Vec<_>>() {
            if participant != self.me {
                self.send_private(participant, data.clone()).await?;
            }
        }
        Ok(())
    }
}

pub fn workflow_id_from_bytes(domain: &str, bytes: &[u8]) -> String {
    use sha3::{Digest, Keccak256};
    let mut h = Keccak256::new();
    h.update(domain.as_bytes());
    h.update(bytes);
    format!("0x{}", hex::encode(h.finalize()))
}

pub fn manifest_digest(scheme: SignatureScheme) -> H256 {
    use sha3::{Digest, Keccak256};
    let label: &[u8] = match scheme {
        SignatureScheme::EcdsaSecp256k1 => {
            b"CROSSROADS_NEAR_MPC_COMMITTEE_V3_ECDSA_SECP256K1_ROBUST"
        }
        SignatureScheme::Ed25519 => b"CROSSROADS_NEAR_MPC_COMMITTEE_V3_ED25519_FROST",
    };
    H256::from_slice(&Keccak256::digest(label)[..])
}
