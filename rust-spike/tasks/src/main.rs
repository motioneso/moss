//! The Rust server: the platform routes plus Tasks. It runs only inside a gate run, against a
//! throwaway database.
//!
//! Environment:
//! - `JARVIS_GATE_RUN=1`, or the server refuses to start
//! - `MOSS_APP_DATABASE_URL`, `MOSS_WORKER_DATABASE_URL` and `MOSS_AUTH_DATABASE_URL`, the three
//!   runtime roles
//! - `TASKS_SPIKE_PORT`, the port to serve on
//! - `HOST` (optional), the address to listen on. It defaults to loopback for test runs. Set it
//!   to `0.0.0.0` to serve phones and other computers on the network, as the TypeScript server
//!   does by default.
//! - the sign-in and connector key variables the platform reads (`BETTER_AUTH_SECRET`,
//!   `JARVIS_TRUST_PROXY`, `JARVIS_CONNECTOR_SECRET_KEY` and friends)
//! - `TASKS_SPIKE_STATIC_DIR` (optional), a folder of built UI files served for every path the
//!   API does not claim, so one process serves the API and the screen from one origin

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use platform::auth::SessionCookies;
use platform::db::{Database, RuntimeRole};
use platform::http::{self, Platform};
use platform::origin::TrustedOrigins;
use platform::secret::SecretCipher;
use tasks::{jobs, routes};
use tokio::signal::unix::{signal, SignalKind};

#[tokio::main]
async fn main() -> Result<(), String> {
    if std::env::var("JARVIS_GATE_RUN").as_deref() != Ok("1") {
        return Err("refusing to start: JARVIS_GATE_RUN=1 is not set".into());
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    let port: u16 = required(&env, "TASKS_SPIKE_PORT")?
        .parse()
        .map_err(|_| "TASKS_SPIKE_PORT must be a port number".to_owned())?;
    let host = match env.get("HOST").map(|host| host.trim()).filter(|host| !host.is_empty()) {
        Some(host) => host.parse().map_err(|_| "HOST must be an IP address".to_owned())?,
        None => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };

    let app = connect(&env, "MOSS_APP_DATABASE_URL", 4, RuntimeRole::App).await?;
    let worker = connect(&env, "MOSS_WORKER_DATABASE_URL", 2, RuntimeRole::Worker).await?;
    let auth = connect(&env, "MOSS_AUTH_DATABASE_URL", 2, RuntimeRole::Auth).await?;
    let sessions = SessionCookies::from_env(&env)?;
    let connectors = SecretCipher::connectors(&env).map_err(|error| error.to_string())?;
    let origins = TrustedOrigins::from_env(&env, port)?;
    let platform = Arc::new(Platform { app, auth, sessions, connectors, origins });

    let (stop, stopped) = tokio::sync::watch::channel(false);
    let worker_task = tokio::spawn(jobs::run_worker(worker, stopped));

    let address = SocketAddr::new(host, port);
    let listener = tokio::net::TcpListener::bind(address).await.map_err(|error| error.to_string())?;
    eprintln!("tasks spike listening on {address}");
    let mut tasks = routes::router(routes::AppState { platform: platform.clone() });
    if let Some(dir) = env.get("TASKS_SPIKE_STATIC_DIR") {
        tasks = tasks.fallback_service(tower_http::services::ServeDir::new(dir));
    }
    axum::serve(listener, http::app(platform, tasks))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| error.to_string())?;

    let _ = stop.send(true);
    let _ = worker_task.await;
    Ok(())
}

/// Connects as one runtime role. [`Database::connect`] refuses a role that can bypass RLS.
async fn connect(
    env: &HashMap<String, String>,
    name: &str,
    max_size: usize,
    role: RuntimeRole,
) -> Result<Database, String> {
    Database::connect(required(env, name)?, max_size, role).await
}

fn required<'a>(env: &'a HashMap<String, String>, name: &str) -> Result<&'a str, String> {
    env.get(name).map(String::as_str).ok_or_else(|| format!("{name} is not set"))
}

async fn shutdown_signal() {
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}
