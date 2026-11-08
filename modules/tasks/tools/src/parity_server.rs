//! Disposable HTTP adapter for the existing differential harness. All Tasks
//! effects execute in the compiled guest, never in the Phase 0b native repository.
use std::{collections::HashMap, net::SocketAddr, sync::Arc};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Method, Uri},
    response::Response,
    Router,
};
use moss_module_host::{
    context::ContextPorts,
    dispatch,
    manifest::Manifest,
    runtime::{DenyPorts, Host, Limits, Ports},
    transactional_database::TransactionalDatabasePorts,
};
use moss_tasks_module::schema;
#[cfg(test)]
use moss_tasks_module::schemas;
use safety_core::{
    auth::{resolve_access, SessionCookies},
    db::{Database, RuntimeRole},
    error::{json_reply, ApiError},
    http::{self, Platform},
    origin::TrustedOrigins,
    secret::SecretCipher,
};
use serde_json::json;

// Reuse the existing harness HTTP parser; it has no native Tasks data path.
#[path = "../../../../rust-spike/tasks/src/body.rs"]
mod body;

#[derive(Clone)]
struct Server {
    platform: Arc<Platform>,
    host: Arc<Host>,
    manifest: Arc<Manifest>,
    wasm: Arc<Vec<u8>>,
    ports: Arc<dyn Ports>,
    slots: Arc<tokio::sync::Semaphore>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("JARVIS_GATE_RUN").as_deref() == Ok("1"),
        "Use scripts/run-gate.sh"
    );
    let env: HashMap<String, String> = std::env::vars().collect();
    let port: u16 = env["TASKS_SPIKE_PORT"].parse()?;
    let app = Database::connect(&env["MOSS_APP_DATABASE_URL"], 4, RuntimeRole::App)
        .await
        .map_err(anyhow::Error::msg)?;
    let auth = Database::connect(&env["MOSS_AUTH_DATABASE_URL"], 2, RuntimeRole::Auth)
        .await
        .map_err(anyhow::Error::msg)?;
    let platform = Arc::new(Platform {
        app,
        auth,
        sessions: SessionCookies::from_env(&env).map_err(anyhow::Error::msg)?,
        connectors: SecretCipher::connectors(&env).map_err(anyhow::Error::msg)?,
        origins: TrustedOrigins::from_env(&env, port).map_err(anyhow::Error::msg)?,
    });
    // The synchronous host owns a runtime. Construct and drop it on its blocking
    // executor, rather than dropping a nested runtime inside this async context.
    let database = platform.app.clone();
    let server_platform = platform.clone();
    let state = tokio::task::spawn_blocking(move || -> anyhow::Result<Server> {
        let manifest = Arc::new(moss_tasks_checks::manifest()?);
        let wasm = Arc::new(std::fs::read(std::env::var("TASKS_COMPONENT")?)?);
        let host = Arc::new(Host::new(Limits::default())?);
        host.validate(&wasm, &manifest)?;
        let ports = Arc::new(ContextPorts::new(Arc::new(
            TransactionalDatabasePorts::new(database, Arc::new(DenyPorts))?,
        )));
        Ok(Server {
            platform: server_platform,
            host,
            manifest,
            wasm,
            ports,
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
        })
    })
    .await??;
    let extra = Router::new()
        .fallback(invoke)
        .layer(DefaultBodyLimit::max(body::BODY_LIMIT * 2))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
    axum::serve(listener, http::app(platform, extra))
        .with_graceful_shutdown(shutdown())
        .await?;
    tokio::task::spawn_blocking(move || drop(state)).await?;
    Ok(())
}

async fn invoke(
    State(state): State<Server>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let Some(path) = uri.path().strip_prefix("/api") else {
        return Ok(not_found(&method, &uri));
    };
    let mut request = match dispatch::resolve(&state.manifest.routes, method.as_str(), path) {
        Ok(request) => request,
        Err(_) => return Ok(not_found(&method, &uri)),
    };
    let parsed = body::read_body(&method, &headers, &bytes)?;
    let schema = moss_tasks_module::validation::request_schema(&request.method, &request.path);
    // Fastify checks schemas before authentication. The guest checks again for
    // callers using the module host directly rather than this HTTP adapter.
    request.body = body::validated(parsed, schema.as_ref())?;
    request.query = body::parse_query(uri.query()).into_iter().collect();
    let access = resolve_access(&state.platform, &headers).await?;
    let permit = state
        .slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::Internal("Tasks component executor stopped".into()))?;
    let response = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        state.host.call(
            &state.wasm,
            state.manifest.clone(),
            access,
            state.ports.clone(),
            "route",
            &serde_json::to_string(&request)?,
        )
    })
    .await
    .map_err(|_| ApiError::Internal("Tasks component executor failed".into()))?
    .map_err(|_| ApiError::Internal("Tasks component invocation failed".into()))?;
    let response: moss_module_sdk::Response = serde_json::from_str(&response)
        .map_err(|_| ApiError::Internal("Invalid Tasks component response".into()))?;
    Ok(json_reply(response.status, &response.body))
}

fn not_found(method: &Method, uri: &Uri) -> Response {
    json_reply(
        404,
        &json!({"message":format!("Route {method}:{uri} not found"),"error":"Not Found","statusCode":404}),
    )
}

async fn shutdown() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = terminate.recv() => {},
    }
}
