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
use std::sync::Arc;
use tokio::runtime::Runtime;
pub trait Intelligence: Send + Sync {
    fn generate(&self, scope: &CallScope, request: &Request) -> Result<Value>;
    fn embed(&self, scope: &CallScope, request: &Request) -> Result<Value>;
    /// Model name and version the next embedding would be recorded with.
    fn embedding_model(&self, _scope: &CallScope) -> Result<(String, String)> {
        anyhow::bail!(NOT_SET_UP)
    }
}
pub struct EmbeddingEndpoint {
    pub url: url::Url,
    pub model: String,
    /// Version from configuration. The default model has a fixed one.
    pub version: Option<String>,
    pub credential: Secret,
}
#[async_trait]
pub trait EmbeddingStore: Send + Sync {
    async fn for_actor(&self, actor: Actor) -> Result<EmbeddingEndpoint>;
    /// The search model that runs inside this host, when this account uses it instead of an
    /// endpoint. The default is none.
    async fn on_device(&self, _actor: Actor) -> Result<Option<Arc<dyn OnDeviceEmbedder>>> {
        Ok(None)
    }
}
/// A search model that runs inside the host. Text never leaves the machine.
pub trait OnDeviceEmbedder: Send + Sync {
    /// Blocks until the vector is ready or the time is up. The error is a plain sentence that
    /// holds no text, address or path.
    fn embed(&self, text: &str, timeout: std::time::Duration) -> Result<Vec<f32>, String>;
}
/// Model name and version written beside every vector, from the endpoint or the on-device model.
async fn provenance_for<E: EmbeddingStore>(embeddings: &E, actor: Actor) -> Result<(String, String)> {
    if embeddings.on_device(actor.clone()).await?.is_some() {
        return Ok((
            DEFAULT_EMBEDDING_MODEL.to_owned(),
            DEFAULT_EMBEDDING_VERSION.to_owned(),
        ));
    }
    Ok(embeddings.for_actor(actor).await?.provenance())
}
pub struct RouterIntelligence<S, T, E> {
    router: Router<S, T>,
    embeddings: E,
    activity: Option<Arc<dyn EmbeddingActivity>>,
    runtime: Runtime,
}
impl<S: ConfigurationStore, T: CapabilityTransport, E: EmbeddingStore> RouterIntelligence<S, T, E> {
    pub fn new(store: S, transport: T, embeddings: E) -> Result<Self> {
        Ok(Self {
            router: Router { store, transport },
            embeddings,
            activity: None,
            runtime: Runtime::new()?,
        })
    }
    /// Records one activity row per embedding call.
    pub fn with_activity(mut self, activity: Arc<dyn EmbeddingActivity>) -> Self {
        self.activity = Some(activity);
        self
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
        embed_via(&self.runtime, &self.embeddings, self.activity.as_ref(), scope, r)
    }
    fn embedding_model(&self, scope: &CallScope) -> Result<(String, String)> {
        let actor = Actor::from_authenticated_session(
            scope.access().actor_user_id(),
            uuid::Uuid::new_v4(),
        );
        self.runtime
            .block_on(provenance_for(&self.embeddings, actor))
    }
}

/// Vector size every stored memory vector must have.
pub const EMBEDDING_DIMENSIONS: usize = 768;
/// Model the legacy app uses when none is configured, and the version it records for it.
pub const DEFAULT_EMBEDDING_MODEL: &str = "nomic-ai/nomic-embed-text-v1.5";
const DEFAULT_EMBEDDING_VERSION: &str = "1.5";
/// Shown to the user when no endpoint has been set up.
pub const NOT_SET_UP: &str = "No embedding model is set up";

/// Which side of a search a text is on. The model needs a different prefix for each.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EmbeddingKind {
    Document,
    Query,
}
impl EmbeddingKind {
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Document => "search_document: ",
            Self::Query => "search_query: ",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Query => "query",
        }
    }
}

