//! One program, two ways to run:
//!
//!   moss-shell serve [--host 127.0.0.1] [--port 5180] [--web <dir>]
//!   moss-shell desktop [--web <dir>]
//!
//! `serve` answers browsers on the LAN or this machine. `desktop` starts the same server on a
//! private loopback port and opens it in a native window (tao + wry, the system webview).
//! With no subcommand it opens the desktop window.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use moss_shell_contract::stub::StubShellData;
use moss_shell_contract::{ChatMessage, ChatThread, SendMessage, ShellData, ShellView, TodayView};
use tower_http::services::{ServeDir, ServeFile};

type Data = Arc<dyn ShellData>;

/// The UI shell's routes. `ShellData` is the seam: Phase 2/3 pass a database-backed
/// implementation here instead of the stub.
fn router(data: Data, web: PathBuf) -> Router {
    let index = web.join("index.html");
    Router::new()
        .route(
            "/api/shell",
            get(|State(d): State<Data>| async move { Json::<ShellView>(d.shell()) }),
        )
        .route(
            "/api/today",
            get(|State(d): State<Data>| async move { Json::<TodayView>(d.today()) }),
        )
        .route(
            "/api/chat/thread",
            get(|State(d): State<Data>| async move { Json::<ChatThread>(d.chat_thread()) }),
        )
        .route(
            "/api/chat/messages",
            post(
                |State(d): State<Data>, Json(body): Json<SendMessage>| async move {
                    Json::<ChatMessage>(d.send_message(&body.text))
                },
            ),
        )
        // Client-side routes (/today, /tasks, ...) all load the app page.
        .fallback_service(ServeDir::new(&web).fallback(ServeFile::new(index)))
        .with_state(data)
}

struct Args {
    mode: String,
    host: String,
    port: u16,
    web: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut raw = std::env::args().skip(1).peekable();
    let mode = match raw.peek().map(String::as_str) {
        Some("serve") | Some("desktop") => raw.next().unwrap_or_default(),
        _ => "desktop".to_string(),
    };
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_default();
    let mut args = Args {
        mode,
        host: "127.0.0.1".into(),
        port: 0,
        web: exe_dir.join("web"),
    };
    while let Some(flag) = raw.next() {
        let value = raw.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--host" => args.host = value,
            "--port" => args.port = value.parse().map_err(|_| format!("bad port {value}"))?,
            "--web" => args.web = PathBuf::from(value),
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

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("moss-shell: {e}");
            std::process::exit(2);
        }
    };
    let data: Data = Arc::new(StubShellData::default());
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

    if args.mode == "serve" {
        runtime.block_on(async {
            let listener = bind(&args.host, args.port).await;
            let addr = listener.local_addr().expect("addr");
            println!("moss-shell serving on http://{addr}");
            if !addr.ip().is_loopback() {
                // Sign-in arrives with the core platform port; until then anyone who can
                // reach this address sees the sample data.
                eprintln!(
                    "moss-shell: listening beyond this machine with no sign-in (sample data only)"
                );
            }
            axum::serve(listener, router(data, args.web))
                .await
                .expect("server");
        });
        return;
    }

    // Desktop: the server lives on a loopback port only this window is told about.
    let listener = runtime.block_on(bind("127.0.0.1", args.port));
    let addr = listener.local_addr().expect("addr");
    let app = router(data, args.web);
    runtime.spawn(async move { axum::serve(listener, app).await.expect("server") });
    desktop::run(addr);
}

async fn bind(host: &str, port: u16) -> tokio::net::TcpListener {
    tokio::net::TcpListener::bind((host, port))
        .await
        .unwrap_or_else(|e| {
            eprintln!("moss-shell: cannot listen on {host}:{port}: {e}");
            std::process::exit(1);
        })
}

mod desktop {
    use super::SocketAddr;
    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::window::WindowBuilder;
    use wry::WebViewBuilder;

    pub fn run(addr: SocketAddr) {
        let event_loop = EventLoop::new();
        let window = WindowBuilder::new()
            .with_title("Moss")
            .with_inner_size(LogicalSize::new(1360.0, 860.0))
            .with_min_inner_size(LogicalSize::new(360.0, 560.0))
            .build(&event_loop)
            .expect("window");

        let builder = WebViewBuilder::new().with_url(format!("http://{addr}/today"));

        #[cfg(not(target_os = "linux"))]
        let _webview = builder.build(&window).expect("webview");
        #[cfg(target_os = "linux")]
        let _webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            builder
                .build_gtk(window.default_vbox().expect("vbox"))
                .expect("webview")
        };

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            if let Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } = event
            {
                *control_flow = ControlFlow::Exit;
            }
        });
    }
}
