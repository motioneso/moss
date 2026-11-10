//! General intelligence ports join Phase 2b's capability router. Configuration and provider
//! credentials are supplied by the host's account services, never by a guest request.
use crate::runtime::{CallScope, Request};
use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use moss_platform_contracts::Actor;
use moss_platform_routing::{
    Capability, CapabilityTransport, ConfigurationStore, Router, Turn, TurnRole,
};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use tokio::runtime::Runtime;
pub trait Intelligence: Send + Sync {
    fn generate(&self, scope: &CallScope, request: &Request) -> Result<Value>;
    fn embed(&self, scope: &CallScope, request: &Request) -> Result<Value>;
}
pub struct EmbeddingEndpoint {
    pub url: url::Url,
    pub model: String,
    pub credential: Secret,
}
#[async_trait]
pub trait EmbeddingStore: Send + Sync {
    async fn for_actor(&self, actor: Actor) -> Result<EmbeddingEndpoint>;
}
pub struct RouterIntelligence<S, T, E> {
    router: Router<S, T>,
    embeddings: E,
    runtime: Runtime,
}
impl<S: ConfigurationStore, T: CapabilityTransport, E: EmbeddingStore> RouterIntelligence<S, T, E> {
    pub fn new(store: S, transport: T, embeddings: E) -> Result<Self> {
        Ok(Self {
            router: Router { store, transport },
            embeddings,
            runtime: Runtime::new()?,
        })
    }
}
impl<S: ConfigurationStore, T: CapabilityTransport, E: EmbeddingStore> Intelligence
    for RouterIntelligence<S, T, E>
{
    fn generate(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        let capability = match r.resource.as_str() {
            "summarization" => Capability::Summarization,
            "structured" => Capability::Json,
            "chat" => Capability::Chat,
            "tool-use" => Capability::ToolUse,
            "vision" => Capability::Vision,
            "web-search" => Capability::WebSearch,
            _ => anyhow::bail!("Unknown AI capability"),
        };
        let prompt = r.parameters["prompt"]
            .as_str()
            .context("AI prompt required")?;
        ensure!(prompt.len() <= 64 * 1024, "AI prompt too large");
        let max = r.parameters["maxOutputTokens"].as_u64().unwrap_or(4096);
        ensure!(max > 0 && max <= 32768, "Invalid output limit");
        let actor =
            Actor::from_authenticated_session(scope.access().actor_user_id(), uuid::Uuid::new_v4());
        let text = self.runtime.block_on(async {
            tokio::time::timeout(
                scope.remaining(),
                self.router.generate(
                    actor,
                    capability,
                    &[Turn {
                        role: TurnRole::User,
                        content: prompt.into(),
                    }],
                    max as u32,
                ),
            )
            .await
            .context("AI deadline exceeded")?
            .map_err(|_| {
                anyhow::anyhow!("The configured AI service could not complete the request")
            })
        })?;
        Ok(json!({"text":text}))
    }
    fn embed(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        embed_via(&self.runtime, &self.embeddings, scope, r)
    }
}

fn embed_via<E: EmbeddingStore>(
    runtime: &Runtime,
    embeddings: &E,
    scope: &CallScope,
    r: &Request,
) -> Result<Value> {
    ensure!(r.operation == "create", "Unknown embedding operation");
    let text = r.parameters["text"]
        .as_str()
        .context("Embedding text required")?;
    ensure!(text.len() <= 64 * 1024, "Embedding text too large");
    let actor =
        Actor::from_authenticated_session(scope.access().actor_user_id(), uuid::Uuid::new_v4());
    runtime.block_on(async {
        tokio::time::timeout(scope.remaining(), async {
            let endpoint = embeddings.for_actor(actor).await?;
            ensure!(
                matches!(endpoint.url.scheme(), "https" | "http")
                    && endpoint.url.username().is_empty()
                    && endpoint.url.password().is_none(),
                "Invalid host embedding configuration"
            );
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(scope.remaining())
                .build()?;
            let response = client
                .post(endpoint.url)
                .bearer_auth(endpoint.credential.expose_secret())
                .json(&json!({"model":endpoint.model,"input":text}))
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("Embedding service unavailable"))?;
            ensure!(
                response.status().is_success()
                    && response.content_length().is_none_or(|n| n <= 1024 * 1024),
                "Embedding request refused"
            );
            let mut response = response;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                ensure!(
                    bytes.len() + chunk.len() <= 1024 * 1024,
                    "Embedding response too large"
                );
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes)?;
            let vector = value["data"][0]["embedding"]
                .as_array()
                .context("Invalid embedding response")?;
            ensure!(
                !vector.is_empty()
                    && vector.len() <= 65536
                    && vector
                        .iter()
                        .all(|v| v.as_f64().is_some_and(f64::is_finite)),
                "Invalid embedding vector"
            );
            Ok::<_, anyhow::Error>(json!({"embedding":vector}))
        })
        .await
        .context("Embedding deadline exceeded")?
    })
}

/// Embeddings from one configured endpoint. Text generation fails closed.
pub struct EmbeddingsOnly<E> {
    embeddings: E,
    runtime: Runtime,
}
impl<E: EmbeddingStore> EmbeddingsOnly<E> {
    pub fn new(embeddings: E) -> Result<Self> {
        Ok(Self {
            embeddings,
            runtime: Runtime::new()?,
        })
    }
}
impl<E: EmbeddingStore> Intelligence for EmbeddingsOnly<E> {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Module AI is not configured on this server")
    }
    fn embed(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        embed_via(&self.runtime, &self.embeddings, scope, r)
    }
}

/// One endpoint for every account, from the server's modules file.
pub struct FixedEmbeddings {
    pub url: url::Url,
    pub model: String,
    credential: String,
}
impl FixedEmbeddings {
    pub fn new(url: url::Url, model: String, credential: String) -> Self {
        Self {
            url,
            model,
            credential,
        }
    }
}
#[async_trait]
impl EmbeddingStore for FixedEmbeddings {
    async fn for_actor(&self, _: Actor) -> Result<EmbeddingEndpoint> {
        Ok(EmbeddingEndpoint {
            url: self.url.clone(),
            model: self.model.clone(),
            credential: Secret::new(self.credential.clone()),
        })
    }
}

/// Document and query embeddings from the host's configured intelligence service.
pub struct IntelligenceEmbeddings {
    ai: std::sync::Arc<dyn Intelligence>,
    model: String,
}
impl IntelligenceEmbeddings {
    pub fn new(ai: std::sync::Arc<dyn Intelligence>, model: String) -> Self {
        Self { ai, model }
    }
    fn embed(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>> {
        let value = self.ai.embed(
            scope,
            &Request {
                operation: "create".into(),
                resource: "embeddings".into(),
                parameters: json!({ "text": text }),
            },
        )?;
        value["embedding"]
            .as_array()
            .context("Invalid embedding response")?
            .iter()
            .map(|n| n.as_f64().context("Invalid embedding response"))
            .collect()
    }
}
impl crate::memory_ingest::DocumentEmbeddings for IntelligenceEmbeddings {
    fn model_name(&self) -> &str {
        &self.model
    }
    fn model_version(&self) -> &str {
        "1"
    }
    fn embed_document(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>> {
        self.embed(scope, text)
    }
}
impl crate::memory_search::QueryEmbeddings for IntelligenceEmbeddings {
    fn embed_query(&self, scope: &CallScope, query: &str) -> Result<Vec<f64>> {
        self.embed(scope, query)
    }
}
