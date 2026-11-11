//! Where the instance's embedding endpoint is set, stored and read.
//!
//! The endpoint address, model name and model version are plain instance settings. The
//! credential is sealed with the instance key and kept in its own file under the data folder.
//! It is never returned by any route and never passes through a module's guest code.
use anyhow::Result;
use async_trait::async_trait;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use moss_module_host::ai::{
    valid_endpoint_url, EmbeddingActivity, EmbeddingCall, EmbeddingEndpoint, EmbeddingStore, DEFAULT_EMBEDDING_MODEL,
    NOT_SET_UP,
};
use moss_platform_contracts::Actor;
use safety_core::{
    access::AccessContext,
    db::{DataContext, Database},
    secret::{Secret, SecretCipher, SecretFields},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};

/// Legacy runtime config names. The Rust server stores the same two, and adds the three below.
const PROVIDER: &str = "ai.embed_provider";
const MODEL: &str = "ai.embed_model";
const URL: &str = "ai.embed_endpoint_url";
const VERSION: &str = "ai.embed_model_version";
/// Value of the provider setting once an endpoint is chosen. The legacy values are "local" and
/// "stub".
const ENDPOINT: &str = "endpoint";
const CREDENTIAL_FILE: &str = "embedding-credential.json";

pub struct EmbeddingConfig {
    database: Database,
    cipher: SecretCipher,
    file: PathBuf,
}

impl EmbeddingConfig {
    pub fn new(database: Database, connector_key: &str, data: &Path) -> Result<Self> {
        Ok(Self {
            database,
            cipher: SecretCipher::connectors(
                &[("JARVIS_CONNECTOR_SECRET_KEY".into(), connector_key.to_owned())].into(),
            )
            .map_err(|_| anyhow::anyhow!("Invalid module connector key"))?,
            file: data.join(CREDENTIAL_FILE),
        })
    }

    async fn read(&self, access: &AccessContext) -> Result<Stored> {
        let cx = DataContext::open(&self.database, access).await.map_err(|_| anyhow::anyhow!("Database unavailable"))?;
        let rows = cx
            .db()
            .query(
                "SELECT key, value FROM app.instance_settings WHERE key = ANY($1)",
                &[&vec![PROVIDER, MODEL, URL, VERSION]],
            )
            .await?;
        cx.commit().await.map_err(|_| anyhow::anyhow!("Database unavailable"))?;
        let mut stored = Stored::default();
        for row in rows {
            let value = row.get::<_, Value>(1).as_str().map(str::to_owned);
            match row.get::<_, String>(0).as_str() {
                PROVIDER => stored.provider = value,
                MODEL => stored.model = value,
                URL => stored.url = value,
                VERSION => stored.version = value,
                _ => {}
            }
        }
        Ok(stored)
    }

    fn credential(&self) -> Result<Option<Secret>> {
        let Ok(text) = std::fs::read_to_string(&self.file) else {
            return Ok(None);
        };
        let fields = self
            .cipher
            .open(&serde_json::from_str(&text)?)
            .map_err(|_| anyhow::anyhow!("The embedding credential cannot be read"))?;
        Ok(fields
            .get("apiKey")
            .map(|k| Secret::new(k.expose_secret().to_owned())))
    }

    fn save_credential(&self, key: Option<&str>) -> Result<()> {
        let Some(key) = key else {
            return match std::fs::remove_file(&self.file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            };
        };
        let sealed = self
            .cipher
            .seal(&SecretFields::new().with("apiKey", Secret::new(key.to_owned())));
        let temporary = self.file.with_extension("tmp");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(sealed.to_string().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(temporary, &self.file)?;
        Ok(())
    }
}

#[derive(Default)]
struct Stored {
    provider: Option<String>,
    model: Option<String>,
    url: Option<String>,
    version: Option<String>,
}

/// Reads the endpoint the owner set in the app, and falls back to the server's modules file
/// when none is set there.
pub struct SettingsEmbeddings {
    pub settings: Arc<EmbeddingConfig>,
    pub fallback: Option<moss_module_host::ai::FixedEmbeddings>,
}

#[async_trait]
impl EmbeddingStore for SettingsEmbeddings {
    async fn for_actor(&self, actor: Actor) -> Result<EmbeddingEndpoint> {
        let stored = self
            .settings
            .read(&AccessContext::new(actor.user_id(), "module-embedding"))
            .await
            .map_err(|_| anyhow::anyhow!(NOT_SET_UP))?;
        let url = match (stored.provider.as_deref(), stored.url) {
            (Some(ENDPOINT), Some(url)) => url,
            _ => {
                return match &self.fallback {
                    Some(fixed) => fixed.for_actor(actor).await,
                    None => anyhow::bail!(NOT_SET_UP),
                }
            }
        };
        Ok(EmbeddingEndpoint {
            url: url.parse().map_err(|_| anyhow::anyhow!(NOT_SET_UP))?,
            model: stored
                .model
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_owned()),
            version: stored.version.filter(|v| !v.is_empty()),
            credential: self
                .settings
                .credential()?
                .unwrap_or_else(|| Secret::new(String::new())),
        })
    }
}

/// Writes one model activity row per embedding call. The row holds the model name, a fixed
/// action word and the outcome, never any text.
pub struct ActivityRows {
    pub database: Database,
}

