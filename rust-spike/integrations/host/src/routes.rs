//! The ten connection routes, with the old handlers' status codes and messages.
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use chrono::Utc;
use moss_integrations::sortmap::{tool_sort_state, ToolSort};
use moss_platform_jobs::Queue;
use safety_core::{
    access::AccessContext,
    db::{DataContext, Database},
    error::ApiError,
    secret::{Secret, SecretCipher, SecretFields},
};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::{
    jobs::{enqueue_sort, Op},
    ports::{DiscoverRequest, Discoverer, SortModel},
    store::{self, KeptOutOutcome, NewConnection, Patch, Row, SendOutcome},
    validate::{self, bad},
    view::{self, ViewOptions},
};

const PAUSED: &str = "Integration credentials are paused until an encryption key is set up. \
Ask an admin to open Settings, Encryption keys, and press Generate.";
const NOT_FOUND: &str = "Integration not found";

pub struct Integrations {
    pub db: Database,
    pub cipher: Option<Arc<SecretCipher>>,
    pub discoverer: Arc<dyn Discoverer>,
    pub model: Arc<dyn SortModel>,
    pub queue: Option<Arc<Queue>>,
}

type Shared = State<Arc<Integrations>>;
type Reply = Result<Response, ApiError>;

pub fn router(state: Arc<Integrations>) -> Router {
    Router::new()
        .route("/api/integrations", get(list).post(create))
        .route("/api/integrations/{id}", get(read).patch(update).delete(remove))
        .route("/api/integrations/{id}/refresh", post(refresh))
        .route("/api/integrations/{id}/classifier/kept-out", put(kept_out))
        .route("/api/integrations/{id}/classifier/sort", post(sort))
        .route("/api/integrations/{id}/classifier/send-without-asking", put(send_without_asking))
        .route("/api/integrations/{id}/classifier/prepare", post(prepare))
        .with_state(state)
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn json_reply(status: u16, body: Value) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), Json(body)).into_response()
}

fn detail_of(row: &Row, model_ready: bool) -> Value {
    view::detail(row, ViewOptions { model_ready, now_ms: now_ms() })
}

fn not_found() -> ApiError {
    ApiError::http(404, NOT_FOUND)
}

impl Integrations {
    fn cipher(&self) -> Result<&SecretCipher, ApiError> {
        self.cipher.as_deref().ok_or_else(|| ApiError::http(503, PAUSED))
    }

    /// Queues a sort after the request's transaction committed. The row is already saved, so a
    /// refusal is logged with the connection id and nothing else.
    async fn queue_sort(&self, actor: Uuid, id: &str, op: Op) {
        let Some(queue) = &self.queue else { return };
        if enqueue_sort(queue, actor, id, op).await.is_err() {
            eprintln!("integrations: could not queue tool sorting for {id}");
        }
    }

    async fn queue_sort_strict(&self, actor: Uuid, id: &str, op: Op) -> Result<(), ApiError> {
        let queue = self.queue.as_ref().ok_or_else(|| ApiError::http(503, "Tool sorting is not available."))?;
        enqueue_sort(queue, actor, id, op).await.map_err(|e| ApiError::Internal(format!("queue: {e}")))
    }
}

async fn list(State(app): Shared, Extension(access): Extension<AccessContext>) -> Reply {
    let cx = DataContext::open(&app.db, &access).await?;
    let rows = store::list(cx.db()).await?;
    cx.commit().await?;
    let integrations: Vec<Value> = rows.iter().map(view::summary).collect();
    Ok(json_reply(200, json!({ "integrations": integrations })))
}

fn secret_of(body: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    match body.get("credential") {
        None => Ok(None),
        Some(value) => validate::required_string(Some(value), "credential").map(Some),
    }
}

async fn create(State(app): Shared, Extension(access): Extension<AccessContext>, bytes: Bytes) -> Reply {
    let body = validate::object(&bytes, false)?;
    let name = validate::required_string(body.get("name"), "name")?;
    let kind = validate::kind(body.get("kind"))?;
    let url = validate::http_url(body.get("url"), "url")?;
    let spec = match body.get("spec") {
        None => None,
        Some(value) => Some(validate::required_string(Some(value), "spec")?),
    };
    let secret = secret_of(&body)?;
    let placement = match body.get("credentialPlacement") {
        None => None,
        Some(value) => validate::placement(Some(value))?,
    };
    let placement = if secret.is_some() { placement } else { None };

    let found = app
        .discoverer
        .discover(&DiscoverRequest {
            kind: &kind,
            url: &url,
            secret: secret.as_deref(),
            placement: placement.as_ref(),
            spec: spec.as_deref(),
        })
        .await;
    let discovery = match found {
        Ok(found) => found,
        Err(message) => return Ok(json_reply(422, json!({ "error": message }))),
    };

    let cipher = app.cipher()?;
    let credential = secret
        .map(|text| cipher.seal(&SecretFields::new().with("secret", Secret::new(text))));
    let cx = DataContext::open(&app.db, &access).await?;
    let created = store::create(
        cx.db(),
        &NewConnection {
            name: &name,
            kind: &kind,
            url: &url,
            base_url: discovery.base_url.as_deref(),
            spec_pasted: discovery.spec_pasted,
            credential,
            placement,
        },
    )
    .await?;
    store::save_discovery(cx.db(), &created.id, Some(&discovery.tools), None).await?;
    let refreshed = store::get(cx.db(), &created.id, false).await?.unwrap_or(created);
    let detail = detail_of(&refreshed, false);
    cx.commit().await?;
    app.queue_sort(access.actor_user_id(), &refreshed.id, Op::Sort).await;
    Ok(json_reply(201, detail))
}

