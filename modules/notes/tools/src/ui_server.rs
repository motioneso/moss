//! Disposable signed Notes package check using the real HTTPS/sign-in boundary.
//! This small fixture frame is not the Phase 4 shell. No production data is used.
#[path = "../tests/support/mod.rs"]
mod support;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use axum::{
    body::{Body, Bytes},
    extract::{ConnectInfo, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
    routing::get,
    Extension, Router,
};
use moss_module_host::{
    application::{Application, Configuration},
    frame::AssetPolicy,
    registry::Source,
    runtime::{CallScope, Request},
};
use moss_network::{config::Config, web::Network};
use safety_core::{error::json_reply, http::Platform, secret::Secret};
use serde_json::Value;
use std::{net::SocketAddr, path::PathBuf, sync::Arc};

fn fixture_step<T>(name: &'static str, result: Result<T>) -> Result<T> {
    result.map_err(|_| {
        eprintln!("Notes fixture failed at stage: {name}");
        anyhow::anyhow!("Fixture stage failed")
    })
}

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("AI is not connected in the Notes UI check")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Embeddings are not connected in the Notes UI check")
    }
}
struct Server {
    application: std::sync::Mutex<Option<Application>>,
    platform: Arc<Platform>,
    config: Config,
    network: Arc<Network>,
    root: PathBuf,
    shared: PathBuf,
    slots: Arc<tokio::sync::Semaphore>,
}
impl Server {
    fn installed(
        &self,
        access: AccessContext,
    ) -> Result<std::sync::MutexGuard<'_, Option<Application>>> {
        let mut app = self
            .application
            .lock()
            .map_err(|_| anyhow::anyhow!("Host busy"))?;
        if app.is_none() {
            #[derive(serde::Deserialize)]
            struct Key {
                connector_key: String,
            }
            let key: Key = serde_json::from_slice(
                &moss_network::config::private_read(&self.config.credentials)
                    .map_err(anyhow::Error::msg)?,
            )?;
            let cipher =
                safety_core::secret::SecretCipher::connectors(&std::collections::HashMap::from([
                    ("JARVIS_CONNECTOR_SECRET_KEY".into(), key.connector_key),
                ]))
                .map_err(|_| anyhow::anyhow!("Invalid fixture connector key"))?;
            let application = fixture_step(
                "open host",
                Application::open_extended_with(
                    &self.root.join("data"),
                    self.platform.app.clone(),
                    access.clone(),
                    Configuration {
                        migrations: Secret::new(std::env::var("NOTES_UI_BOOTSTRAP_URL")?),
                        producer: Secret::new(std::env::var("NOTES_UI_PRODUCER_URL")?),
                        cipher: Arc::new(cipher),
                        intelligence: Arc::new(NoAi),
                        version: "0.1.0".parse()?,
                        compiled_cache: None,
                        fuel_ceiling: None,
                        browser_dir: None,
                    },
                    |next| {
                        let roots = self
                            .root
                            .join("folders")
                            .join(access.actor_user_id().to_string());
                        std::fs::create_dir_all(roots.join("Journal"))?;
                        std::fs::write(
                            roots.join("keep.md"),
                            b"Notes browser fixture; keep on unlink",
                        )?;
                        let file_roots = std::collections::BTreeMap::from([(
                            access.actor_user_id(),
                            vault::AllowedRoots::for_account(&access, vec![roots.clone()]),
                        )]);
                        let next = Arc::new(moss_module_host::linked_notes::LinkedNotesPorts::new(
                            Arc::new(moss_module_host::linked_notes::PreferenceFolders::new(
                                self.platform.app.clone(),
                                std::collections::BTreeMap::from([(
                                    ("notes".into(), "source".into()),
                                    moss_module_host::linked_notes::PreferenceFolder {
                                        preference: "notes-source-path".into(),
                                        relative_to: None,
                                    },
                                )]),
                                file_roots,
                            )?),
                            next,
                        ));
                        Ok(Arc::new(
                            moss_module_host::folder_settings::FolderSettingsPorts::new(
                                self.platform.app.clone(),
                                std::collections::BTreeMap::from([(
                                    ("notes".into(), "source".into()),
                                    moss_module_host::folder_settings::FolderSetting {
                                        path_key: "notes-source-path".into(),
                                        status_key: "notes-last-sync".into(),
                                        roots: std::collections::BTreeMap::from([(
                                            access.actor_user_id(),
                                            vec![roots],
                                        )]),
                                    },
                                )]),
                                next,
                            )?,
                        ))
                    },
                ),
            )?;
            let registry = self.root.join("registry");
            let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let files = fixture_step(
                "package files",
                moss_notes_checks::package_files(
                    &repo,
                    std::fs::read(std::env::var("NOTES_TOOL_COMPONENT")?)?,
                ),
            )?;
            let fixture = support::Registry::create(&registry, &files);
            let (root_key, first_party) = (&fixture.public, &fixture.public);
            let catalog = fixture_step(
                "refresh registry",
                application.installer.refresh(
                    &access,
                    Source::Folder(registry),
                    root_key,
                    first_party,
                    "notes-test-registry",
                ),
            )?;
            let artifact = fixture_step(
                "select package",
                catalog.select(
                    "notes",
                    None,
                    &"0.1.0".parse()?,
                    &Default::default(),
                    &Default::default(),
                ),
            )?;
            ensure!(
                artifact.digest == fixture.artifact.digest,
                "Selected package differs from fixture"
            );
            fixture_step(
                "install package",
                application
                    .installer
                    .install(&access, &catalog, artifact, true),
            )?;
            println!("PASS signed Notes registry selection, download and installation through the real module host");
            *app = Some(application);
        }
        Ok(app)
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() == Some("--certificate") {
        let folder = PathBuf::from(
            arguments
                .next()
                .ok_or_else(|| anyhow::anyhow!("Certificate folder required"))?,
        );
        return moss_network::tls::local_certificate(&folder, &arguments.collect::<Vec<_>>())
            .map_err(anyhow::Error::msg);
    }
    ensure!(
        std::env::var("JARVIS_GATE_RUN").as_deref() == Ok("1"),
        "Use scripts/run-gate.sh"
    );
    let root = PathBuf::from(std::env::var("NOTES_UI_OUT")?);
    let config_path = root.join("network.json");
    let config = Config::read(&config_path).map_err(anyhow::Error::msg)?;
    let platform = config.platform().await.map_err(anyhow::Error::msg)?;
    let (bootstrap, connection) = tokio_postgres::connect(
        &std::env::var("NOTES_UI_BOOTSTRAP_URL")?,
        tokio_postgres::NoTls,
    )
    .await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    for migration in [
        moss_module_host::postgres::MIGRATION,
        moss_module_host::migrations::MIGRATION,
        moss_platform_jobs::MIGRATION,
        moss_module_host::jobs::MIGRATION,
    ] {
        bootstrap.batch_execute(migration).await?;
    }
    let network =
        Network::new(platform.clone(), config.clone(), config_path).map_err(anyhow::Error::msg)?;
    let server = Arc::new(Server {
        application: Default::default(),
        platform,
        config: config.clone(),
        network: network.clone(),
        root: root.clone(),
        shared: root.join("shared"),
        slots: Arc::new(tokio::sync::Semaphore::new(4)),
    });
    let private = Router::new().fallback(private).with_state(server.clone());
    let private = moss_network::web::router(network, private, root.join("shared"));
    // Package/static assets are public code, not account data. Opaque-frame asset
    // requests have no account cookie and may carry Origin:null.
    let app = private
        .route("/module-ui/{*path}", get(asset).with_state(server.clone()))
        .route(
            "/module-shared/{*path}",
            get(asset).with_state(server.clone()),
        );
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    let acceptor = moss_network::tls::acceptor(&config.certificate, &config.private_key)
        .map_err(anyhow::Error::msg)?;
    std::fs::write(root.join("listening"), b"ready")?;
    moss_network::tls::serve(listener, acceptor, app)
        .await
        .map_err(anyhow::Error::msg)?;
    tokio::task::spawn_blocking(move || drop(server)).await?;
    Ok(())
}
async fn private(
    State(server): State<Arc<Server>>,
    Extension(access): Extension<AccessContext>,
    method: Method,
    uri: Uri,
    bytes: Bytes,
) -> Response {
    let Ok(permit) = server.slots.clone().acquire_owned().await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let result =
        tokio::task::spawn_blocking(move || -> Result<Response> {
            let _permit = permit;
            if uri.path() == "/host.mjs" {
                return Ok((
                    [("Content-Type", "text/javascript")],
                    include_str!("../../ui/host.mjs"),
                )
                    .into_response());
            }
            if uri.path() == "/host-bridge.mjs" {
                return Ok((
                    [("Content-Type", "text/javascript")],
                    include_str!("../../../../rust-spike/module-ui/web/host-bridge.mjs"),
                )
                    .into_response());
            }
            let app = server.installed(access.clone())?;
            let app = app.as_ref().unwrap();
            if method == Method::GET && matches!(uri.path(), "/" | "/settings/connections") {
                let screen = app
                    .installer
                    .screen(&access, "notes", "/settings/connections")?;
                let base = format!("{}/base.css", screen.src.rsplit_once('/').unwrap().0);
                let html = include_str!("../../ui/host.html")
                    .replace("__SCREEN__", &screen.src)
                    .replace("__BASE__", &base);
                return Ok(Html(html).into_response());
            }
            if uri.path().starts_with("/api/m/notes/") {
                let body = if bytes.is_empty() {
                    "null"
                } else {
                    std::str::from_utf8(&bytes)?
                };
                let reply: moss_module_sdk::Response = serde_json::from_str(
                    &app.dispatch_extended(access, method.as_str(), &uri.to_string(), body)?,
                )?;
                return Ok(json_reply(reply.status, &reply.body));
            }
            Ok(StatusCode::NOT_FOUND.into_response())
        })
        .await;
    match result {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            eprintln!("Notes fixture request failed; internal details withheld");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
async fn asset(
    State(server): State<Arc<Server>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    // Validate the configured authority and sharing policy, while accepting
    // public opaque-frame subresources without a same-origin Origin header.
    let Some(authority) = headers.get("host").and_then(|h| h.to_str().ok()) else {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    };
    let Some(origin) = server
        .config
        .origins
        .iter()
        .find(|o| o.trim_start_matches("https://") == authority)
        .cloned()
    else {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    };
    let mut authority_headers = HeaderMap::new();
    authority_headers.insert("host", headers["host"].clone());
    if let Err(status) = server
        .network
        .policy
        .check(&authority_headers, &Method::GET, peer.ip())
    {
        return StatusCode::from_u16(status).unwrap().into_response();
    }
    let result = tokio::task::spawn_blocking(move || -> Result<Response> {
        if let Some(file) = uri.path().strip_prefix("/module-shared/") {
            ensure!(
                moss_module_host::manifest::relative_path(file),
                "Invalid asset"
            );
            let bytes = std::fs::read(server.shared.join(file))?;
            return Ok((
                [
                    (
                        "Content-Type",
                        if file.ends_with(".css") {
                            "text/css"
                        } else {
                            "font/woff2"
                        },
                    ),
                    ("Access-Control-Allow-Origin", "null"),
                ],
                bytes,
            )
                .into_response());
        }
        let app = server
            .application
            .lock()
            .map_err(|_| anyhow::anyhow!("Host busy"))?;
        let app = app
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Open Notes first"))?;
        let path = uri.path().strip_prefix("/module-ui/").unwrap_or_default();
        let mut parts = path.splitn(3, '/');
        let asset = app.installer.ui_asset(
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
            &AssetPolicy::new(&origin)?,
        )?;
        let mut response = Response::new(Body::from(asset.body));
        response
            .headers_mut()
            .insert("Content-Type", asset.content_type.parse()?);
        for (name, value) in asset.headers {
            response
                .headers_mut()
                .insert(axum::http::HeaderName::try_from(name)?, value.parse()?);
        }
        Ok(response)
    })
    .await;
    match result {
        Ok(Ok(response)) => response,
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
