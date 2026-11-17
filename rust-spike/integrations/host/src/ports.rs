//! What the host needs from the rest of the server. The shell supplies the model call, and the
//! discoverer reaches the connected service.
use async_trait::async_trait;
use moss_integrations::{sortmap::SortedBy, tool::Tool};
use serde_json::Value;
use uuid::Uuid;

/// Why a model call gave no reply.
#[derive(Debug, PartialEq, Eq)]
pub enum ModelFailure {
    /// The call was cancelled or the model is not set up. Nothing is written for these tools.
    NotReady,
    /// The provider failed.
    Error,
}

/// The chat model that sorts tools for one person.
#[async_trait]
pub trait SortModel: Send + Sync {
    /// The model that would sort now, or `None` when no default chat model can return JSON.
    async fn select(&self, actor: Uuid) -> Option<SortedBy>;
    /// One structured call. The reply text is checked by the host.
    async fn run(&self, actor: Uuid, prompt: &str, max_output_tokens: u32) -> Result<String, ModelFailure>;
}

/// What a connection's service returned when asked for its tools.
pub struct Discovery {
    pub tools: Vec<Tool>,
    pub base_url: Option<String>,
    pub spec_pasted: bool,
}

pub struct DiscoverRequest<'a> {
    pub kind: &'a str,
    pub url: &'a str,
    pub secret: Option<&'a str>,
    pub placement: Option<&'a Value>,
    pub spec: Option<&'a str>,
}

/// Asks a service for its tools. The error text is what the person sees.
#[async_trait]
pub trait Discoverer: Send + Sync {
    async fn discover(&self, request: &DiscoverRequest<'_>) -> Result<Discovery, String>;
}

/// Reads a model reply as the sort answer. The reply may arrive inside a code fence. It must be
/// an object with a `tools` array, as the reply schema says.
pub fn parse_model_reply(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    let body = match trimmed.strip_prefix("```") {
        Some(rest) => {
            let rest = rest.strip_prefix("json").unwrap_or(rest);
            rest.trim_start_matches(['\r', '\n']).trim_end().strip_suffix("```").unwrap_or(rest).trim()
        }
        None => trimmed,
    };
    let value: Value = serde_json::from_str(body).ok()?;
    value.get("tools").is_some_and(Value::is_array).then_some(value)
}