fn has_no_model_failure(row: &Row) -> bool {
    row.discovered_tools.iter().any(|tool| {
        matches!(
            tool_sort_state(&row.classifier_sort, tool),
            ToolSort::Failed { failure: moss_integrations::sortmap::SortFailure::NoModel, .. }
        )
    })
}

async fn read(State(app): Shared, Extension(access): Extension<AccessContext>, Path(id): Path<String>) -> Reply {
    let cx = DataContext::open(&app.db, &access).await?;
    let row = store::get(cx.db(), &id, false).await?;
    cx.commit().await?;
    let Some(row) = row else { return Ok(json_reply(404, json!({ "error": NOT_FOUND }))) };
    // A failure for want of a model never reached a provider, so a model that now exists
    // resumes it here.
    let mut model_ready = false;
    if app.queue.is_some() && has_no_model_failure(&row) {
        model_ready = app.model.select(access.actor_user_id()).await.is_some();
        if model_ready {
            app.queue_sort(access.actor_user_id(), &row.id, Op::ModelReady).await;
        }
    }
    Ok(json_reply(200, detail_of(&row, model_ready)))
}

fn build_patch(body: &Map<String, Value>, cipher: &SecretCipher) -> Result<Patch, ApiError> {
    let mut patch = Patch::default();
    if body.contains_key("name") {
        patch.name = Some(validate::required_string(body.get("name"), "name")?);
    }
    if body.contains_key("url") {
        patch.url = Some(validate::http_url(body.get("url"), "url")?);
    }
    if let Some(value) = body.get("enabled") {
        let Value::Bool(flag) = value else { return Err(bad("enabled must be a boolean")) };
        patch.enabled = Some(*flag);
    }
    if let Some(value) = body.get("credential") {
        patch.credential = Some(match value {
            Value::Null => None,
            other => {
                let text = validate::required_string(Some(other), "credential")?;
                Some(cipher.seal(&SecretFields::new().with("secret", Secret::new(text))))
            }
        });
    }
    if body.contains_key("credentialPlacement") {
        patch.placement = Some(validate::placement(body.get("credentialPlacement"))?);
    }
    for (key, slot) in [
        ("enabledGroups", &mut patch.enabled_groups),
        ("enabledTools", &mut patch.enabled_tools),
        ("mutedTools", &mut patch.muted_tools),
        ("unsuppressedTools", &mut patch.unsuppressed_tools),
    ] {
        if body.contains_key(key) {
            *slot = Some(validate::required_string_array(body.get(key), key)?);
        }
    }
    if let Some(value) = body.get("classifierEnabled") {
        let Value::Bool(flag) = value else { return Err(bad("classifierEnabled must be a boolean")) };
        patch.classifier_enabled = Some(*flag);
    }
    Ok(patch)
}

