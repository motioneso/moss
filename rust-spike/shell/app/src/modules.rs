//! Explicit assembly for an existing approved module catalog. Installation/bootstrap
//! still owns schema creation; the serving process never runs bootstrap SQL.
use anyhow::Result;
use axum::{
    body::Bytes,
    extract::{Path as UrlPath, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
    routing::{any, get},
    Extension, Json, Router,
};
use moss_module_host::{
    account_preferences::{AccountPreferencesPorts, Binding},
    ai::Intelligence,
    application::{Application, Configuration},
    folder_settings::{FolderSetting, FolderSettingsPorts},
    frame::AssetPolicy,
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
pub struct Settings {
    pub(crate) data: PathBuf,
    /// Absent until the module installer records the instance owner.
    #[serde(default)]
    pub(crate) admin_user_id: Option<uuid::Uuid>,
    pub(crate) migrations_url: String,
    pub(crate) producer_url: String,
    pub(crate) worker_url: String,
    pub(crate) connector_key: String,
    #[serde(default)]
    pub(crate) fuel_ceiling: Option<u64>,
    /// Base folder for per-account notes roots (`<base>/<account id>`). Needed by People.
    #[serde(default)]
    pub(crate) notes_base: Option<PathBuf>,
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
fn linked_notes(database: Database, base: PathBuf, next: Arc<dyn Ports>) -> Result<Arc<dyn Ports>> {
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

pub fn read_settings(path: &Path) -> Result<Settings> {
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
    Ok(settings)
}

/// Opens the serving host and its worker. Fails until the installer has recorded an owner.
pub fn open(path: &Path, database: Database) -> Result<ServerModules> {
    let settings = read_settings(path)?;
    let worker_url = settings.worker_url.clone();
    let application = Arc::new(application(settings, database)?);
    let worker = Worker::start(application.installer.clone(), Secret::new(worker_url))?;
    Ok(ServerModules {
        _worker: worker,
        application,
    })
}

/// The module application without a worker, for the installer.
pub fn application(settings: Settings, database: Database) -> Result<Application> {
    let admin_user_id = settings
        .admin_user_id
        .ok_or_else(|| anyhow::anyhow!("No module has been installed yet"))?;
    let cipher = SecretCipher::connectors(
        &[("JARVIS_CONNECTOR_SECRET_KEY".into(), settings.connector_key)].into(),
    )
    .map_err(|_| anyhow::anyhow!("Invalid module connector key"))?;
    let notes_base = settings.notes_base.clone();
    if let Some(base) = &notes_base {
        anyhow::ensure!(base.is_absolute(), "Notes base needs an absolute path");
    }
    let preferences_database = database.clone();
    let application = Application::open_extended_with(
        &settings.data,
        database,
        AccessContext::new(admin_user_id, "server-module-catalog"),
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
    )?;
    Ok(application)
}

/// The host once it is running. Empty until the installer has put a module in.
pub type Slot = Arc<std::sync::Mutex<Option<ServerModules>>>;

/// Module routes. `web` is the shell's web folder; shared screen styles and fonts come from
/// its `module-shared` folder.
pub fn routes(slot: Slot, web: PathBuf) -> Router {
    Router::new()
        .route("/api/m/{module}/{*path}", any(dispatch))
        .route("/api/modules/{module}/screen", get(screen))
        .route("/module-ui/{module}/{digest}/{*path}", get(ui_asset))
        .route(
            "/module-frame",
            get(|| async { Html(include_str!("../../assets/module-frame.html")) }),
        )
        .route(
            "/module-frame.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css")],
                    include_str!("../../assets/module-frame.css"),
                )
            }),
        )
        .route(
            "/module-frame.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript")],
                    include_str!("../../assets/module-frame.js"),
                )
            }),
        )
        .route(
            "/module-shared/host-bridge.mjs",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript")],
                    include_str!("../../../module-ui/web/host-bridge.mjs"),
                )
            }),
        )
        .with_state(Arc::new(Api {
            slot,
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
            asset_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        }))
        .merge(
            // Opaque frames read these files cross-origin, so fonts need a CORS header.
            Router::new()
                .nest_service(
                    "/module-shared",
                    tower_http::services::ServeDir::new(web.join("module-shared")),
                )
                .layer(axum::middleware::map_response(
                    |mut response: Response| async move {
                        response.headers_mut().insert(
                            header::ACCESS_CONTROL_ALLOW_ORIGIN,
                            HeaderValue::from_static("*"),
                        );
                        response
                    },
                )),
        )
}

fn host(slot: &Slot) -> Option<Arc<Application>> {
    slot.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|host| host.application.clone())
}

#[derive(Deserialize)]
struct ScreenQuery {
    path: String,
}

/// The verified screen address for a signed-in account. Refused if the module is off for it.
async fn screen(
    State(api): State<Arc<Api>>,
    Extension(access): Extension<AccessContext>,
    UrlPath(module): UrlPath<String>,
    Query(query): Query<ScreenQuery>,
) -> Response {
    let Some(application) = host(&api.slot) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match tokio::task::spawn_blocking(move || {
        application.installer.screen(&access, &module, &query.path)
    })
    .await
    {
        Ok(Ok(screen)) => Json(serde_json::json!({
            "title": screen.title,
            "src": screen.src,
            "sandbox": screen.sandbox,
        }))
        .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Public static files of an installed screen. The frame is opaque and sends no cookies, so
/// no account data may be served here. The web origin is the request's own host, which the
/// network guard has already matched against the trusted origins.
async fn ui_asset(
    State(api): State<Arc<Api>>,
    UrlPath((module, digest, path)): UrlPath<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(application) = host(&api.slot) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Some(authority) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let origin = format!("https://{authority}/");
    let Ok(slot) = api.asset_slots.clone().acquire_owned().await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let policy = AssetPolicy::new(&origin)?;
        application
            .installer
            .ui_asset(&module, &digest, &path, &policy)
    })
    .await
    {
        Ok(Ok(asset)) => {
            let mut response =
                ([(header::CONTENT_TYPE, asset.content_type)], asset.body).into_response();
            for (name, value) in asset.headers {
                if let (Ok(name), Ok(value)) =
                    (HeaderName::try_from(name), HeaderValue::try_from(value))
                {
                    response.headers_mut().insert(name, value);
                }
            }
            response
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Tries to open the host every couple of seconds until it works or `stop` is set, so a module
/// installed while the server runs is served without a restart. Blocking; run it off the
/// async executor. Logs one fixed line, never the reason.
pub fn load_when_ready(
    slot: Slot,
    path: PathBuf,
    database: Database,
    stop: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering;
    let mut said = false;
    while !stop.load(Ordering::Relaxed) {
        match open(&path, database.clone()) {
            Ok(host) => {
                *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(host);
                eprintln!("moss-shell: module host is running");
                return;
            }
            Err(_) if !said => {
                said = true;
                eprintln!("moss-shell: waiting for the first module to be installed");
            }
            Err(_) => {}
        }
        for _ in 0..10 {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
}

struct Api {
    slot: Slot,
    slots: Arc<tokio::sync::Semaphore>,
    /// Bounds concurrent public file reads. Each one verifies the whole package, so waiters
    /// queue here instead of running together.
    asset_slots: Arc<tokio::sync::Semaphore>,
}

async fn dispatch(
    State(api): State<Arc<Api>>,
    Extension(access): Extension<AccessContext>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> Response {
    let Some(application) = api
        .slot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|host| host.application.clone())
    else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
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
        application.dispatch_extended(access, method.as_str(), &target, &body)
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
