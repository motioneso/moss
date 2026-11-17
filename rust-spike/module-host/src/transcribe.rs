//! Speech to text for packages. The audio stays in the host. The package names the route it
//! expects, and the host refuses to send anything when the configured route has changed.
//! The credential never leaves this file and activity rows never carry audio or text.
use crate::ai::{valid_endpoint_url, EmbeddingActivity, EmbeddingCall};
use crate::runtime::{CallScope, Request};
use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_platform_contracts::Actor;
use safety_core::secret::Secret;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::runtime::Runtime;

/// Largest clip the host accepts, in bytes of WAV.
pub const MAX_AUDIO_BYTES: usize = 3_840_044;
const DEADLINE: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SEGMENTS: usize = 10_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_LANGUAGE: usize = 32;
const MAX_PROMPT: usize = 4096;

/// The speech route a person's configuration resolves to right now.
pub struct TranscriptionRoute {
    pub base: url::Url,
    pub model: String,
    pub provider: String,
    pub credential: Secret,
}
impl TranscriptionRoute {
    /// Hash over the endpoint, the model, the provider and a hash of the credential. Equal digests
    /// mean the same endpoint, model and provider with the same key.
    pub fn digest(&self) -> String {
        let key = Sha256::digest(self.credential.expose_secret().as_bytes());
        let mut hash = Sha256::new();
        for part in [self.base.as_str().as_bytes(), self.model.as_bytes(), self.provider.as_bytes(), &key] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part);
        }
        hex(&hash.finalize())
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[async_trait]
pub trait TranscriptionStore: Send + Sync {
    /// The route for this person, resolved from their own configuration.
    async fn route(&self, actor: Actor) -> Result<TranscriptionRoute>;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stage {
    Configuration,
    Dispatch,
    Response,
    Validation,
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Configuration => "configuration",
            Self::Dispatch => "dispatch",
            Self::Response => "response",
            Self::Validation => "validation",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reason {
    ConfigurationUnavailable,
    RouteChanged,
    ProviderTimeout,
    ProviderRateLimited,
    ProviderAuthentication,
    ProviderUnavailable,
    ProviderNetwork,
    ProviderResponseInvalid,
    InvalidAudio,
}
impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Self::ConfigurationUnavailable => "configuration-unavailable",
            Self::RouteChanged => "route-changed",
            Self::ProviderTimeout => "provider-timeout",
            Self::ProviderRateLimited => "provider-rate-limited",
            Self::ProviderAuthentication => "provider-authentication",
            Self::ProviderUnavailable => "provider-unavailable",
            Self::ProviderNetwork => "provider-network",
            Self::ProviderResponseInvalid => "provider-response-invalid",
            Self::InvalidAudio => "invalid-audio",
        }
    }
    /// A later try can succeed without anyone changing anything.
    fn retryable(self) -> bool {
        matches!(
            self,
            Self::ProviderTimeout
                | Self::ProviderRateLimited
                | Self::ProviderUnavailable
                | Self::ProviderNetwork
        )
    }
}

struct Failure(Reason, Stage);
impl Failure {
    fn json(&self) -> Value {
        json!({"ok":false,"reason":self.0.name(),"stage":self.1.name(),"retryable":self.0.retryable()})
    }
}

struct Input {
    audio: Vec<u8>,
    language: Option<String>,
    prompt: Option<String>,
    expected: String,
}

/// A malformed request is a bug in the package, so it is an error. A bad clip is a result.
fn parse(parameters: &Value) -> Result<Result<Input, Failure>> {
    let map = parameters.as_object().context("Transcription needs an object")?;
    ensure!(
        map.keys().all(|k| matches!(k.as_str(), "audioBase64" | "language" | "prompt" | "expectedRoute")),
        "Unknown transcription parameter"
    );
    let text = |name: &str, max: usize| -> Result<Option<String>> {
        match map.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => {
                let v = v.as_str().with_context(|| format!("{name} must be text"))?;
                ensure!(v.len() <= max, "{name} is too long");
                Ok(Some(v.to_owned()))
            }
        }
    };
    let expected = text("expectedRoute", 64)?.context("expectedRoute required")?;
    ensure!(expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_hexdigit()), "expectedRoute must be a route digest");
    let language = text("language", MAX_LANGUAGE)?;
    let prompt = text("prompt", MAX_PROMPT)?;
    let encoded = map.get("audioBase64").and_then(Value::as_str).context("audioBase64 required")?;
    // Reject before decoding, so a huge string never turns into a huge buffer.
    if encoded.len() > MAX_AUDIO_BYTES.div_ceil(3) * 4 {
        return Ok(Err(Failure(Reason::InvalidAudio, Stage::Validation)));
    }
    let Ok(audio) = STANDARD.decode(encoded) else {
        return Ok(Err(Failure(Reason::InvalidAudio, Stage::Validation)));
    };
    if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES {
        return Ok(Err(Failure(Reason::InvalidAudio, Stage::Validation)));
    }
    Ok(Ok(Input { audio, language, prompt, expected: expected.to_ascii_lowercase() }))
}