/// True for an https address, or an http address on this machine only. Plain http elsewhere
/// would send the credential and the note text across the network unencrypted.
pub fn valid_endpoint_url(text: &str) -> bool {
    url::Url::parse(text).is_ok_and(|u| {
        let local = match u.host() {
            Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(a)) => a.is_loopback(),
            Some(url::Host::Ipv6(a)) => a.is_loopback(),
            None => false,
        };
        (u.scheme() == "https" || (u.scheme() == "http" && local))
            && u.host().is_some()
            && u.username().is_empty()
            && u.password().is_none()
    })
}

impl EmbeddingEndpoint {
    /// Model name and version written beside every vector.
    pub fn provenance(&self) -> (String, String) {
        let version = match (&self.version, self.model == DEFAULT_EMBEDDING_MODEL) {
            (Some(v), _) => v.clone(),
            (None, true) => DEFAULT_EMBEDDING_VERSION.to_owned(),
            (None, false) => "1".to_owned(),
        };
        (self.model.clone(), version)
    }
}

/// One row of model activity. It holds fixed words and a model name, never any text.
pub struct EmbeddingCall {
    pub actor: uuid::Uuid,
    pub model: String,
    pub action: &'static str,
    pub outcome: &'static str,
    pub result: String,
}
#[async_trait]
pub trait EmbeddingActivity: Send + Sync {
    async fn record(&self, call: EmbeddingCall);
}

/// The only accepted vector shape: exactly 768 finite numbers.
pub fn check_vector(vector: &[Value]) -> Result<Vec<f64>> {
    ensure!(
        vector.len() == EMBEDDING_DIMENSIONS,
        "Embedding vector has the wrong size"
    );
    vector
        .iter()
        .map(|v| {
            v.as_f64()
                .filter(|n| n.is_finite())
                .context("Embedding vector has a value that is not a finite number")
        })
        .collect()
}

