//! Explicit assembly for an existing approved module catalog. Installation/bootstrap
//! still owns schema creation; the serving process never runs bootstrap SQL.
use anyhow::Result;
use axum::{
    body::Bytes,
    extract::State,
    http::{header, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Extension, Router,
};
use moss_module_host::{
    ai::Intelligence,
    application::{Application, Configuration},
    account_preferences::{AccountPreferencesPorts, Binding},
    folder_settings::{FolderSetting, FolderSettingsPorts},
    linked_notes::{LinkedNotesPorts, PreferenceFolder, PreferenceFolders},
    runtime::{CallScope, Ports, Request},
    worker::Worker,
};
use safety_core::{
    access::AccessContext,
    db::Database,
    secret::{Secret, SecretCipher},
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

/// Largest per-invocation fuel a module manifest may request on this server.
const DEFAULT_FUEL_CEILING: u64 = 250_000_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    data: PathBuf,
    admin_user_id: uuid::Uuid,
    migrations_url: String,
    producer_url: String,
    worker_url: String,
    connector_key: String,
    #[serde(default)]
    fuel_ceiling: Option<u64>,
    /// Base folder for per-account notes roots (`<base>/<account id>`). Needed by People.
    #[serde(default)]
    notes_base: Option<PathBuf>,
}

// AI configuration is not assembled by this checkpoint. Calls fail closed.
struct UnconfiguredIntelligence;
impl Intelligence for UnconfiguredIntelligence {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Module AI is not configured on this server")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Module embeddings are not configured on this server")
    }
}

/// Account preference and linked-notes ports for People. Keys, resources and roots are
/// fixed here, never chosen by the guest.
fn linked_notes(
    database: Database,
    base: PathBuf,
    next: Arc<dyn Ports>,
) -> Result<Arc<dyn Ports>> {
    let preferences = AccountPreferencesPorts::new(
        database.clone(),
        BTreeMap::from([
            (
                ("people".into(), "people-folder".into()),
                Binding::Folder {
                    key: "people-notes-folder".into(),
                    roots: BTreeMap::new(),
                },
            ),
            (
                ("people".into(), "people-suggestions".into()),
                Binding::BooleanOverride {
                    key: "sourceBehaviors".into(),
                    entry: "people.notes.suggest-updates".into(),
                    default: true,
                },
            ),
        ]),
        next,
    )?
    .with_account_base(base.clone());
    let folders = PreferenceFolders::new(
        database.clone(),
        BTreeMap::from([
            (
                ("people".into(), "people-notes".into()),
                PreferenceFolder {
                    preference: "people-notes-folder".into(),
                    relative_to: Some("notes-source-path".into()),
                },
            ),
            (
                ("notes".into(), "source".into()),
                PreferenceFolder {
                    preference: "notes-source-path".into(),
                    relative_to: None,
                },
            ),
        ]),
        BTreeMap::new(),
    )?
    .with_account_base(base.clone());
    let linked: Arc<dyn Ports> = Arc::new(LinkedNotesPorts::new(
        Arc::new(folders),
        Arc::new(preferences),
    ));
    // Notes folder browse, link and status. The setting keys are fixed here.
    Ok(Arc::new(
        FolderSettingsPorts::new(
            database,
            BTreeMap::from([(
                ("notes".into(), "source".into()),
                FolderSetting {
                    path_key: "notes-source-path".into(),
                    status_key: "notes-last-sync".into(),
                    roots: BTreeMap::new(),
                },
            )]),
            linked,
        )?
        .with_account_base(base),
    ))
}

pub struct ServerModules {
    // Stop/join before dropping the application and its blocking runtimes.
    _worker: Worker,
    pub application: Arc<Application>,
}

pub fn open(path: &Path, database: Database) -> Result<ServerModules> {
    let settings: Settings = serde_json::from_slice(
        &moss_network::config::private_read(path).map_err(anyhow::Error::msg)?,
    )?;
    anyhow::ensure!(
        settings.data.is_absolute(),
        "Module data needs an absolute path"
    );
    anyhow::ensure!(
        !settings.connector_key.is_empty(),
        "Module connector key is required"
    );
    let cipher = SecretCipher::connectors(
        &[("JARVIS_CONNECTOR_SECRET_KEY".into(), settings.connector_key)].into(),
    )
    .map_err(|_| anyhow::anyhow!("Invalid module connector key"))?;
    let notes_base = settings.notes_base.clone();
    if let Some(base) = &notes_base {
        anyhow::ensure!(base.is_absolute(), "Notes base needs an absolute path");
    }
    let preferences_database = database.clone();
    let application = Arc::new(Application::open_extended_with(
        &settings.data,
        database,
        AccessContext::new(settings.admin_user_id, "server-module-catalog"),
        Configuration {
            migrations: Secret::new(settings.migrations_url),
            producer: Secret::new(settings.producer_url),
            cipher: Arc::new(cipher),
            intelligence: Arc::new(UnconfiguredIntelligence),
            version: "0.1.0".parse()?,
            compiled_cache: None,
            fuel_ceiling: Some(settings.fuel_ceiling.unwrap_or(DEFAULT_FUEL_CEILING)),
        },
        |services| match notes_base {
            Some(base) => linked_notes(preferences_database, base, services),
            None => Ok(services),
        },
    )?);
    let worker = Worker::start(
        application.installer.clone(),
        Secret::new(settings.worker_url),
    )?;
    Ok(ServerModules {
        _worker: worker,
        application,
    })
}

pub fn routes(application: Arc<Application>) -> Router {
    Router::new()
        .route("/api/m/{module}/{*path}", any(dispatch))
        .with_state(Arc::new(Api {
            application,
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
        }))
}

struct Api {
    application: Arc<Application>,
    slots: Arc<tokio::sync::Semaphore>,
}

async fn dispatch(
    State(api): State<Arc<Api>>,
    Extension(access): Extension<AccessContext>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> Response {
    let Ok(slot) = api.slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let Ok(body) = std::str::from_utf8(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let body = if body.is_empty() { "null" } else { body }.to_owned();
    let target = uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_owned();
    match tokio::task::spawn_blocking(move || {
        let _slot = slot;
        api.application
            .dispatch_extended(access, method.as_str(), &target, &body)
    })
    .await
    {
        Ok(Ok(output)) => module_response(&output),
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}

fn module_response(output: &str) -> Response {
    #[derive(Deserialize)]
    struct Reply {
        status: u16,
        body: Value,
    }
    match serde_json::from_str::<Reply>(output) {
        Ok(reply) if (200..600).contains(&reply.status) => (
            StatusCode::from_u16(reply.status).unwrap(),
            [(header::CONTENT_TYPE, "application/json")],
            reply.body.to_string(),
        )
            .into_response(),
        _ => StatusCode::BAD_GATEWAY.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_status_is_preserved_and_invalid_envelopes_fail_closed() {
        assert_eq!(
            module_response(r#"{"status":409,"body":{"error":"conflict"}}"#).status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            module_response(r#"{"posted":true}"#).status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            module_response(r#"{"status":101,"body":null}"#).status(),
            StatusCode::BAD_GATEWAY
        );
    }
}