fn multipart(boundary: &str, route: &TranscriptionRoute, input: &Input) -> Vec<u8> {
    let mut body = Vec::with_capacity(input.audio.len() + 1024);
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    };
    field("model", &route.model);
    if let Some(language) = &input.language {
        field("language", language);
    }
    if let Some(prompt) = &input.prompt {
        field("prompt", prompt);
    }
    field("response_format", "verbose_json");
    field("timestamp_granularities[]", "segment");
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    body.extend_from_slice(&input.audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

fn failure_for_status(status: u16) -> Reason {
    match status {
        429 => Reason::ProviderRateLimited,
        408 => Reason::ProviderTimeout,
        401 | 403 => Reason::ProviderAuthentication,
        500.. => Reason::ProviderUnavailable,
        _ => Reason::ProviderResponseInvalid,
    }
}

fn segments(body: &[u8]) -> Result<Vec<Value>, Failure> {
    let invalid = || Failure(Reason::ProviderResponseInvalid, Stage::Validation);
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    let list = value.get("segments").and_then(Value::as_array).ok_or_else(invalid)?;
    if list.len() > MAX_SEGMENTS {
        return Err(invalid());
    }
    let mut total = 0usize;
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        let start = item.get("start").and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0);
        let end = item.get("end").and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0);
        let text = item.get("text").and_then(Value::as_str);
        let (Some(start), Some(end), Some(text)) = (start, end, text) else {
            return Err(invalid());
        };
        total += text.len();
        // 24 hours of audio is far beyond any clip the host accepts.
        if end < start || end > 86_400.0 || total > MAX_TEXT_BYTES {
            return Err(invalid());
        }
        out.push(json!({"startMs":(start * 1000.0).round() as i64,"endMs":(end * 1000.0).round() as i64,"text":text}));
    }
    Ok(out)
}

async fn send(route: &TranscriptionRoute, input: &Input, budget: Duration) -> Result<Vec<Value>, Failure> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(budget)
        .build()
        .map_err(|_| Failure(Reason::ProviderNetwork, Stage::Dispatch))?;
    let address = format!("{}/v1/audio/transcriptions", route.base.as_str().trim_end_matches('/'));
    let boundary = format!("moss-{}", uuid::Uuid::new_v4().simple());
    let mut response = client
        .post(address)
        .bearer_auth(route.credential.expose_secret())
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(multipart(&boundary, route, input))
        .send()
        .await
        .map_err(|e| {
            Failure(if e.is_timeout() { Reason::ProviderTimeout } else { Reason::ProviderNetwork }, Stage::Dispatch)
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(Failure(failure_for_status(status.as_u16()), Stage::Response));
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(Failure(Reason::ProviderResponseInvalid, Stage::Response));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                return Err(Failure(
                    if e.is_timeout() { Reason::ProviderTimeout } else { Reason::ProviderNetwork },
                    Stage::Response,
                ))
            }
        }
    }
    segments(&bytes)
}

async fn run_create(store: &dyn TranscriptionStore, actor: Actor, input: Input, remaining: Duration) -> (Value, Option<String>, Option<&'static str>) {
    let budget = remaining.min(DEADLINE);
    let result = tokio::time::timeout(budget, async {
        let first = store.route(actor).await.map_err(|_| (Failure(Reason::ConfigurationUnavailable, Stage::Configuration), None))?;
        let model = first.model.clone();
        if !valid_endpoint_url(first.base.as_str()) {
            return Err((Failure(Reason::ConfigurationUnavailable, Stage::Configuration), Some(model)));
        }
        if first.digest() != input.expected {
            return Err((Failure(Reason::RouteChanged, Stage::Configuration), Some(model)));
        }
        let segments = send(&first, &input, budget).await.map_err(|f| (f, Some(model.clone())))?;
        // The configuration may have changed while the provider was working.
        let after = store.route(actor).await.map_err(|_| (Failure(Reason::RouteChanged, Stage::Response), Some(model.clone())))?;
        if after.digest() != first.digest() {
            return Err((Failure(Reason::RouteChanged, Stage::Response), Some(model)));
        }
        Ok((segments, model))
    })
    .await;
    match result {
        Ok(Ok((segments, model))) => (json!({"ok":true,"segments":segments,"route":input.expected}), Some(model), None),
        Ok(Err((failure, model))) => (failure.json(), model, Some(failure.0.name())),
        Err(_) => {
            let failure = Failure(Reason::ProviderTimeout, Stage::Dispatch);
            (failure.json(), None, Some(failure.0.name()))
        }
    }
}

/// Handles the `transcribe` port: `availability` and `create`.
pub fn handle(
    runtime: &Runtime,
    store: &dyn TranscriptionStore,
    activity: Option<&Arc<dyn EmbeddingActivity>>,
    scope: &CallScope,
    request: &Request,
) -> Result<Value> {
    let actor = Actor::from_authenticated_session(scope.access().actor_user_id(), uuid::Uuid::new_v4());
    match request.operation.as_str() {
        "availability" => {
            ensure!(request.parameters.as_object().is_some_and(|m| m.is_empty()), "Availability takes no parameters");
            Ok(runtime.block_on(async {
                match tokio::time::timeout(scope.remaining().min(DEADLINE), store.route(actor)).await {
                    Ok(Ok(route)) if valid_endpoint_url(route.base.as_str()) => {
                        json!({"available":true,"route":route.digest(),"model":route.model})
                    }
                    _ => json!({"available":false}),
                }
            }))
        }
        "create" => {
            ensure!(request.resource == "audio", "Unknown transcription resource");
            let input = match parse(&request.parameters)? {
                Ok(input) => input,
                Err(failure) => return Ok(failure.json()),
            };
            let size = input.audio.len();
            let (reply, model, failed) = runtime.block_on(run_create(store, actor, input, scope.remaining()));
            if let Some(activity) = activity {
                runtime.block_on(activity.record(EmbeddingCall {
                    actor: scope.access().actor_user_id(),
                    model: model.unwrap_or_else(|| "unavailable".into()),
                    action: "transcribe",
                    outcome: if failed.is_none() { "ok" } else { "error" },
                    result: match failed {
                        None => format!("{size} bytes"),
                        Some(reason) => format!("{reason}, {size} bytes"),
                    },
                }));
            }
            Ok(reply)
        }
        _ => anyhow::bail!("Unknown transcription operation"),
    }
}