async fn request_vector(
    endpoint: &EmbeddingEndpoint,
    input: &str,
    remaining: std::time::Duration,
) -> Result<Vec<f64>> {
    ensure!(
        matches!(endpoint.url.scheme(), "https" | "http")
            && endpoint.url.username().is_empty()
            && endpoint.url.password().is_none(),
        "Invalid host embedding configuration"
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(remaining)
        .build()
        .map_err(|_| anyhow::anyhow!("Embedding service unavailable"))?;
    let mut response = client
        .post(endpoint.url.clone())
        .bearer_auth(endpoint.credential.expose_secret())
        .json(&json!({"model":endpoint.model,"input":input}))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Embedding service unavailable"))?;
    ensure!(
        response.status().is_success()
            && response.content_length().is_none_or(|n| n <= 1024 * 1024),
        "Embedding request refused"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Embedding service unavailable"))?
    {
        ensure!(
            bytes.len() + chunk.len() <= 1024 * 1024,
            "Embedding response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Invalid embedding response"))?;
    let vector = value["data"][0]["embedding"]
        .as_array()
        .context("Invalid embedding response")?;
    check_vector(vector)
}

fn embed_via<E: EmbeddingStore>(
    runtime: &Runtime,
    embeddings: &E,
    activity: Option<&Arc<dyn EmbeddingActivity>>,
    scope: &CallScope,
    r: &Request,
) -> Result<Value> {
    ensure!(r.operation == "create", "Unknown embedding operation");
    let text = r.parameters["text"]
        .as_str()
        .context("Embedding text required")?;
    ensure!(!text.is_empty(), "Embedding text required");
    ensure!(text.len() <= 64 * 1024, "Embedding text too large");
    let kind = match r.parameters["kind"].as_str() {
        None | Some("document") => EmbeddingKind::Document,
        Some("query") => EmbeddingKind::Query,
        Some(_) => anyhow::bail!("Unknown embedding kind"),
    };
    let actor =
        Actor::from_authenticated_session(scope.access().actor_user_id(), uuid::Uuid::new_v4());
    runtime.block_on(async {
        tokio::time::timeout(scope.remaining(), async {
            let input = format!("{}{text}", kind.prefix());
            let (model, version, outcome) = if let Some(device) =
                embeddings.on_device(actor.clone()).await?
            {
                let wait = scope.remaining();
                let vector = tokio::task::spawn_blocking(move || {
                    device.embed(&input, wait).map_err(|e| anyhow::anyhow!(e))
                })
                .await
                .map_err(|_| anyhow::anyhow!("Embedding service unavailable"))
                .and_then(|r| r)
                .and_then(|v| {
                    let numbers: Vec<Value> = v.iter().map(|n| json!(f64::from(*n))).collect();
                    check_vector(&numbers)
                });
                (
                    DEFAULT_EMBEDDING_MODEL.to_owned(),
                    DEFAULT_EMBEDDING_VERSION.to_owned(),
                    vector,
                )
            } else {
                let endpoint = embeddings.for_actor(actor).await?;
                let (model, version) = endpoint.provenance();
                let outcome = request_vector(&endpoint, &input, scope.remaining()).await;
                (model, version, outcome)
            };
            if let Some(activity) = activity {
                activity
                    .record(EmbeddingCall {
                        actor: scope.access().actor_user_id(),
                        model: model.clone(),
                        action: match kind {
                            EmbeddingKind::Document => "embed document",
                            EmbeddingKind::Query => "embed query",
                        },
                        outcome: if outcome.is_ok() { "ok" } else { "error" },
                        result: match &outcome {
                            Ok(_) => String::new(),
                            Err(e) => e.to_string(),
                        },
                    })
                    .await;
            }
            Ok::<_, anyhow::Error>(
                json!({"embedding":outcome?,"model":model,"version":version}),
            )
        })
        .await
        .context("Embedding deadline exceeded")?
    })
}

/// Embeddings from one configured endpoint. Text generation fails closed.
pub struct EmbeddingsOnly<E> {
    embeddings: E,
    activity: Option<Arc<dyn EmbeddingActivity>>,
    runtime: Runtime,
}
impl<E: EmbeddingStore> EmbeddingsOnly<E> {
    pub fn new(embeddings: E) -> Result<Self> {
        Ok(Self {
            embeddings,
            activity: None,
            runtime: Runtime::new()?,
        })
    }
    /// Records one activity row per embedding call.
    pub fn with_activity(mut self, activity: Arc<dyn EmbeddingActivity>) -> Self {
        self.activity = Some(activity);
        self
    }
}
impl<E: EmbeddingStore> Intelligence for EmbeddingsOnly<E> {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Module AI is not configured on this server")
    }
    fn embed(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        embed_via(&self.runtime, &self.embeddings, self.activity.as_ref(), scope, r)
    }
    fn embedding_model(&self, scope: &CallScope) -> Result<(String, String)> {
        let actor = Actor::from_authenticated_session(
            scope.access().actor_user_id(),
            uuid::Uuid::new_v4(),
        );
        self.runtime
            .block_on(provenance_for(&self.embeddings, actor))
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
            version: None,
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
    fn embed(&self, scope: &CallScope, kind: EmbeddingKind, text: &str) -> Result<Vec<f64>> {
        let value = self.ai.embed(
            scope,
            &Request {
                operation: "create".into(),
                resource: "embeddings".into(),
                parameters: json!({ "text": text, "kind": kind.name() }),
            },
        )?;
        check_vector(
            value["embedding"]
                .as_array()
                .context("Invalid embedding response")?,
        )
    }
}
impl crate::memory_ingest::DocumentEmbeddings for IntelligenceEmbeddings {
    fn model_name(&self) -> &str {
        &self.model
    }
    fn model_version(&self) -> &str {
        "1"
    }
    fn model(&self, scope: &CallScope) -> Result<(String, String)> {
        self.ai.embedding_model(scope)
    }
    fn embed_document(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>> {
        self.embed(scope, EmbeddingKind::Document, text)
    }
}
impl crate::memory_search::QueryEmbeddings for IntelligenceEmbeddings {
    fn embed_query(&self, scope: &CallScope, query: &str) -> Result<Vec<f64>> {
        self.embed(scope, EmbeddingKind::Query, query)
    }
}
