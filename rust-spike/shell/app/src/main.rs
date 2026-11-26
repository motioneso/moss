//! The Moss server. Browsers, phones and the desktop app (`moss-app`) all use this one
//! authenticated HTTPS entrypoint.
//! Supply --instance <folder> or --network <private configuration file>; see
//! rust-spike/network/README.md.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::handler::HandlerWithoutStateExt;
use axum::http::{StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use moss_network::{
    config::Config,
    instance, tls,
    web::{self, Network},
};
use moss_shell_contract::stub::StubShellData;
use moss_shell_contract::{
    ChatError, ChatThread, DecideApproval, SendMessage, ShellData, ShellView, TodayView,
};
use safety_core::access::AccessContext;
use tower_http::services::ServeDir;

mod chat_approvals;
mod chat_completed;
mod chat_tools;
mod companion;
mod companion_links;
mod companion_owner;
mod companion_startup;
mod desktop_notices;
mod integrations;
mod module_admin;
mod module_ai;
mod module_catalog_view;
mod module_embedding;
mod module_install;
mod module_install_requests;
mod module_lifecycle;
mod module_lifecycle_service;
mod module_lists;
mod module_local;
mod module_management;
mod module_operation;
mod module_package_apply;
mod module_package_import;
mod module_policy;
mod module_refresh;
mod module_registries;
mod module_sources;
mod module_trust;
mod module_updates;
mod modules;
mod proactive_feedback;
mod runner_data;

type Data = Arc<dyn ShellData>;

struct Accounts {
    platform: Arc<safety_core::http::Platform>,
    runner: Option<PathBuf>,
    modules: modules::Slot,
    /// True when the server has an instance folder the module installer can work in.
    can_install_modules: bool,
    module_admin: Option<Arc<module_admin::Admin>>,
    data: Mutex<HashMap<uuid::Uuid, Data>>,
}

impl Accounts {
    fn for_actor(&self, access: &AccessContext) -> Data {
        self.data
            .lock()
            .expect("account data lock")
            .entry(access.actor_user_id())
            .or_insert_with(|| match &self.runner {
                Some(root) => Arc::new(runner_data::RunnerShellData::new(
                    root.clone(),
                    access.actor_user_id().to_string(),
                    chat_tools::source(self.modules.clone(), access.clone()),
                )) as Data,
                None => Arc::new(StubShellData::default()) as Data,
            })
            .clone()
    }
}

/// The UI shell's routes. `ShellData` is the seam: Phase 2/3 pass a database-backed
/// implementation here instead of the stub.
fn router(data: Arc<Accounts>, web: PathBuf) -> Router {
    let index = web.join("index.html");
    let module_page = index.clone();
    let registry_page = index.clone();
    let local_page = index.clone();
    Router::new()
        .route("/settings/modules", get(move |uri: Uri| app_page(uri, module_page.clone())))
        .route("/settings/modules/registries", get(move |uri: Uri| app_page(uri, registry_page.clone())))
        .route("/settings/modules/local", get(move |uri: Uri| app_page(uri, local_page.clone())))
        .route(
            "/api/shell",
            get(|State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>| async move {
                let cx = safety_core::db::DataContext::open(&d.platform.app, &access).await?;
                let row = cx.db().query_one("SELECT name, is_instance_admin FROM app.get_user_by_id($1::uuid)", &[&access.actor_user_id()]).await?;
                let mut shell = d.for_actor(&access).shell();
                shell.account.display_name = row.get(0);
                shell.account.is_admin = row.get(1);
                if d.can_install_modules {
                    shell.nav.push(moss_shell_contract::NavSection {
                        label: Some("Settings".into()),
                        links: vec![moss_shell_contract::NavLink {
                            path: "/settings/modules".into(),
                            label: "Modules".into(),
                            icon: "package".into(),
                            unread: 0,
                        }],
                    });
                }
                cx.commit().await?;
                if let Some(admin) = &d.module_admin {
                    module_refresh::app_open(admin.clone(), d.modules.clone());
                }
                Ok::<_, safety_core::error::ApiError>(Json::<ShellView>(shell))
            }),
        )
        .route(
            "/api/today",
            get(|State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>| async move { Json::<TodayView>(d.for_actor(&access).today()) }),
        )
        .route("/api/companion/protocol", post(companion::protocol))
        .route("/api/companion/pair", post(companion::pair))
        .route("/api/companion/pair/attempt", post(companion::attempt))
        .route("/api/companion/pair/decide", post(companion::decide))
        .route("/api/companion/pair/redeem", post(companion::redeem))
        .route("/api/companion/pair/cancel", post(companion::cancel))
        // The Meetings Devices screen reaches these through its own module path.
        .route("/api/m/meetings/devices", get(companion_owner::list))
        .route(
            "/api/m/meetings/devices/{id}",
            axum::routing::patch(companion_owner::rename).delete(companion_owner::unlink),
        )
        .route("/api/m/meetings/link/attempt", post(companion::attempt))
        .route("/api/m/meetings/link/decide", post(companion::decide))
        .route("/api/companion/heartbeat", post(companion::heartbeat))
        .route("/api/companion/device", axum::routing::patch(companion::rename))
        .route("/api/companion/logout", post(companion::logout))
        .route("/api/companion/ring-session", get(companion::ring_session))
        .route("/api/companion/ring-logout", post(companion::ring_logout))
        .route("/api/desktop/notices", get(desktop_notices::list).post(desktop_notices::accept))
        // The notifier program signs in with a device token instead of a session.
        .route("/api/notifier/notices", get(desktop_notices::list).post(desktop_notices::accept))
        .route(
            "/api/desktop/notifier",
            post(desktop_notices::register_notifier).delete(desktop_notices::remove_notifier),
        )
        .route(
            "/api/chat/thread",
            get(|State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>| async move { Json::<ChatThread>(d.for_actor(&access).chat_thread()) }),
        )
        .route(
            "/api/chat/messages",
            post(
                |State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>, Json(body): Json<SendMessage>| async move {
                    // The turn runs in the background. The drawer polls the thread for its progress.
                    let data = d.for_actor(&access);
                    match data.send_message(&body) {
                        Ok(thread) => (StatusCode::ACCEPTED, Json::<ChatThread>(thread)).into_response(),
                        Err(error) => chat_error(error),
                    }
                },
            ),
        )
        .route(
            "/api/chat/approvals/{id}",
            post(
                |State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>, axum::extract::Path(id): axum::extract::Path<String>, Json(body): Json<DecideApproval>| async move {
                    let actor = access.actor_user_id().to_string();
                    match d.for_actor(&access).decide_approval(&actor, &id, body.decision) {
                        Ok(thread) => Json::<ChatThread>(thread).into_response(),
                        Err(error) => chat_error(error),
                    }
                },
            ),
        )
        // Client-side routes (/today, /tasks, ...) load the app page. Unknown API routes and
        // missing files answer 404 instead.
        .fallback_service(
            ServeDir::new(&web)
                .fallback((move |uri: Uri| app_page(uri, index.clone())).into_service()),
        )
        .with_state(data)
}

fn chat_error(error: ChatError) -> Response {
    match error {
        ChatError::Busy | ChatError::Closed => StatusCode::CONFLICT,
        ChatError::NotFound => StatusCode::NOT_FOUND,
    }
    .into_response()
}

async fn app_page(uri: Uri, index: PathBuf) -> Response {
    let path = uri.path();
    let last = path.rsplit('/').next().unwrap_or_default();
    if path == "/api" || path.starts_with("/api/") || last.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read_to_string(&index).await {
        Ok(page) => Html(page).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

struct Args {
    network: PathBuf,
    /// Instance folder: holds network.json and, while listening, running.json.
    instance: Option<PathBuf>,
    web: PathBuf,
    runner: Option<PathBuf>,
    modules: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut raw = std::env::args().skip(1).peekable();
    if raw.peek().map(String::as_str) == Some("serve") {
        raw.next();
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_default();
    let mut args = Args {
        network: exe_dir.join(instance::NETWORK_FILE),
        instance: None,
        web: exe_dir.join("web"),
        runner: None,
        modules: None,
    };
    while let Some(flag) = raw.next() {
        let value = raw.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--network" => args.network = PathBuf::from(value),
            "--instance" => {
                let folder = PathBuf::from(value);
                args.network = folder.join(instance::NETWORK_FILE);
                args.instance = Some(folder);
            }
            "--web" => args.web = PathBuf::from(value),
            "--runner" => args.runner = Some(PathBuf::from(value)),
            "--modules" => args.modules = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    if !args.web.join("index.html").is_file() {
        return Err(format!(
            "no web build at {} (run rust-spike/shell/build.sh)",
            args.web.display()
        ));
    }
    Ok(args)
}

/// The record the connecting app uses to find and trust this server. Its origin must use the
/// port the server is listening on.
fn running_record(folder: &Path, config: &Config, port: u16) -> Result<instance::Running, String> {
    let origin = config.local_origin().ok_or("No local HTTPS origin")?;
    if !origin.ends_with(&format!(":{port}")) {
        return Err("The local HTTPS origin does not use the listening port".into());
    }
    let pem = std::fs::read(&config.certificate).map_err(|_| "Cannot read the TLS certificate")?;
    Ok(instance::Running {
        instance: folder
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("default")
            .to_owned(),
        origin: origin.to_owned(),
        fingerprint: instance::fingerprint(&instance::leaf_der(&pem)?),
        pid: std::process::id(),
        version: instance::VERSION.to_owned(),
        api: instance::API,
    })
}

/// Reads the bundle beside an --instance argument and supplies its module
/// secrets, for the separate installer and package processes.
/// Moves one instance's plain credentials into the key store. The one place
/// recovery words are printed, for the owner running setup in a terminal.
fn migrate_keys(raw: Vec<String>) -> Result<(), String> {
    use keystore::custody::{prepare_instance, setup_route, KeyFileStore, SetupRoute};
    let mut instance: Option<std::path::PathBuf> = None;
    let mut key_file: Option<std::path::PathBuf> = None;
    let mut iter = raw.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--instance" => instance = iter.next().map(std::path::PathBuf::from),
            "--key-file" => key_file = iter.next().map(std::path::PathBuf::from),
            _ => {}
        }
    }
    let folder =
        instance.ok_or("usage: moss-server migrate-keys --instance DIR [--key-file FILE]")?;
    let network_file = folder.join("network.json");
    let mut config = moss_network::config::Config::read(&network_file)
        .map_err(|e| format!("cannot read the instance settings: {e}"))?;
    if !folder.join(keystore::custody::LEGACY_CREDENTIALS).exists() {
        return Err("this instance has no plain credentials file to migrate".into());
    }
    let name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "default".into());
    let service = keystore::platform::service_name(&name);
    let platform = keystore::platform::platform_store();
    // The key file belongs to a headless server. A graphical login is a
    // desktop session even when its key store cannot be reached, and there
    // the brief forbids offering the file at all.
    let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    let desktop_session = matches!(session_type.as_str(), "x11" | "wayland" | "mir")
        || std::env::var_os("XDG_CURRENT_DESKTOP").is_some()
        || std::env::var_os("DESKTOP_SESSION").is_some();
    let prepared = match setup_route(desktop_session, platform.probe()) {
        SetupRoute::OsStore => {
            let mut store = keystore::platform::platform_store();
            prepare_instance(&folder, store.as_mut(), &service)
        }
        SetupRoute::KeyFileChoice => {
            let path = key_file
                .ok_or("no keychain session here. Name the key file to create with --key-file")?;
            let path = keystore::custody::headless_key_file_path(&folder, &path)
                .map_err(|e| format!("{}: {}", e.code(), e.reason()))?;
            let mut store = KeyFileStore::new(path.clone());
            let prepared = prepare_instance(&folder, &mut store, &service);
            if prepared.is_ok() {
                keystore::custody::record_key_file_choice(&folder, &path)
                    .map_err(|e| format!("{}: {}", e.code(), e.reason()))?;
            }
            prepared
        }
        SetupRoute::Stop(error) => return Err(format!("{}: {}", error.code(), error.reason())),
    }
    .map_err(|e| format!("{}: {}", e.code(), e.reason()))?;
    config.credentials = prepared.bundle_path().to_path_buf();
    config
        .write(&network_file)
        .map_err(|e| format!("cannot save the instance settings: {e}"))?;
    let words = prepared.words().join(" ");
    println!("Write these recovery words down. They are shown once:");
    println!("{words}");
    // The plain file is deleted only after the owner confirms the copy.
    // Quitting here leaves it standing, and running this again shows fresh words.
    println!("When the words are written down, type SAVED and press Enter.");
    let mut answer = String::new();
    std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut answer)
        .map_err(|e| format!("cannot read the confirmation: {e}"))?;
    if answer.trim() != "SAVED" {
        return Err(
            "the words were not confirmed, so nothing was finished. Run this again when ready."
                .into(),
        );
    }
    // The store used to prepare is gone by now in the key-file branch, so the
    // finish goes through the recorded store choice again.
    let mut store: Box<dyn keystore::custody::OsKeyStore> =
        match keystore::custody::recorded_key_file(&folder) {
            Some(path) => Box::new(keystore::custody::KeyFileStore::new(path)),
            None => keystore::platform::platform_store(),
        };
    if let Err(error) = prepared.commit_with(store.as_mut(), &service) {
        // The finish rolled the bundle back. Point the settings at the plain
        // file again, so the usual start path stays retryable.
        let mut config = moss_network::config::Config::read(&network_file)
            .map_err(|e| format!("cannot read the instance settings: {e}"))?;
        config.credentials = folder.join(keystore::custody::LEGACY_CREDENTIALS);
        let _ = config.write(&network_file);
        return Err(format!("{}: {}", error.code(), error.reason()));
    }
    Ok(())
}

/// Puts the master key back into this machine's key store from the owner's
/// recovery words, read from one line on stdin.
fn restore_keys(raw: Vec<String>) -> Result<(), String> {
    let mut instance: Option<std::path::PathBuf> = None;
    let mut iter = raw.iter();
    while let Some(arg) = iter.next() {
        if arg.as_str() == "--instance" {
            instance = iter.next().map(std::path::PathBuf::from);
        }
    }
    let folder = instance.ok_or("usage: moss-server restore-keys --instance DIR")?;
    let name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "default".into());
    let service = keystore::platform::service_name(&name);
    let bundle = keystore::custody::read_bundle(&folder)
        .map_err(|e| format!("{}: {}", e.code(), e.reason()))?;
    let mut line = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut line)
        .map_err(|e| format!("cannot read the recovery words: {e}"))?;
    let typed = keystore::recovery::split_pasted(&line);
    let recorded = keystore::custody::recorded_key_file(&folder);
    let mut store: Box<dyn keystore::custody::OsKeyStore> = match recorded {
        Some(path) => Box::new(keystore::custody::KeyFileStore::new(path)),
        None => keystore::platform::platform_store(),
    };
    keystore::custody::restore_to_store(&bundle, &typed, store.as_mut(), &service)
        .map_err(|e| format!("{}: {}", e.code(), e.reason()))?;
    println!("The master key is back in this machine's key store.");
    Ok(())
}

