//! The Rust Tasks server. It runs only inside a gate run, against a throwaway database.
//!
//! Environment:
//! - `JARVIS_GATE_RUN=1`, or the server refuses to start
//! - `MOSS_APP_DATABASE_URL` and `MOSS_WORKER_DATABASE_URL`, the two runtime roles
//! - `TASKS_SPIKE_PORT`, served on 127.0.0.1 only

use std::net::SocketAddr;

use tasks::{db, jobs, routes};
use tokio::signal::unix::{signal, SignalKind};

#[tokio::main]
async fn main() -> Result<(), String> {
    if std::env::var("JARVIS_GATE_RUN").as_deref() != Ok("1") {
        return Err("refusing to start: JARVIS_GATE_RUN=1 is not set".into());
    }
    let app_url = required("MOSS_APP_DATABASE_URL")?;
    let worker_url = required("MOSS_WORKER_DATABASE_URL")?;
    let port: u16 = required("TASKS_SPIKE_PORT")?
        .parse()
        .map_err(|_| "TASKS_SPIKE_PORT must be a port number".to_owned())?;

    let app = db::pool(&app_url, 4)?;
    let worker = db::pool(&worker_url, 2)?;
    db::assert_runtime_role(&app, "jarvis_app_runtime").await?;
    db::assert_runtime_role(&worker, "jarvis_worker_runtime").await?;

    let (stop, stopped) = tokio::sync::watch::channel(false);
    let worker_task = tokio::spawn(jobs::run_worker(worker, stopped));

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(address).await.map_err(|error| error.to_string())?;
    eprintln!("tasks spike listening on {address}");
    axum::serve(listener, routes::router(routes::AppState { app }))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| error.to_string())?;

    let _ = stop.send(true);
    let _ = worker_task.await;
    Ok(())
}

fn required(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set"))
}

async fn shutdown_signal() {
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}
