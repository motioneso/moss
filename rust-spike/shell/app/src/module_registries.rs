//! Admin configuration. Pending roots never enter the installer's trusted source list.
use crate::{
    module_admin::{self, Admin},
    module_sources::{self, Registry},
};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    registry::{Catalog, SeenRegistry},
    trust,
};
use moss_network::config::{private_read, private_write};
use safety_core::access::AccessContext;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path as FsPath, sync::Arc};

const PENDING: &str = "pending-registries.json";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Add {
    registry: Registry,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirm {
    fingerprint: String,
}
/// The uploaded file is a JSON envelope of signed registry documents and optional package
/// blobs, base64 encoded. No caller-supplied host path is accepted for uploaded content.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    id: String,
    root_key: String,
    first_party_key: String,
    files: BTreeMap<String, String>,
}

pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route("/api/modules/registries", get(list).post(add))
        .route("/api/modules/registries/import", post(import))
        .route("/api/modules/registries/{id}/confirm", post(confirm))
        .route(
            "/api/modules/registries/{id}",
            axum::routing::delete(remove),
        )
        .layer(DefaultBodyLimit::max(96 * 1024 * 1024))
}
fn pending(instance: &FsPath) -> Result<Vec<Registry>> {
    let path = instance.join(PENDING);
    if !path.exists() {
        return Ok(vec![]);
    }
    Ok(serde_json::from_slice(
        &private_read(&path).map_err(anyhow::Error::msg)?,
    )?)
}
fn save_pending(instance: &FsPath, sources: &[Registry]) -> Result<()> {
    private_write(&instance.join(PENDING), &serde_json::to_vec(sources)?)
        .map_err(anyhow::Error::msg)
}
fn sources(instance: &FsPath) -> Result<Vec<Registry>> {
    if !instance.join(module_admin::REGISTRY_FILE).exists() {
        return Ok(vec![]);
    }
    module_sources::read(instance)
}
fn checked(source: &Registry) -> Result<Catalog> {
    let catalog = Catalog::fetch(
        source.source()?,
        &source.root_key,
        &source.first_party_key,
        &mut SeenRegistry::default(),
    )?;
    ensure!(
        catalog.trust.identity.id == source.id,
        "Registry identity differs"
    );
    Ok(catalog)
}
fn stage(instance: &FsPath, source: Registry) -> Result<Value> {
    module_sources::decode(&serde_json::to_vec(&json!({"registries":[&source]}))?)?;
    ensure!(
        !sources(instance)?.iter().any(|r| r.id == source.id),
        "Registry already configured"
    );
    let catalog = checked(&source)?;
    let mut staged = pending(instance)?;
    ensure!(
        staged.len() < 16 && !staged.iter().any(|r| r.id == source.id),
        "Registry already pending or limit reached"
    );
    let view = json!({"id":source.id,"name":catalog.trust.identity.name,"fingerprint":catalog.trust.identity.root_fingerprint,"confirmed":false});
    staged.push(source);
    save_pending(instance, &staged)?;
    Ok(view)
}
fn refused() -> Response {
    module_admin::say(
        StatusCode::UNPROCESSABLE_ENTITY,
        "Registry refused; check the signed files, publisher and root fingerprint, then try again",
    )
}
async fn work<F>(admin: Arc<Admin>, access: AccessContext, task: F) -> Response
where
    F: FnOnce(&FsPath) -> Result<Value> + Send + 'static,
{
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    let instance = admin.instance.clone();
    match tokio::task::spawn_blocking(move || {
        let lock = crate::module_operation::lock_file(&instance.join("module-install.lock"))?;
        lock.lock()?;
        task(&instance)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        _ => refused(),
    }
}
async fn add(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(input): Json<Add>,
) -> Response {
    work(admin, access, move |instance| {
        stage(instance, input.registry)
    })
    .await
}
async fn confirm(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    Json(input): Json<Confirm>,
) -> Response {
    work(admin, access, move |instance| {
        let mut staged = pending(instance)?;
        let source = staged
            .iter()
            .find(|r| r.id == id)
            .context("No pending registry")?
            .clone();
        let catalog = checked(&source)?;
        ensure!(
            input.fingerprint == catalog.trust.identity.root_fingerprint,
            "Confirm the actual root fingerprint"
        );
        let mut trusted = sources(instance)?;
        ensure!(!trusted.iter().any(|r| r.id == id), "Already configured");
        trusted.push(source);
        module_sources::write(instance, &trusted)?;
        staged.retain(|r| r.id != id);
        save_pending(instance, &staged)?;
        Ok(json!({"id":id,"confirmed":true}))
    })
    .await
}
async fn remove(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
) -> Response {
    work(admin, access, move |instance| {
        let mut trusted = sources(instance)?;
        trusted.retain(|r| r.id != id);
        module_sources::write(instance, &trusted)?;
        let mut staged = pending(instance)?;
        staged.retain(|r| r.id != id);
        save_pending(instance, &staged)?;
        // Signed replay/revocation history and installed modules are retained by the host.
        Ok(json!({"id":id,"removed":true}))
    })
    .await
}
async fn list(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    work(admin, access, move |instance| {
        let mut views = vec![];
        for (registries, confirmed) in [(sources(instance)?, true), (pending(instance)?, false)] {
            for source in registries {
                let result = checked(&source);
                let (name, fingerprint, health) = match result {
                    Ok(catalog) => (catalog.trust.identity.name, catalog.trust.identity.root_fingerprint,
                        if catalog.index.expires <= chrono::Utc::now() {"expired"} else {"healthy"}),
                    Err(_) => ("Unavailable registry".into(), trust::digest(&STANDARD.decode(&source.root_key)?), "unavailable"),
                };
                views.push(json!({"id":source.id,"name":name,"fingerprint":fingerprint,"confirmed":confirmed,"health":health}));
            }
        }
        Ok(json!({"registries":views}))
    }).await
}
async fn import(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(input): Json<Import>,
) -> Response {
    work(admin, access, move |instance| {
        ensure!(
            moss_module_host::manifest::identifier(&input.id),
            "Invalid registry ID"
        );
        // A new host-owned directory prevents overwriting a configured source or following a
        // caller-selected destination. Vault confines every uploaded relative file name.
        let parent = vault::Root::create(instance.join("registry-imports"))?;
        let folder = parent.create_subdir(&uuid::Uuid::new_v4().to_string())?;
        let result = (|| {
            let mut total = 0;
            for (name, encoded) in input.files {
                let bytes = STANDARD.decode(encoded)?;
                total += bytes.len();
                ensure!(total <= 64 * 1024 * 1024, "Registry file too large");
                if let Some(file) = name.strip_prefix("packages/") {
                    let digest = file
                        .strip_suffix(".mosspkg")
                        .context("Invalid package name")?;
                    ensure!(trust::valid_digest(digest), "Invalid package digest");
                    folder.create_subdir("packages")?.write(file, &bytes)?;
                } else {
                    ensure!(
                        [
                            "registry.json",
                            "registry.json.sig",
                            "index.json",
                            "index.json.sig"
                        ]
                        .contains(&name.as_str()),
                        "Unexpected registry file"
                    );
                    folder.write(&name, &bytes)?;
                }
            }
            let source = Registry {
                id: input.id,
                folder: Some(folder.path().into()),
                url: None,
                root_key: input.root_key,
                first_party_key: input.first_party_key,
            };
            // Mirror validation includes content hashes; ordinary expired-index rules still
            // apply when a person later installs from an imported bundle.
            let catalog = checked(&source)?;
            for artifact in &catalog.index.modules {
                let name = format!("packages/{}.mosspkg", artifact.digest);
                if folder.path().join(&name).exists() {
                    let bytes = catalog.source.fetch(&name, artifact.size)?;
                    ensure!(
                        bytes.len() as u64 == artifact.size
                            && trust::digest(&bytes) == artifact.digest,
                        "Wrong package bytes"
                    );
                }
            }
            stage(instance, source)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(folder.path());
        }
        result
    })
    .await
}