/// Loads the replacement module secrets from the wrapped bundle for a child
/// process. A store that cannot open the bundle stops the child here, with
/// the custody error itself, instead of a misleading settings complaint.
fn supply_module_secrets_from_args() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let Some(position) = args.iter().position(|arg| arg == "--instance") else {
        return Ok(());
    };
    let Some(instance) = args.get(position + 1) else {
        return Ok(());
    };
    let folder = std::path::PathBuf::from(instance);
    // No instance settings means the child is not running against a set-up
    // instance; its own entry point reports that as before.
    let Ok(config) = moss_network::config::Config::read(&folder.join("network.json")) else {
        return Ok(());
    };
    // Only a wrapped bundle needs the key store. A plain credentials file
    // carries its own values and the settings file still holds the rest.
    let credentials = folder.join("credentials.json");
    if credentials.exists() && !folder.join(keystore::custody::BUNDLE_FILE).exists() {
        return Ok(());
    }
    let secrets = config.module_secrets()?;
    modules::set_module_secrets(modules::ModuleSecrets {
        connector_key: secrets.connector_key,
        ai_key: secrets.ai_key,
        producer_url: secrets.producer_url,
        migrations_url: secrets.migrations_url,
        worker_url: secrets.worker_url,
        embeddings_api_key: secrets.embeddings_api_key,
    });
    Ok(())
}

