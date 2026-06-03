use std::sync::Arc;

use anyhow::{bail, Context};
use ethers::{
    abi::{Function, Param, ParamType, StateMutability, Token},
    contract::abigen,
    middleware::SignerMiddleware,
    providers::{Http, Middleware, Provider},
    signers::{LocalWallet, Signer},
    types::{Address, Bytes, TransactionRequest, H256, U256},
};

use crate::{
    config::Config,
    types::{Committee, CommitteeMember, RootRecord, SignatureScheme},
};

abigen!(
    CommitteeBootstrapContract,
    r#"[
        function bootstrapComplete() view returns (bool)
        function quorumThreshold() view returns (uint8)
        function committeeId() view returns (bytes32)
        function memberCount() view returns (uint256)
        function rootRecordActive(uint8 schemeId) view returns (bool)
        function submitRootRecord(uint8 schemeId, bytes publicKey, bytes32 chainCode, bytes32 manifestDigest)
    ]"#
);

abigen!(
    AssetPolicyContract,
    r#"[
        function canSign(address spender, bytes32 encAccount, bytes txData) view returns (bool)
        function signatureScheme() view returns (uint8)
    ]"#
);

#[derive(Clone)]
pub struct ChainClient {
    provider: Arc<Provider<Http>>,
    bootstrap: Address,
    admin_wallet: Option<LocalWallet>,
}

impl ChainClient {
    pub async fn new(cfg: &Config) -> anyhow::Result<Self> {
        let provider =
            Provider::<Http>::try_from(cfg.evm_rpc_url.as_str()).context("invalid EVM RPC URL")?;
        let provider = Arc::new(provider);
        let chain_id = provider
            .get_chainid()
            .await
            .context("get EVM chain id")?
            .as_u64();
        let admin_wallet = match &cfg.admin_private_key {
            Some(pk) => Some(
                pk.parse::<LocalWallet>()
                    .context("parse ADMIN_PRIVATE_KEY")?
                    .with_chain_id(chain_id),
            ),
            None => None,
        };
        Ok(Self {
            provider,
            bootstrap: cfg.bootstrap_address()?,
            admin_wallet,
        })
    }

    pub async fn load_committee(&self) -> anyhow::Result<Committee> {
        let contract = CommitteeBootstrapContract::new(self.bootstrap, self.provider.clone());
        let complete = contract
            .bootstrap_complete()
            .call()
            .await
            .context("read bootstrapComplete")?;
        if !complete {
            bail!("bootstrap contract has not been finalized yet");
        }
        let threshold: u8 = contract
            .quorum_threshold()
            .call()
            .await
            .context("read quorumThreshold")?;
        let committee_id: [u8; 32] = contract
            .committee_id()
            .call()
            .await
            .context("read committeeId")?;
        let count: U256 = contract
            .member_count()
            .call()
            .await
            .context("read memberCount")?;
        let mut members = Vec::new();
        for i in 0..count.as_usize() {
            let m = self
                .get_member(i)
                .await
                .with_context(|| format!("read member {i}"))?;
            members.push(CommitteeMember {
                id: format!("0x{}", hex::encode(m.id)),
                participant: (i as u32) + 1,
                admin: m.admin,
                endpoint: m.public_endpoint,
                active: m.active,
            });
        }
        Ok(Committee {
            contract: self.bootstrap,
            committee_id: H256::from(committee_id),
            threshold: threshold as usize,
            members,
        })
    }

    pub async fn load_root_record(
        &self,
        scheme: SignatureScheme,
    ) -> anyhow::Result<Option<RootRecord>> {
        let contract = CommitteeBootstrapContract::new(self.bootstrap, self.provider.clone());
        if !contract
            .root_record_active(scheme.scheme_id())
            .call()
            .await
            .context("read rootRecordActive")?
        {
            return Ok(None);
        }
        self.root_record(scheme).await.map(Some)
    }

    pub async fn asset_signature_scheme(&self, asset: Address) -> anyhow::Result<SignatureScheme> {
        let contract = AssetPolicyContract::new(asset, self.provider.clone());
        let scheme_id: u8 = contract
            .signature_scheme()
            .call()
            .await
            .context("asset signatureScheme view call")?;
        SignatureScheme::from_scheme_id(scheme_id)
    }

    pub async fn can_sign(
        &self,
        asset: Address,
        spender: Address,
        enc_account: [u8; 32],
        tx_data: Vec<u8>,
    ) -> anyhow::Result<bool> {
        let contract = AssetPolicyContract::new(asset, self.provider.clone());
        contract
            .can_sign(spender, enc_account, Bytes::from(tx_data))
            .call()
            .await
            .context("asset canSign view call")
    }

    pub async fn submit_root_record(
        &self,
        scheme: SignatureScheme,
        public_key: Vec<u8>,
        manifest_digest: H256,
    ) -> anyhow::Result<bool> {
        let Some(wallet) = self.admin_wallet.clone() else {
            return Ok(false);
        };
        let client = Arc::new(SignerMiddleware::new((*self.provider).clone(), wallet));
        let contract = CommitteeBootstrapContract::new(self.bootstrap, client);
        let call = contract.submit_root_record(
            scheme.scheme_id(),
            Bytes::from(public_key),
            [0u8; 32],
            manifest_digest.0,
        );
        let pending = call.send().await.context("submitRootRecord transaction")?;
        let receipt = pending.await.context("await submitRootRecord")?;
        if receipt.is_none() {
            bail!("submitRootRecord transaction dropped before receipt");
        }
        Ok(true)
    }

