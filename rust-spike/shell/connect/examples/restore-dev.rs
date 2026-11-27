//! Real local dev instance of the desktop Restore screen. No mocked replies.
//! Usage: restore-dev DATA INSTALL PORT TRACE. Loopback-only; never shipped in the install.
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use moss_app::restore::Flow;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct App {
    flow: Mutex<Flow>,
    install: PathBuf,
    data: PathBuf,
    trace: PathBuf,
    origin: String,
}
type Shared = Arc<App>;
fn allowed(headers: &HeaderMap, app: &App) -> bool {
    headers.get("origin").and_then(|h| h.to_str().ok()) == Some(app.origin.as_str())
}
async fn choose(State(app): State<Shared>, headers: HeaderMap, bytes: Bytes) -> Response {
    if !allowed(&headers, &app) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let name = headers
        .get("x-moss-filename")
        .and_then(|v| v.to_str().ok())
        .filter(|n| !n.contains(['/', '\\', ':']) && n.ends_with(".mossbak"))
        .unwrap_or("selected.mossbak");
    let path = app.data.join(name);
    if moss_network::config::private_write(&path, &bytes).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(app.flow.lock().unwrap().select(path)).into_response()
}
async fn action(
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Response {
    if !allowed(&headers, &app) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match value["do"].as_str().unwrap_or("") {
        "retry" | "restore" => Json(app.flow.lock().unwrap().state()).into_response(),
        "first-run" => {
            *app.flow.lock().unwrap() = Flow::new(&app.data, &app.install);
            Json(json!({"screen":"first-run"})).into_response()
        }
        "restore-run" => {
            let words: Vec<String> = value["words"]
                .as_str()
                .unwrap_or("")
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            let result = tokio::task::spawn_blocking(move || {
                app.flow.lock().unwrap().run(&words, |event| {
                    use std::io::Write;
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&app.trace)
                    {
                        let _ = writeln!(file, "{event}");
                    }
                })
            })
            .await
            .unwrap();
            Json(result).into_response()
        }
        "restore-open" => {
            let destination = app.flow.lock().unwrap().destination.clone();
            let install = app.install.clone();
            let result = tokio::task::spawn_blocking(move || {
                moss_launcher::database::ensure_database(&install, &destination, false)
                    .map_err(|_| ())?;
                if let Ok(port) = std::env::var("MOSS_RESTORE_SERVER_PORT")
                    .unwrap_or_default()
                    .parse::<u16>()
                {
                    let mut config =
                        moss_network::config::Config::read(&destination.join("network.json"))
                            .map_err(|_| ())?;
                    config.listen.set_port(port);
                    config.origins = vec![
                        format!("https://127.0.0.1:{port}"),
                        format!("https://localhost:{port}"),
                    ];
                    config
                        .write(&destination.join("network.json"))
                        .map_err(|_| ())?;
                }
                let log = std::fs::File::create(destination.join("server.log")).map_err(|_| ())?;
                std::process::Command::new(
                    install.join(format!("moss-server{}", std::env::consts::EXE_SUFFIX)),
                )
                .args(["serve", "--instance"])
                .arg(&destination)
                .arg("--web")
                .arg(install.join("web"))
                .stdin(std::process::Stdio::null())
                .stdout(log.try_clone().map_err(|_| ())?)
                .stderr(log)
                .spawn()
                .map_err(|_| ())?;
                for _ in 0..600 {
                    if let Ok(running) = moss_network::instance::Running::read(&destination) {
                        return Ok(running.origin);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(())
            })
            .await
            .unwrap();
            match result {
                Ok(origin) => Json(json!({"open": origin})).into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}
async fn asset(State(app): State<Shared>, Path(path): Path<String>) -> Response {
    let (kind, bytes): (&str, Vec<u8>) = match path.as_str() {
        "connect.js" => (
            "text/javascript",
            include_bytes!("../assets/connect.js").to_vec(),
        ),
        "restore.js" => (
            "text/javascript",
            include_bytes!("../assets/restore.js").to_vec(),
        ),
        "connect.css" => ("text/css", include_bytes!("../assets/connect.css").to_vec()),
        "dev.js" => (
            "text/javascript",
            include_bytes!("../assets/restore-dev.js").to_vec(),
        ),
        "app.css" => (
            "text/css",
            std::fs::read(app.install.join("web/app.css")).unwrap_or_default(),
        ),
        "boot-theme.js" => ("text/javascript", Vec::new()),
        p if p.starts_with("fonts/") && !p.contains("..") => (
            "font/woff2",
            std::fs::read(app.install.join("web").join(p)).unwrap_or_default(),
        ),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([("content-type", kind)], bytes).into_response()
}
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 5, "restore-dev DATA INSTALL PORT TRACE");
    let data = std::path::absolute(&args[1]).unwrap();
    let install = std::path::absolute(&args[2]).unwrap();
    let port: u16 = args[3].parse().unwrap();
    moss_app::store::private_dir(&data).unwrap();
    let app = Arc::new(App {
        flow: Mutex::new(Flow::new(&data, &install)),
        install,
        data,
        trace: args[4].clone().into(),
        origin: format!("http://127.0.0.1:{port}"),
    });
    let html = include_str!("../assets/index.html").replace(
        "<script src=\"/restore.js\"",
        "<script src=\"/dev.js\"></script><script src=\"/restore.js\"",
    );
    let router = Router::new()
        .route("/", get(move || async { Html(html) }))
        .route("/choose", post(choose))
        .route("/action", post(action))
        .route("/{*path}", get(asset))
        .layer(DefaultBodyLimit::max(1024 * 1024 * 1024))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    println!("restore-dev ready");
    axum::serve(listener, router).await.unwrap();
}
