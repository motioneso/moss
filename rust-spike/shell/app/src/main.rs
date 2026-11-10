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
use moss_shell_contract::{ChatMessage, ChatThread, SendMessage, ShellData, ShellView, TodayView};
use safety_core::access::AccessContext;
use tower_http::services::ServeDir;

mod desktop_notices;
mod module_ai;
mod module_install;
mod modules;
mod runner_data;

type Data = Arc<dyn ShellData>;

struct Accounts {
    platform: Arc<safety_core::http::Platform>,
    runner: Option<PathBuf>,
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
    Router::new()
        .route(
            "/api/shell",
            get(|State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>| async move {
                let cx = safety_core::db::DataContext::open(&d.platform.app, &access).await?;
                let row = cx.db().query_one("SELECT name FROM app.get_user_by_id($1::uuid)", &[&access.actor_user_id()]).await?;
                let mut shell = d.for_actor(&access).shell();
                shell.account.display_name = row.get(0);
                cx.commit().await?;
                Ok::<_, safety_core::error::ApiError>(Json::<ShellView>(shell))
            }),
        )
        .route(
            "/api/today",
            get(|State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>| async move { Json::<TodayView>(d.for_actor(&access).today()) }),
        )
        .route("/api/desktop/notices", get(desktop_notices::list).post(desktop_notices::accept))
        .route(
            "/api/chat/thread",
            get(|State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>| async move { Json::<ChatThread>(d.for_actor(&access).chat_thread()) }),
        )
        .route(
            "/api/chat/messages",
            post(
                |State(d): State<Arc<Accounts>>, Extension(access): Extension<AccessContext>, Json(body): Json<SendMessage>| async move {
                    // A chat turn can take minutes, so it waits off the request threads.
                    let data = d.for_actor(&access);
                    match tokio::task::spawn_blocking(move || data.send_message(&body.text)).await {
                        Ok(m) => Json::<ChatMessage>(m).into_response(),
                        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
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

fn main() {
    if std::env::args().nth(1).as_deref() == Some("install-module") {
        let runtime_free = module_install::run(std::env::args().skip(2).collect());
        if let Err(error) = runtime_free {
            eprintln!("moss-shell: {error:#}");
            std::process::exit(1);
        }
        return;
    }
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("moss-shell: {e}");
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
        let platform = config.platform().await?;
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
        // The host opens in the background, last: errors above must not drop its runtimes on
        // this executor, and a module installed later is picked up without a restart.
        let modules: modules::Slot = Arc::new(Mutex::new(None));
        let loader = modules_path.map(|path| {
            let (slot, database, stop) = (modules.clone(), platform.app.clone(), stop.clone());
            tokio::task::spawn_blocking(move || {
                modules::load_when_ready(slot, path, database, stop)
            })
        });
        let data = Arc::new(Accounts {
            platform,
            runner: args.runner,
            data: Mutex::new(HashMap::new()),
        });
        let private = router(data, args.web.clone());
        let private = match &loader {
            Some(_) => private.merge(modules::routes(modules.clone())),
            None => private,
        };
        let app = web::router(network, private, args.web);
        Ok::<_, String>((listener, acceptor, app, running, modules, loader))
    });
    let (listener, acceptor, app, running, modules, loader) = match prepared {
        Ok(parts) => parts,
        Err(_) => {
            eprintln!("moss-shell: could not start secure HTTPS; check private configuration, certificates and runtime database roles");
            std::process::exit(1);
        }
    };
    if let (Some(folder), Some(running)) = (&args.instance, &running) {
        if running.write(folder).is_err() {
            eprintln!("moss-shell: could not write the instance running file");
            std::process::exit(1);
        }
    }
    let served = runtime.block_on(tls::serve(listener, acceptor, app));
    // The host owns blocking runtimes. Drop it outside the asynchronous executor.
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    // The loader can sit in a database wait or a lock held by another installer. Give it a few
    // seconds, then leave without it so shutdown never hangs.
    let stuck = match loader {
        Some(loader) => runtime
            .block_on(tokio::time::timeout(
                std::time::Duration::from_secs(5),
                loader,
            ))
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