async fn update(
    State(app): Shared,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Reply {
    let body = validate::object(&bytes, false)?;
    let cx = DataContext::open(&app.db, &access).await?;
    let patch = build_patch(&body, app.cipher()?)?;
    let updated = store::update(cx.db(), &id, &patch).await?;
    cx.commit().await?;
    let Some(updated) = updated else { return Ok(json_reply(404, json!({ "error": NOT_FOUND }))) };
    if body.get("classifierEnabled") == Some(&Value::Bool(true)) {
        app.queue_sort(access.actor_user_id(), &updated.id, Op::Sort).await;
    }
    Ok(json_reply(200, detail_of(&updated, false)))
}

async fn refresh(
    State(app): Shared,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Reply {
    let body = validate::object(&bytes, true)?;
    let pasted = match body.get("spec") {
        None => None,
        Some(value) => Some(validate::required_string(Some(value), "spec")?),
    };
    let cx = DataContext::open(&app.db, &access).await?;
    let Some(row) = store::get(cx.db(), &id, false).await? else { return Err(not_found()) };
    if pasted.is_some() {
        return Ok(json_reply(422, json!({ "error": "OpenAPI connections are not available yet." })));
    }
    if row.spec_pasted && pasted.is_none() {
        return Ok(json_reply(422, json!({ "error": "Paste an updated spec to refresh." })));
    }
    let secret = if row.spec_pasted {
        None
    } else {
        let envelope = store::credential_envelope(cx.db(), &row.id).await?;
        let cipher = app.cipher()?;
        match envelope {
            None => None,
            Some(envelope) => {
                let fields = cipher.open(&envelope).map_err(|_| ApiError::Internal("credential".into()))?;
                fields.get("secret").map(|s| s.expose_secret().to_owned())
            }
        }
    };
    let found = app
        .discoverer
        .discover(&DiscoverRequest {
            kind: &row.kind,
            url: &row.url,
            secret: secret.as_deref(),
            placement: row.credential_placement.as_ref(),
            spec: pasted.as_deref(),
        })
        .await;
    match found {
        Ok(found) => store::save_discovery(cx.db(), &row.id, Some(&found.tools), None).await?,
        Err(message) => store::save_discovery(cx.db(), &row.id, None, Some(&message)).await?,
    }
    let refreshed = store::get(cx.db(), &row.id, false).await?.unwrap_or(row);
    let detail = detail_of(&refreshed, false);
    cx.commit().await?;
    app.queue_sort(access.actor_user_id(), &id, Op::Sort).await;
    Ok(json_reply(200, detail))
}

async fn remove(State(app): Shared, Extension(access): Extension<AccessContext>, Path(id): Path<String>) -> Reply {
    let cx = DataContext::open(&app.db, &access).await?;
    let deleted = store::delete(cx.db(), &id).await?;
    cx.commit().await?;
    if !deleted {
        return Ok(json_reply(404, json!({ "error": NOT_FOUND })));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn kept_out(
    State(app): Shared,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Reply {
    let (kept, names) = validate::kept_out(&validate::object(&bytes, false)?)?;
    let cx = DataContext::open(&app.db, &access).await?;
    let outcome = store::set_kept_out(cx.db(), &id, &names, kept).await?;
    cx.commit().await?;
    let row = match outcome {
        KeptOutOutcome::NotFound => return Err(not_found()),
        KeptOutOutcome::UnknownTool => return Err(bad("That tool is not on this connection.")),
        KeptOutOutcome::Saved(row) => row,
    };
    if !kept && row.classifier_enabled {
        let needs_sort = row.discovered_tools.iter().any(|tool| {
            names.contains(&tool.name) && !matches!(tool_sort_state(&row.classifier_sort, tool), ToolSort::Current { .. })
        });
        if needs_sort {
            app.queue_sort(access.actor_user_id(), &row.id, Op::Sort).await;
        }
    }
    Ok(json_reply(200, detail_of(&row, false)))
}

async fn sort(State(app): Shared, Extension(access): Extension<AccessContext>, Path(id): Path<String>) -> Reply {
    if app.queue.is_none() {
        return Err(ApiError::http(503, "Tool sorting is not available."));
    }
    let cx = DataContext::open(&app.db, &access).await?;
    let row = store::get(cx.db(), &id, false).await?;
    cx.commit().await?;
    let row = row.ok_or_else(not_found)?;
    app.queue_sort_strict(access.actor_user_id(), &row.id, Op::Retry).await?;
    Ok(json_reply(202, json!({ "status": "queued" })))
}

async fn send_without_asking(
    State(app): Shared,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Reply {
    let (allow, names) = validate::send_without_asking(&validate::object(&bytes, false)?)?;
    let cx = DataContext::open(&app.db, &access).await?;
    let outcome = store::set_send_without_asking(cx.db(), &id, &names, allow).await?;
    cx.commit().await?;
    match outcome {
        SendOutcome::NotFound => Err(not_found()),
        SendOutcome::Refused => {
            Err(ApiError::http(409, "Only a tool sorted as sending things out can send without asking."))
        }
        SendOutcome::Saved(row) => Ok(json_reply(200, detail_of(&row, false))),
    }
}

const DISCLOSURE: &str = include_str!("../disclosure.json");

async fn prepare(
    State(app): Shared,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Reply {
    let body = validate::object(&bytes, true)?;
    if body.get("force").is_some_and(|v| !v.is_boolean()) {
        return Err(bad("force must be a boolean"));
    }
    if app.queue.is_none() {
        return Err(ApiError::http(503, "Tool preparation is not available."));
    }
    let cx = DataContext::open(&app.db, &access).await?;
    let row = store::get(cx.db(), &id, false).await?;
    cx.commit().await?;
    let row = row.ok_or_else(not_found)?;
    if !row.classifier_enabled {
        return Err(ApiError::http(409, "Turn on the connection classifier before preparing its tools."));
    }
    let sort_failed = row
        .discovered_tools
        .iter()
        .any(|tool| matches!(tool_sort_state(&row.classifier_sort, tool), ToolSort::Failed { .. }));
    if sort_failed {
        app.queue_sort_strict(access.actor_user_id(), &row.id, Op::Retry).await?;
    }
    let disclosure: Value = serde_json::from_str(DISCLOSURE).unwrap_or(Value::Null);
    Ok(json_reply(
        202,
        json!({ "disclosure": disclosure, "status": "ok", "drafts": [], "reused": [], "failed": [], "remaining": 0 }),
    ))
}
