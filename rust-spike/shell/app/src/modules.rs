//! Explicit assembly for an existing approved module catalog. Installation/bootstrap
//! still owns schema creation; the serving process never runs bootstrap SQL.
use crate::module_embedding::{ActivityRows, EmbeddingConfig, SettingsEmbeddings};
use anyhow::Result;
use moss_calendar_host::CalendarPorts;
use moss_backtrack_host::BacktrackPorts;
use moss_meetings_host::MeetingsPorts;
use moss_connectors_host::ConnectorsPorts;
use moss_email_host::EmailPorts;
use moss_memory_host::ports::MemoryPorts;
use axum::{
    body::Bytes,
    extract::{Path as UrlPath, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
    routing::{any, get},
    Extension, Json, Router,
};
use moss_module_host::{
    account_preferences::{weather_bindings, AccountPreferencesPorts, Binding, JsonShape},
    ai::{
        EmbeddingsOnly, FixedEmbeddings, Intelligence, IntelligenceEmbeddings,
        DEFAULT_EMBEDDING_MODEL,
    },
    application::{Application, Configuration},
    folder_settings::{FolderSetting, FolderSettingsPorts},
    frame::AssetPolicy,
    linked_notes::{LinkedNotesPorts, PreferenceFolder, PreferenceFolders},
    memory_cleanup::{MemoryCleanupPorts, MemoryCleanupSource},
    memory_ingest::{MemoryIngestPorts, MemoryIngestSource},
    memory_search::MemorySearchPorts,
    memory_vault::MemoryVaultPorts,
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
    /// Opens stored AI provider credentials. Absent means module AI fails closed.
    #[serde(default)]
    pub(crate) ai_key: Option<String>,
    #[serde(default)]
    pub(crate) fuel_ceiling: Option<u64>,
    /// Base folder for per-account notes roots (`<base>/<account id>`). Needed by People.
    #[serde(default)]
    pub(crate) notes_base: Option<PathBuf>,
    /// Base folder for per-account private areas (`<base>/<account id>`). Defaults to
    /// `<data>/private-notes`; it must stay outside every linked notes folder.
    #[serde(default)]
    pub(crate) private_base: Option<PathBuf>,
    /// One OpenAI-style embeddings endpoint for every account. Absent means embeddings fail closed.
    #[serde(default)]
    pub(crate) embeddings: Option<EmbeddingSettings>,
    /// TEST ONLY. An http loopback address that stands in for Google's token endpoint.
    /// Never set in a real install; anything but http on this machine is refused at start.
    #[serde(default)]
    pub(crate) test_only_google_token_url: Option<String>,
    /// TEST ONLY. Stand-in IMAP and SMTP servers on this machine for the mail login test.
    /// Never set in a real install.
    #[serde(default)]
    pub(crate) test_only_mail: Option<TestOnlyMail>,
    /// The helper browser for one person's Outlook calendar. Absent means no Outlook calendar
    /// reader. The address must be plain http on this machine.
    #[serde(default)]
    pub(crate) outlook_browser: Option<OutlookBrowser>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutlookBrowser {
    endpoint: String,
    /// The one person this helper belongs to.
    owner: uuid::Uuid,
    /// The Outlook account address the helper must show.
    account: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestOnlyMail {
    imap_port: u16,
    #[serde(default)]
    imap_tls: bool,
    smtp_port: u16,
    smtp_security: String,
    /// The one certificate the login test trusts. Absent trusts nothing.
    #[serde(default)]
    trusted_certificate: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddingSettings {
    url: String,
    model: String,
    #[serde(default)]
    api_key: String,
}

// Used when the instance has no AI key. Calls fail closed.
struct UnconfiguredIntelligence;
impl Intelligence for UnconfiguredIntelligence {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Module AI is not configured on this server")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Module embeddings are not configured on this server")
    }
}

/// Notes indexing and search over the account's folder, using the configured embeddings.
fn memory(
    database: Database,
    base: PathBuf,
    private_base: PathBuf,
    embeddings: Arc<IntelligenceEmbeddings>,
    next: Arc<dyn Ports>,
) -> Result<Arc<dyn Ports>> {
    let key = ("notes".to_string(), "source".to_string());
    let cleanup = Arc::new(
        MemoryCleanupPorts::new(
            database.clone(),
            BTreeMap::from([(
                key.clone(),
                MemoryCleanupSource {
                    source_kind: "notes".into(),
                    preference_key: "notes-source-path".into(),
                    roots: BTreeMap::new(),
                },
            )]),
            next,
        )?
        .with_account_base(base.clone()),
    );
    let ingest = Arc::new(
        MemoryIngestPorts::new(
            database.clone(),
            embeddings.clone(),
            BTreeMap::from([(
                key.clone(),
                MemoryIngestSource {
                    source_kind: "notes".into(),
                    preference_key: "notes-source-path".into(),
                    roots: BTreeMap::new(),
                },
            )]),
            cleanup,
        )?
        .with_account_base(base),
    );
    let search = Arc::new(MemorySearchPorts::new(
        database.clone(),
        embeddings.clone(),
        BTreeMap::from([(key, "notes".into())]),
        ingest,
    )?);
    // The Memory module indexes the account's private note copies and its people notes folder.
    Ok(Arc::new(MemoryVaultPorts::new(
        database,
        embeddings,
        ("memory".into(), "vault-index".into()),
        private_base,
        vec!["notes/generated".into()],
        vec!["people-notes-folder".into()],
        search,
    )?))
}

// Text generation goes through the router; embeddings use the fixed endpoint when one is set.
struct SplitIntelligence {
    generator: Arc<dyn Intelligence>,
    embedder: Option<Arc<dyn Intelligence>>,
}
impl Intelligence for SplitIntelligence {
    fn generate(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        self.generator.generate(scope, request)
    }
    fn embed(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        match &self.embedder {
            Some(embedder) => embedder.embed(scope, request),
            None => self.generator.embed(scope, request),
        }
    }
    fn embedding_model(&self, scope: &CallScope) -> Result<(String, String)> {
        match &self.embedder {
            Some(embedder) => embedder.embedding_model(scope),
            None => self.generator.embedding_model(scope),
        }
    }
}

/// Sports keeps its standings choices, and Weather its place and unit, in fixed account
/// preference keys. Weather's keys are the ones the old Settings routes wrote.
fn module_preferences(database: Database, next: Arc<dyn Ports>) -> Result<Arc<dyn Ports>> {
    let mut bindings = weather_bindings();
    bindings.extend([
            (
                ("sports".into(), "standings-competitions".into()),
                Binding::Json {
                    key: "sports.standings_competition_keys".into(),
                    shape: JsonShape::TextList { max_items: 64, max_len: 200 },
                },
            ),
            (
                ("sports".into(), "standings-last-viewed".into()),
                Binding::Json {
                    key: "sports.standings_last_viewed".into(),
                    shape: JsonShape::LastViewed,
                },
            ),
        ]);
    Ok(Arc::new(AccountPreferencesPorts::new(database, bindings, next)?))
}

/// Account preference and linked-notes ports for People. Keys, resources and roots are
/// fixed here, never chosen by the guest.
fn linked_notes(
    database: Database,
    base: PathBuf,
    private_base: PathBuf,
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
    .with_account_base(base.clone())
    .with_private_export("notes", "private-export", private_base);
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
    let connectors_key = settings.connector_key.clone();
    let connectors_worker_url = settings.worker_url.clone();
    let google_test_url = settings.test_only_google_token_url.clone();
    let mail_test = settings.test_only_mail;
    let outlook = settings
        .outlook_browser
        .as_ref()
        .map(|o| {
            moss_connectors_host::outlook_scan::OutlookBinding::new(&o.endpoint, o.owner, &o.account)
                .ok_or_else(|| anyhow::anyhow!("outlook_browser needs a plain http address on this machine and an account"))
        })
        .transpose()?;
    let cipher = SecretCipher::connectors(
        &[("JARVIS_CONNECTOR_SECRET_KEY".into(), settings.connector_key)].into(),
    )
    .map_err(|_| anyhow::anyhow!("Invalid module connector key"))?;
    let notes_base = settings.notes_base.clone();
    let private_base = settings
        .private_base
        .clone()
        .unwrap_or_else(|| settings.data.join("private-notes"));
    anyhow::ensure!(
        private_base.is_absolute(),
        "Private notes base needs an absolute path"
    );
    // Private copies must never sit inside, or contain, any linked notes folder.
    if let Some(base) = &notes_base {
        anyhow::ensure!(
            !private_base.starts_with(base) && !base.starts_with(&private_base),
            "Private notes base must be separate from the notes base"
        );
    }
    if let Some(base) = &notes_base {
        anyhow::ensure!(base.is_absolute(), "Notes base needs an absolute path");
    }
    let preferences_database = database.clone();
    let preferences_database_sports = database.clone();
    let calendar_database = database.clone();
    let connectors_database = database.clone();
    let meetings_database = database.clone();
    let backtrack_database = database.clone();
    let email_database = database.clone();
    let generator: Arc<dyn Intelligence> = match &settings.ai_key {
        Some(key) => crate::module_ai::intelligence(
            database.clone(),
            SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), key.clone())].into())
                .map_err(|_| anyhow::anyhow!("Invalid module AI key"))?,
        )?,
        None => Arc::new(UnconfiguredIntelligence),
    };
    // The endpoint the owner sets in the app wins. The modules file is the fallback.
    let fallback = match settings.embeddings {
        Some(e) => Some(FixedEmbeddings::new(
            e.url
                .parse()
                .map_err(|_| anyhow::anyhow!("Invalid embeddings url"))?,
            e.model,
            e.api_key,
        )),
        None => None,
    };
    let embedder: Option<Arc<dyn Intelligence>> = Some(Arc::new(
        EmbeddingsOnly::new(SettingsEmbeddings {
            settings: Arc::new(EmbeddingConfig::new(
                database.clone(),
                &connectors_key,
                &settings.data,
                fallback.is_some(),
            )?),
            fallback,
        })?
        .with_activity(Arc::new(ActivityRows {
            database: database.clone(),
        })),
    ));
    let intelligence: Arc<dyn Intelligence> = Arc::new(SplitIntelligence {
        generator,
        embedder,
    });
    let notes_intelligence = intelligence.clone();
    let memory_embeddings = Arc::new(IntelligenceEmbeddings::new(
        intelligence.clone(),
        DEFAULT_EMBEDDING_MODEL.into(),
    ));
    let memory_database = email_database.clone();
    let application = Application::open_extended_with(
        &settings.data,
        database,
        AccessContext::new(admin_user_id, "server-module-catalog"),
        Configuration {
            migrations: Secret::new(settings.migrations_url),
            producer: Secret::new(settings.producer_url),
            cipher: Arc::new(cipher),
            intelligence,
            version: "0.1.0".parse()?,
            compiled_cache: None,
            fuel_ceiling: Some(settings.fuel_ceiling.unwrap_or(DEFAULT_FUEL_CEILING)),
        },
        |services| {
            let services = match notes_base {
            Some(base) => {
                let services = memory(
                    preferences_database.clone(),
                    base.clone(),
                    private_base.clone(),
                    Arc::new(IntelligenceEmbeddings::new(
                        notes_intelligence,
                        DEFAULT_EMBEDDING_MODEL.into(),
                    )),
                    services,
                )?;
                linked_notes(preferences_database, base, private_base, services)
            }
            None => {
                // Private export needs no linked notes folder.
                let folders = PreferenceFolders::new(
                    preferences_database,
                    BTreeMap::new(),
                    BTreeMap::new(),
                )?
                .with_private_export("notes", "private-export", private_base);
                Ok(Arc::new(LinkedNotesPorts::new(Arc::new(folders), services)) as Arc<dyn Ports>)
            }
            }?;
            let services = module_preferences(preferences_database_sports, services)?;
            // Meetings answers only its own capture-preference calls, as the signed-in person.
            let authority_database = meetings_database.clone();
            let services = Arc::new(
                MeetingsPorts::new(meetings_database, services)?
                    .with_recordings(&settings.data.join("modules/files"))?,
            ) as Arc<dyn Ports>;
            // Backtrack answers only its own screen-text calls, as the signed-in person. Mac uploads
            // are refused until the device link check is supplied.
            let services = Arc::new(BacktrackPorts::new(backtrack_database, services)?) as Arc<dyn Ports>;
            // Calendar keeps its settings in the account's real preferences and reads the
            // account timezone. The wrapper only answers calls made by the Calendar module.
            let services = Arc::new(CalendarPorts::new(calendar_database, services)?) as Arc<dyn Ports>;
            // Connectors answers only its own account calls and seals secrets with the
            // connector key. Every other call passes through.
            let mut connectors = ConnectorsPorts::new(connectors_database, services, &connectors_key)?
                .with_worker_url(&connectors_worker_url)?;
            if let Some(url) = &google_test_url {
                eprintln!("WARNING: test_only_google_token_url is set. Google sign-in talks to {url}, not Google.");
                connectors = connectors.with_google(moss_connectors_host::google::GoogleConfig::test_only_loopback(url)?);
            }
            if let Some(mail) = &mail_test {
                // Release builds never send mail logins to a stand-in server.
                anyhow::ensure!(
                    cfg!(debug_assertions),
                    "test_only_mail is only allowed in a debug build"
                );
                eprintln!("WARNING: test_only_mail is set. Mail sign-in talks to stand-in servers on this machine, not to a provider.");
                let pem = mail.trusted_certificate.as_ref().map(std::fs::read_to_string).transpose()?;
                connectors = connectors.with_mail(moss_connectors_host::imap::MailConfig::test_only_ports(
                    mail.imap_port,
                    mail.imap_tls,
                    mail.smtp_port,
                    &mail.smtp_security,
                    pem.as_deref(),
                )?);
            }
            connectors = connectors.with_outlook(outlook.clone());
            let services = Arc::new(connectors) as Arc<dyn Ports>;
            // Email answers only its own cached-message and preference calls.
            let services = Arc::new(EmailPorts::new(email_database, services)?) as Arc<dyn Ports>;
            // Memory answers only its own graph calls, as the signed-in person.
            Ok(Arc::new(
                MemoryPorts::new(memory_database, memory_embeddings, services)?
                    .with_authority(Arc::new(moss_meetings_host::authority::MeetingsAuthority::new(authority_database))),
            ) as Arc<dyn Ports>)
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
        .route("/api/me/weather-location", any(dispatch))
        .route("/api/me/weather-location/{leaf}", any(dispatch))
        .route("/api/me/weather-unit", any(dispatch))
        .route("/api/modules/navigation", get(navigation))
        .route("/api/modules/{module}/screen", get(screen))
        .route("/module-ui/{module}/{digest}/{*path}", get(ui_asset))
        .route(
            "/module-frame",
            get(|| async {
                // Only the app page may frame this one; the page frames its sandboxed screen.
                (
                    [(
                        header::CONTENT_SECURITY_POLICY,
                        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'",
                    )],
                    Html(include_str!("../../assets/module-frame.html")),
                )
            }),
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

/// Navigation entries from installed modules for the signed-in account.
async fn navigation(
    State(api): State<Arc<Api>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    let Some(application) = host(&api.slot) else {
        return Json(serde_json::json!({ "links": [] })).into_response();
    };
    match tokio::task::spawn_blocking(move || application.installer.navigation(&access)).await {
        Ok(Ok(links)) => Json(serde_json::json!({ "links": links })).into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
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
    peer: Option<Extension<axum::extract::ConnectInfo<std::net::SocketAddr>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // The directly connected address only. Forwarding headers are never trusted.
    let client = peer.map(|Extension(axum::extract::ConnectInfo(addr))| addr.ip());
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
    // A binary body never enters the module. It is staged under a fresh request id and the route
    // receives only its size and hash.
    let binary = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/octet-stream"));
    let (access, staged, body) = if binary {
        let id = format!("{}{}", moss_module_host::staged::PREFIX, uuid::Uuid::new_v4());
        let (guard, json) = moss_module_host::staged::stage_body(&id, body.to_vec());
        (AccessContext::new(access.actor_user_id(), id), Some(guard), json)
    } else {
        let Ok(text) = std::str::from_utf8(&body) else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        (access, None, if text.is_empty() { "null" } else { text }.to_owned())
    };
    let target = alias(
        uri.path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/"),
    );
    match tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let _staged = staged;
        application.dispatch_extended_from(access, method.as_str(), &target, &body, client)
    })
    .await
    {
        Ok(Ok(output)) => module_response(&output),
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}

/// Old Settings paths for the weather place and unit, served by the Weather package for the
/// support window. Every other path passes through unchanged.
fn alias(target: &str) -> String {
    for (old, new) in [
        ("/api/me/weather-location", "/api/m/weather/location"),
        ("/api/me/weather-unit", "/api/m/weather/unit"),
    ] {
        if let Some(rest) = target.strip_prefix(old) {
            if rest.is_empty() || rest.starts_with(['/', '?']) {
                return format!("{new}{rest}");
            }
        }
    }
    target.to_owned()
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
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            reply.body.to_string(),
        )
            .into_response(),
        _ => StatusCode::BAD_GATEWAY.into_response(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn old_weather_paths_reach_the_weather_package() {
        for (old, new) in [
            ("/api/me/weather-location", "/api/m/weather/location"),
            ("/api/me/weather-location/search?query=a", "/api/m/weather/location/search?query=a"),
            ("/api/me/weather-location/reverse?lat=1&lon=2", "/api/m/weather/location/reverse?lat=1&lon=2"),
            ("/api/me/weather-unit", "/api/m/weather/unit"),
            ("/api/me/weather-unitx", "/api/me/weather-unitx"),
            ("/api/m/news/feed", "/api/m/news/feed"),
        ] {
            assert_eq!(super::alias(old), new);
        }
    }
    use super::*;

    #[test]
    fn guest_status_is_preserved_and_invalid_envelopes_fail_closed() {
        assert_eq!(
            module_response(r#"{"status":409,"body":{"error":"conflict"}}"#).status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            module_response(r#"{"status":200,"body":{}}"#).headers()[header::CACHE_CONTROL],
            "no-store"
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