/// Runs the secret supply for a child process, stopping it on failure.
fn supply_or_stop() {
    if let Err(error) = supply_module_secrets_from_args() {
        eprintln!("moss-server: {error}");
        std::process::exit(1);
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("lifecycle-module") {
        supply_or_stop();
        if module_lifecycle_service::run(std::env::args().skip(2).collect()).is_err() {
            eprintln!(
                "moss-server: The module lifecycle service stopped; read the operation result"
            );
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("apply-module-package") {
        supply_or_stop();
        if module_package_apply::run(std::env::args().skip(2).collect()).is_err() {
            eprintln!("Package activation failed");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("migrate-keys") {
        if let Err(error) = migrate_keys(std::env::args().skip(2).collect()) {
            eprintln!("moss-server migrate-keys: {error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("restore-keys") {
        if let Err(error) = restore_keys(std::env::args().skip(2).collect()) {
            eprintln!("moss-server restore-keys: {error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("install-module") {
        supply_or_stop();
        let runtime_free = module_install::run(std::env::args().skip(2).collect());
        if let Err(error) = runtime_free {
            eprintln!("moss-server: {error:#}");
            std::process::exit(1);
        }
        return;
    }
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("moss-server: {e}");
            std::process::exit(2);
        }
    };
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // An instance made by the app carries its module settings, so no flag is needed.
    let modules_path = args.modules.clone().or_else(|| {
        args.instance
            .as_ref()
            .map(|folder| folder.join("modules.json"))
            .filter(|path| path.is_file())
    });
    let prepared = runtime.block_on(async {
        let config = Config::read(&args.network)?;
        if let Ok(raw) = moss_network::config::private_read(&config.credentials) {
            if !moss_network::config::is_bundle(&raw) {
                eprintln!("moss-server: this instance still keeps its keys in a plain file. Run moss-server migrate-keys --instance <folder> to move them into the key store.");
            }
        }
        let platform = config.platform().await?;
        // Module settings no longer hold their secrets after key custody.
        if let Ok(secrets) = config.module_secrets() {
            modules::set_module_secrets(modules::ModuleSecrets {
                connector_key: secrets.connector_key,
                ai_key: secrets.ai_key,
                producer_url: secrets.producer_url,
                migrations_url: secrets.migrations_url,
                worker_url: secrets.worker_url,
                embeddings_api_key: secrets.embeddings_api_key,
            });
        }
        let acceptor = tls::acceptor(&config.certificate, &config.private_key)?;
        let listener = tokio::net::TcpListener::bind(config.listen)
            .await
            .map_err(|_| "Cannot bind the configured HTTPS listener")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Cannot read the listening port")?
            .port();
        let running = match &args.instance {
            Some(folder) => Some(running_record(folder, &config, port)?),
            None => None,
        };
        let network = Network::new(platform.clone(), config, args.network)?;
        // The registry and file-import paths do not run install-module. Prepare the core
        // device lookup before loading modules or accepting a pairing request.
        if companion_startup::prepare(&platform.auth, modules_path.as_deref(), args.instance.as_deref())
            .await.is_err() {
            eprintln!("moss-server: device lookup is unavailable; linking stays disabled until module installation or a successful restart");
        }
        // The host opens in the background, last: errors above must not drop its runtimes on
        // this executor, and a module installed later is picked up without a restart.
        let modules: modules::Slot = Arc::new(Mutex::new(None));
        let loader = modules_path.clone().map(|path| {
            let (slot, database, stop) = (modules.clone(), platform.app.clone(), stop.clone());
            tokio::task::spawn_blocking(move || {
                modules::load_when_ready(slot, path, database, stop)
            })
        });
        let admin = args
            .instance
            .clone()
            .map(|folder| Arc::new(module_admin::Admin::new(platform.clone(), folder)));
        let data = Arc::new(Accounts {
            platform: platform.clone(),
            can_install_modules: args.instance.is_some(),
            module_admin: admin.clone(),
            runner: args.runner,
            modules: modules.clone(),
            data: Mutex::new(HashMap::new()),
        });
        companion::register_revoker(&data);
        let private = router(data, args.web.clone());
        let private = match &loader {
            Some(_) => private.merge(modules::routes(modules.clone(), args.web.clone())),
            None => private,
        };
        // Embedding settings are served by the host itself, so the credential never reaches a
        // module's guest code.
        let private = match modules_path
            .as_deref()
            .and_then(|path| modules::read_settings(path).ok())
        {
            Some(settings) => match module_embedding::EmbeddingConfig::new(
                platform.app.clone(),
                &settings.connector_key,
                &settings.data,
                settings.embeddings.is_some(),
            ) {
                Ok(embedding) => private.merge(module_embedding::routes(Arc::new(embedding))),
                Err(_) => private,
            },
            None => private,
        };
        let private = private.merge(proactive_feedback::routes(Arc::new(
            proactive_feedback::Feedback::new(platform.app.clone()),
        )));

        let private = match modules_path
            .as_deref()
            .and_then(|path| modules::read_settings(path).ok())
        {
            Some(settings) => {
                let wiring = integrations::Wiring {
                    producer_url: settings.producer_url.clone(),
                    worker_url: settings.worker_url.clone(),
                };
                match integrations::routes(platform.app.clone(), wiring, stop.clone()).await {
                    Ok(routes) => private.merge(routes),
                    Err(_) => private,
                }
            }
            None => private,
        };
        let private = match admin {
            Some(admin) => {
                module_refresh::start(admin.clone(), modules.clone(), stop.clone());
                private.merge(module_admin::routes(admin))
            },
            None => private,
        };
        let private = private.layer(Extension(modules.clone()));
        let app = web::router(network, private, args.web);
        Ok::<_, String>((listener, acceptor, app, running, modules, loader))
    });
    let (listener, acceptor, app, running, modules, loader) = match prepared {
        Ok(parts) => parts,
        Err(reason) => {
            // The reasons are fixed messages that never carry secrets.
            eprintln!("moss-server: could not start secure HTTPS ({reason}); check private configuration, certificates and runtime database roles");
            std::process::exit(1);
        }
    };
    if let (Some(folder), Some(running)) = (&args.instance, &running) {
        if running.write(folder).is_err() {
            eprintln!("moss-server: could not write the instance running file");
            std::process::exit(1);
        }
    }
    let served = runtime.block_on(tls::serve_in(
        listener,
        acceptor,
        app,
        args.instance.as_deref(),
    ));
    // The host owns blocking runtimes. Drop it outside the asynchronous executor.
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    // The loader can sit in a database wait or a lock held by another installer. Give it a few
    // seconds, then leave without it so shutdown never hangs.
    let stuck = match loader {
        // The timer needs the runtime, so build the timeout inside the future.
        Some(loader) => runtime
            .block_on(async {
                tokio::time::timeout(std::time::Duration::from_secs(5), loader).await
            })
            .is_err(),
        None => false,
    };
    if !stuck {
        drop(modules.lock().unwrap_or_else(|e| e.into_inner()).take());
    }
    if let Some(folder) = &args.instance {
        instance::Running::remove_if_ours(folder);
    }
    if stuck {
        std::process::exit(if served.is_err() { 1 } else { 0 });
    }
    if served.is_err() {
        std::process::exit(1);
    }
}
