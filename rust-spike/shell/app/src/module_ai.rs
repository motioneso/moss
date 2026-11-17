//! Module AI through the capability router. Models and provider credentials come from the
//! instance's own AI tables, read as the signed-in account so row rules apply. Nothing here
//! is reachable from a guest request.
use anyhow::Result;
use async_trait::async_trait;
use moss_module_host::ai::{EmbeddingEndpoint, EmbeddingStore, Intelligence, RouterIntelligence};
use moss_module_host::transcribe::{TranscriptionRoute, TranscriptionStore};
use moss_platform_adapters::{Endpoint, EndpointStore, HttpAdapters, Protocol, Secret};
use moss_platform_contracts::{Actor, Error};
use moss_platform_routing::{Capability, Configuration, ConfigurationStore, Model, Provider, Tier};
use safety_core::{
    access::AccessContext,
    db::{DataContext, Database},
    secret::SecretCipher,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;

const PIN_MODEL: &str = "ai.admin_pinned_model_id";
const PIN_PROVIDER: &str = "ai.admin_pinned_provider_id";

#[derive(Clone)]
pub struct AiStore {
    database: Database,
    cipher: Arc<SecretCipher>,
}

/// The four transports an automatic request may use. Every other kind is choice-only.
fn protocol(kind: &str) -> Option<Protocol> {
    match kind {
        "openai-compatible" => Some(Protocol::OpenaiCompatible),
        "anthropic" => Some(Protocol::Anthropic),
        "google" => Some(Protocol::Google),
        "ollama" => Some(Protocol::Ollama),
        _ => None,
    }
}

fn tier(text: &str) -> Tier {
    match text {
        "economy" => Tier::Economy,
        "reasoning" => Tier::Reasoning,
        _ => Tier::Interactive,
    }
}

impl AiStore {
    async fn open(&self, actor: Actor) -> Result<DataContext, Error> {
        DataContext::open(
            &self.database,
            &AccessContext::new(actor.user_id(), "module-ai"),
        )
        .await
        .map_err(|_| Error::Unavailable)
    }
}

#[async_trait]
impl ConfigurationStore for AiStore {
    async fn for_actor(&self, actor: Actor) -> Result<Configuration, Error> {
        let cx = self.open(actor).await?;
        let db = cx.db();
        let providers = db
            .query(
                "SELECT id, status::text, purpose, provider_kind::text, is_instance_default, \
                        app.owner_is_active_admin(owner_user_id) \
                 FROM app.ai_provider_configs",
                &[],
            )
            .await
            .map_err(|_| Error::Database)?;
        struct Row {
            active: bool,
            assistant: bool,
            kind: String,
        }
        let mut rows = BTreeMap::new();
        let mut config = Configuration::default();
        for p in &providers {
            let id: Uuid = p.get(0);
            let active = p.get::<_, String>(1) == "active";
            let assistant = p.get::<_, String>(2) == "assistant";
            if p.get::<_, bool>(4) && assistant {
                config.default_provider = Some(id);
            }
            config.providers.push(Provider {
                id,
                active,
                assistant,
                admin_owned: p.get(5),
            });
            rows.insert(
                id,
                Row {
                    active,
                    assistant,
                    kind: p.get(3),
                },
            );
        }
        let models = db
            .query(
                "SELECT id, provider_config_id, provider_model_id, capabilities, \
                        status::text, tier, \
                        to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), \
                        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') \
                 FROM app.ai_configured_models",
                &[],
            )
            .await
            .map_err(|_| Error::Database)?;
        for m in &models {
            let provider: Uuid = m.get(1);
            let Some(owner) = rows.get(&provider) else {
                continue;
            };
            let capabilities: Vec<String> = m.get(3);
            config.models.push(Model {
                id: m.get(0),
                provider_id: provider,
                provider_model_id: m.get(2),
                capabilities: capabilities
                    .into_iter()
                    .filter_map(|c| serde_json::from_value::<Capability>(json!(c)).ok())
                    .collect(),
                tier: tier(&m.get::<_, String>(5)),
                active: m.get::<_, String>(4) == "active",
                provider_active: owner.active,
                assistant: owner.assistant,
                automatic_eligible: protocol(&owner.kind).is_some(),
                default_sentinel: false,
                shared_transcription_eligible: false,
                voice_endpoint: !owner.assistant,
                allow_user_override: false,
                released_at: m.get(6),
                created_at: m.get(7),
            });
        }
        let pins = db
            .query(
                "SELECT key, value_json FROM app.preferences WHERE key = ANY($1)",
                &[&vec![PIN_MODEL, PIN_PROVIDER]],
            )
            .await
            .map_err(|_| Error::Database)?;
        for pin in &pins {
            let id = pin
                .get::<_, Value>(1)
                .as_str()
                .and_then(|s| s.parse::<Uuid>().ok());
            match pin.get::<_, String>(0).as_str() {
                PIN_MODEL => config.pinned_model = id,
                _ => config.pinned_provider = id,
            }
        }
        cx.commit().await.map_err(|_| Error::Database)?;
        Ok(config)
    }
}

#[async_trait]
impl EndpointStore for AiStore {
    async fn for_model(&self, actor: Actor, provider: Uuid) -> Result<Endpoint, Error> {
        let cx = self.open(actor).await?;
        let row = cx
            .db()
            .query_opt(
                "SELECT provider_kind::text, base_url, encrypted_credential \
                 FROM app.ai_provider_configs WHERE id = $1 AND status = 'active'",
                &[&provider],
            )
            .await
            .map_err(|_| Error::Database)?
            .ok_or(Error::Unavailable)?;
        cx.commit().await.map_err(|_| Error::Database)?;
        let protocol = protocol(&row.get::<_, String>(0)).ok_or(Error::Unavailable)?;
        let stored: Value = row.get(2);
        let fields = self.cipher.open(&stored).map_err(|_| Error::Unavailable)?;
        let key = fields.get("apiKey").ok_or(Error::Unavailable)?;
        Ok(Endpoint {
            protocol,
            base_url: row.get::<_, Option<String>>(1).unwrap_or_default(),
            credential: Secret::from_cipher_plaintext(key.expose_secret().to_owned()),
        })
    }
}

/// The speech route is the model the routing table picks for transcription, on its own
/// provider. Only OpenAI-compatible providers take the transcription request.
#[async_trait]
impl TranscriptionStore for AiStore {
    async fn route(&self, actor: Actor) -> Result<TranscriptionRoute> {
        let config = ConfigurationStore::for_actor(self, actor).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        let model = moss_platform_routing::resolve(&config, Capability::Transcription, Tier::Interactive)
            .model
            .ok_or_else(|| anyhow::anyhow!("No speech model is configured"))?;
        let cx = self.open(actor).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        let row = cx
            .db()
            .query_opt(
                "SELECT provider_kind::text, base_url, encrypted_credential \
                 FROM app.ai_provider_configs WHERE id = $1 AND status = 'active'",
                &[&model.provider_id],
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("The speech provider is not available"))?;
        cx.commit().await.map_err(|_| anyhow::anyhow!("The speech provider is not available"))?;
        anyhow::ensure!(
            row.get::<_, String>(0) == "openai-compatible",
            "The speech provider does not take this request"
        );
        let stored: Value = row.get(2);
        let fields = self.cipher.open(&stored).map_err(|_| anyhow::anyhow!("The speech credential is not available"))?;
        let key = fields.get("apiKey").ok_or_else(|| anyhow::anyhow!("The speech credential is not available"))?;
        let base = row.get::<_, Option<String>>(1).unwrap_or_default();
        Ok(TranscriptionRoute {
            base: base.parse()?,
            model: model.provider_model_id,
            provider: model.provider_id.to_string(),
            credential: safety_core::secret::Secret::new(key.expose_secret().to_owned()),
        })
    }
}

/// Embeddings have no configured source on this server yet, so they fail closed.
struct NoEmbeddings;
#[async_trait]
impl EmbeddingStore for NoEmbeddings {
    async fn for_actor(&self, _: Actor) -> Result<EmbeddingEndpoint> {
        anyhow::bail!("Module embeddings are not configured on this server")
    }
}

pub fn intelligence(database: Database, cipher: SecretCipher) -> Result<Arc<dyn Intelligence>> {
    let store = AiStore {
        database,
        cipher: Arc::new(cipher),
    };
    let transport = HttpAdapters::new(store.clone()).map_err(|e| anyhow::anyhow!("{e}"))?;
    let speech = Arc::new(store.clone());
    Ok(Arc::new(
        RouterIntelligence::new(store, transport, NoEmbeddings)?.with_transcription(speech),
    ))
}