    async fn get_member(&self, i: usize) -> anyhow::Result<DecodedMember> {
        #[allow(deprecated)]
        let function = Function {
            name: "getMember".to_string(),
            inputs: vec![Param {
                name: "i".to_string(),
                kind: ParamType::Uint(256),
                internal_type: None,
            }],
            outputs: vec![Param {
                name: String::new(),
                kind: ParamType::Tuple(vec![
                    ParamType::FixedBytes(32),
                    ParamType::Address,
                    ParamType::String,
                    ParamType::FixedBytes(32),
                    ParamType::FixedBytes(32),
                    ParamType::Bool,
                ]),
                internal_type: Some("struct CommitteeBootstrap.Member".to_string()),
            }],
            constant: None,
            state_mutability: StateMutability::View,
        };
        let values = self
            .call_tuple(function, vec![Token::Uint(U256::from(i))])
            .await?;
        let [id, admin, public_endpoint, _bootstrap_pub_key, _client_auth_pub_key, active]: [Token;
            6] = values
            .try_into()
            .map_err(|_| anyhow::anyhow!("getMember returned an unexpected tuple shape"))?;
        Ok(DecodedMember {
            id: fixed_bytes_32(id, "member id")?,
            admin: into_address(admin, "member admin")?,
            public_endpoint: into_string(public_endpoint, "member publicEndpoint")?,
            active: into_bool(active, "member active")?,
        })
    }

    async fn root_record(&self, scheme: SignatureScheme) -> anyhow::Result<RootRecord> {
        #[allow(deprecated)]
        let function = Function {
            name: "rootRecord".to_string(),
            inputs: vec![Param {
                name: "schemeId".to_string(),
                kind: ParamType::Uint(8),
                internal_type: None,
            }],
            outputs: vec![Param {
                name: String::new(),
                kind: ParamType::Tuple(vec![
                    ParamType::Uint(8),
                    ParamType::Bytes,
                    ParamType::FixedBytes(32),
                    ParamType::FixedBytes(32),
                    ParamType::Bool,
                ]),
                internal_type: Some("struct CommitteeBootstrap.RootRecord".to_string()),
            }],
            constant: None,
            state_mutability: StateMutability::View,
        };
        let values = self
            .call_tuple(function, vec![Token::Uint(U256::from(scheme.scheme_id()))])
            .await?;
        let [scheme_id, public_key, _chain_code, manifest_digest, active]: [Token; 5] = values
            .try_into()
            .map_err(|_| anyhow::anyhow!("rootRecord returned an unexpected tuple shape"))?;
        Ok(RootRecord {
            scheme_id: into_u8(scheme_id, "rootRecord schemeId")?,
            public_key: Bytes::from(into_bytes(public_key, "rootRecord publicKey")?),
            manifest_digest: H256::from(fixed_bytes_32(
                manifest_digest,
                "rootRecord manifestDigest",
            )?),
            active: into_bool(active, "rootRecord active")?,
        })
    }

    async fn call_tuple(&self, function: Function, args: Vec<Token>) -> anyhow::Result<Vec<Token>> {
        let data = function
            .encode_input(&args)
            .context("encode contract call")?;
        let request = TransactionRequest::new()
            .to(self.bootstrap)
            .data(Bytes::from(data));
        let raw = self
            .provider
            .call(&request.into(), None)
            .await
            .context("call contract view")?;
        let output = function
            .decode_output(raw.as_ref())
            .context("decode contract view")?;
        match output.as_slice() {
            [Token::Tuple(values)] => Ok(values.clone()),
            _ => bail!("contract view returned an unexpected ABI output shape"),
        }
    }
}

struct DecodedMember {
    id: [u8; 32],
    admin: Address,
    public_endpoint: String,
    active: bool,
}

fn fixed_bytes_32(token: Token, label: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = match token {
        Token::FixedBytes(bytes) => bytes,
        _ => bail!("{label} was not bytes32"),
    };
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("{label} was not 32 bytes"))
}

fn into_address(token: Token, label: &str) -> anyhow::Result<Address> {
    match token {
        Token::Address(value) => Ok(value),
        _ => bail!("{label} was not an address"),
    }
}

fn into_bool(token: Token, label: &str) -> anyhow::Result<bool> {
    match token {
        Token::Bool(value) => Ok(value),
        _ => bail!("{label} was not a bool"),
    }
}

fn into_bytes(token: Token, label: &str) -> anyhow::Result<Vec<u8>> {
    match token {
        Token::Bytes(value) => Ok(value),
        _ => bail!("{label} was not bytes"),
    }
}

fn into_string(token: Token, label: &str) -> anyhow::Result<String> {
    match token {
        Token::String(value) => Ok(value),
        _ => bail!("{label} was not a string"),
    }
}

fn into_u8(token: Token, label: &str) -> anyhow::Result<u8> {
    match token {
        Token::Uint(value) => {
            u8::try_from(value.as_u32()).with_context(|| format!("{label} did not fit in uint8"))
        }
        _ => bail!("{label} was not a uint"),
    }
}