#[async_trait]
impl EmbeddingActivity for ActivityRows {
    async fn record(&self, call: EmbeddingCall) {
        let write = async {
            let cx = DataContext::open(
                &self.database,
                &AccessContext::new(call.actor, "embedding-activity"),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Database unavailable"))?;
            cx.db()
                .execute(
                    "INSERT INTO app.moss_model_activity_log (kind, action, outcome, model_name, result) \
                     VALUES ('embedding', $1, $2, $3, $4)",
                    &[
                        &call.action,
                        &call.outcome,
                        &call.model.chars().take(200).collect::<String>(),
                        &call.result.chars().take(500).collect::<String>(),
                    ],
                )
                .await?;
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Database unavailable"))?;
            anyhow::Ok(())
        };
        let _ = write.await;
    }
}

fn say(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn require_admin(settings: &EmbeddingConfig, access: &AccessContext) -> Result<(), Response> {
    let refuse = || say(StatusCode::FORBIDDEN, "Only the instance owner can set up embeddings");
    let cx = DataContext::open(&settings.database, access)
        .await
        .map_err(|_| refuse())?;
    let row = cx
        .db()
        .query_opt(
            "SELECT is_instance_admin FROM app.get_user_by_id($1::uuid)",
            &[&access.actor_user_id()],
        )
        .await
        .map_err(|_| refuse())?;
    match row {
        Some(row) if row.get::<_, bool>(0) => Ok(()),
        _ => Err(refuse()),
    }
}

pub fn routes(settings: Arc<EmbeddingConfig>) -> Router {
    Router::new()
        .route(
            "/api/m/memory/embedding",
            get(show).put(save),
        )
        .with_state(settings)
}

async fn show(
    State(settings): State<Arc<EmbeddingConfig>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    if let Err(refused) = require_admin(&settings, &access).await {
        return refused;
    }
    let Ok(stored) = settings.read(&access).await else {
        return say(StatusCode::SERVICE_UNAVAILABLE, "Embedding settings are unavailable");
    };
    let set = stored.provider.as_deref() == Some(ENDPOINT) && stored.url.is_some();
    Json(json!({
        "set": set,
        "url": stored.url.filter(|_| set),
        "model": stored.model.filter(|_| set),
        "version": stored.version.filter(|_| set),
        "hasCredential": settings.file.is_file(),
        "defaultModel": DEFAULT_EMBEDDING_MODEL,
        "onDevice": "not available yet",
        "message": if set { Value::Null } else { json!(NOT_SET_UP) },
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    /// Empty or absent turns embeddings off again.
    url: Option<String>,
    model: Option<String>,
    version: Option<String>,
    /// Absent keeps the saved credential. An empty string removes it.
    api_key: Option<String>,
    /// Must be true, because the text of memory leaves the device when an endpoint is used.
    #[serde(default)]
    confirm_off_device: bool,
}

fn plain(value: &Option<String>, limit: usize) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= limit && !v.chars().any(char::is_control))
        .map(str::to_owned)
}

async fn save(
    State(settings): State<Arc<EmbeddingConfig>>,
    Extension(access): Extension<AccessContext>,
    Json(input): Json<Save>,
) -> Response {
    if let Err(refused) = require_admin(&settings, &access).await {
        return refused;
    }
    let url = plain(&input.url, 2048);
    if let Some(url) = &url {
        if !valid_endpoint_url(url) {
            return say(StatusCode::BAD_REQUEST, "Enter a web address that starts with http or https");
        }
        if !input.confirm_off_device {
            return say(
                StatusCode::BAD_REQUEST,
                "Confirm that memory text will be sent to this address before saving",
            );
        }
    } else if input.url.as_deref().is_some_and(|u| !u.trim().is_empty()) {
        return say(StatusCode::BAD_REQUEST, "Enter a web address that starts with http or https");
    }
    let model = plain(&input.model, 200);
    let version = plain(&input.version, 64);
    if (input.model.as_deref().is_some_and(|m| !m.trim().is_empty()) && model.is_none())
        || (input.version.as_deref().is_some_and(|m| !m.trim().is_empty()) && version.is_none())
    {
        return say(StatusCode::BAD_REQUEST, "The model name or version is not valid");
    }
    let key = input.api_key.as_deref().map(str::trim);
    if key.is_some_and(|k| k.len() > 4096 || k.chars().any(char::is_control)) {
        return say(StatusCode::BAD_REQUEST, "The credential is not valid");
    }
    let result: Result<()> = async {
        match (key, &url) {
            (_, None) | (Some(""), _) => settings.save_credential(None)?,
            (Some(k), _) => settings.save_credential(Some(k))?,
            (None, _) => {}
        }
        let cx = DataContext::open(&settings.database, &access)
            .await
            .map_err(|_| anyhow::anyhow!("Database unavailable"))?;
        let values: [(&str, Option<String>); 4] = [
            (PROVIDER, url.as_ref().map(|_| ENDPOINT.to_owned())),
            (MODEL, url.as_ref().and(model)),
            (URL, url.clone()),
            (VERSION, url.as_ref().and(version)),
        ];
        for (key, value) in values {
            let key: &str = key;
            match value {
                Some(value) => cx
                    .db()
                    .execute(
                        "INSERT INTO app.instance_settings (key, value, updated_by_user_id) \
                         VALUES ($1, to_jsonb($2::text), $3) \
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, \
                           updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()",
                        &[&key, &value, &access.actor_user_id()],
                    )
                    .await?,
                None => cx
                    .db()
                    .execute("DELETE FROM app.instance_settings WHERE key = $1", &[&key])
                    .await?,
            };
        }
        cx.commit().await.map_err(|_| anyhow::anyhow!("Database unavailable"))?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => show(State(settings), Extension(access)).await,
        Err(_) => say(StatusCode::SERVICE_UNAVAILABLE, "The embedding settings could not be saved"),
    }
}
