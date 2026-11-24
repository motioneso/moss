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
use safety_core::{access::AccessContext, db::DataContext};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path as FsPath, sync::Arc};

const PENDING: &str = "pending-registries.json";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Add {
    registry: Location,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Location {
    id: String,
    folder: Option<std::path::PathBuf>,
    url: Option<String>,
    root_key: String,
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
// This is install-wide authority provisioned by the host, never an uploaded registry field.
fn first_party_key(instance: &FsPath) -> Result<String> {
    let path = instance.join("registry-first-party-key.json");
    if path.exists() {
        return Ok(serde_json::from_slice(
            &private_read(&path).map_err(anyhow::Error::msg)?,
        )?);
    }
    let configured = sources(instance)?;
    let mut keys = configured
        .iter()
        .map(|r| &r.first_party_key)
        .filter(|key| !key.is_empty());
    let Some(key) = keys.next() else {
        // Without provisioned first-party authority, nonempty validated publisher keys
        // cannot match this value. Namespaced third-party sources can still be added.
        return Ok(String::new());
    };
    ensure!(
        keys.all(|other| other == key),
        "Host first-party keys disagree"
    );
    let key = key.clone();
    ensure!(
        STANDARD.decode(&key)?.len() == 32,
        "Invalid host first-party key"
    );
    private_write(&path, &serde_json::to_vec(&key)?).map_err(anyhow::Error::msg)?;
    Ok(key)
}
type History = BTreeMap<String, SeenRegistry>;
async fn history(admin: &Admin, access: &AccessContext) -> Result<History> {
    let cx = DataContext::open(&admin.platform.app, access)
        .await
        .map_err(|_| anyhow::anyhow!("Cannot read registry configuration history"))?;
    let present: bool = cx
        .db()
        .query_one(
            "SELECT to_regclass('moss_modules.catalog') IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    if !present {
        return Ok(BTreeMap::new());
    }
    // Read configuration history only; sealed private activation records are not selected.
    let row = cx
        .db()
        .query_opt(
            "SELECT state->'registries' FROM moss_modules.catalog WHERE id=true",
            &[],
        )
        .await?;
    Ok(match row {
        Some(row) => serde_json::from_value(row.get(0))?,
        None => BTreeMap::new(),
    })
}
fn checked(source: &Registry, history: &History) -> Result<Catalog> {
    Ok(checked_catalog(source, history)?.0)
}
fn checked_catalog(source: &Registry, history: &History) -> Result<(Catalog, SeenRegistry)> {
    let mut seen = history.get(&source.id).cloned().unwrap_or_default();
    let catalog = Catalog::fetch(
        source.source()?,
        &source.root_key,
        &source.first_party_key,
        &mut seen,
    )?;
    ensure!(
        catalog.trust.identity.id == source.id,
        "Registry identity differs"
    );
    Ok((catalog, seen))
}

/// Advisory offer check only: approval still refreshes and validates the authoritative host history.
/// Reading a signed configured source does not grant the member catalog administration power.
pub(crate) fn requestable(instance: &FsPath, source: &str, module: &str) -> Result<bool> {
    if module.starts_with("local.") {
        return Ok(false);
    }
    let source = module_sources::select(instance, Some(source))?;
    let (catalog, seen) = checked_catalog(&source, &History::new())?;
    let offer = catalog
        .index
        .modules
        .iter()
        .filter(|offer| {
            offer.id == module && offer.channel == moss_module_host::registry::Channel::Stable
        })
        .max_by_key(|offer| &offer.version);
    let Some(offer) = offer else { return Ok(false) };
    Ok(catalog.index.expires > chrono::Utc::now()
        && !seen.blocks_package(
            &offer.digest,
            &offer.publisher_key,
            &catalog
                .trust
                .publisher(&offer.publisher_key, &offer.id)?
                .key,
        ))
}
fn stage(instance: &FsPath, source: Registry, history: &History) -> Result<Value> {
    module_sources::decode(&serde_json::to_vec(&json!({"registries":[&source]}))?)?;
    ensure!(
        !sources(instance)?.iter().any(|r| r.id == source.id),
        "Registry already configured"
    );
    let catalog = checked(&source, history)?;
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
        "Registry refused; check host first-party trust, signed files, publisher and root fingerprint, then try again",
    )
}
async fn work<F>(admin: Arc<Admin>, access: AccessContext, task: F) -> Response
where
    F: FnOnce(&FsPath, &History) -> Result<Value> + Send + 'static,
{
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    let instance = admin.instance.clone();
    let lock = match tokio::task::spawn_blocking(move || -> Result<std::fs::File> {
        let lock = crate::module_operation::lock_file(&instance.join("module-install.lock"))?;
        lock.lock()?;
        Ok(lock)
    })
    .await
    {
        Ok(Ok(lock)) => lock,
        _ => return refused(),
    };
    let history = match history(&admin, &access).await {
        Ok(history) => history,
        Err(_) => return refused(),
    };
    let instance = admin.instance.clone();
    match tokio::task::spawn_blocking(move || {
        let _lock = lock;
        task(&instance, &history)
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
    work(admin, access, move |instance, history| {
        stage(
            instance,
            Registry {
                id: input.registry.id,
                folder: input.registry.folder,
                url: input.registry.url,
                root_key: input.registry.root_key,
                first_party_key: first_party_key(instance)?,
            },
            history,
        )
    })
    .await
}
async fn confirm(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    Json(input): Json<Confirm>,
) -> Response {
    work(admin, access, move |instance, history| {
        let mut staged = pending(instance)?;
        let source = staged
            .iter()
            .find(|r| r.id == id)
            .context("No pending registry")?
            .clone();
        let catalog = checked(&source, history)?;
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
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    let actor = access.actor_user_id().to_string();
    let instance = admin.instance.clone();
    match tokio::task::spawn_blocking(move || -> Result<Value> {
        ensure!(
            moss_module_host::manifest::identifier(&id),
            "Invalid registry ID"
        );
        {
            let lock = crate::module_operation::lock_file(&instance.join("module-install.lock"))?;
            lock.lock()?;
            first_party_key(&instance)?;
            let mut trusted = sources(&instance)?;
            trusted.retain(|r| r.id != id);
            module_sources::write(&instance, &trusted)?;
            let mut staged = pending(&instance)?;
            staged.retain(|r| r.id != id);
            save_pending(&instance, &staged)?;
        }
        // The child has its own instance fence and rechecks the session actor. Remove the
        // persisted host configuration too, so later refresh cannot resurrect this source.
        // This mode never fetches source metadata, including for a pending or offline root.
        let source = Registry {
            id: id.clone(),
            folder: Some(instance.clone()),
            url: None,
            root_key: String::new(),
            first_party_key: String::new(),
        };
        module_admin::run_json(
            &instance,
            &source,
            &["--remove-registry".into()],
            &[],
            &actor,
        )
        .map_err(anyhow::Error::msg)?;
        Ok(json!({"id":id,"removed":true}))
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        _ => refused(),
    }
}

async fn list(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    work(admin, access, move |instance, history| {
        let mut views = vec![];
        for (registries, confirmed) in [(sources(instance)?, true), (pending(instance)?, false)] {
            for source in registries {
                let result = checked(&source, history);
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
    work(admin, access, move |instance, history| {
        ensure!(
            moss_module_host::manifest::identifier(&input.id),
            "Invalid registry ID"
        );
        // A new host-owned directory prevents overwriting a configured source or following a
        // caller-selected destination. Vault confines every uploaded relative file name.
        let parent = vault::Root::create(&instance.join("registry-imports"))?;
        let folder = parent.create_subdir(&uuid::Uuid::new_v4().to_string())?;
        let result = (|| {
            let mut total = 0;
            for (name, encoded) in input.files {
                let bytes = STANDARD.decode(encoded)?;
                total += bytes.len();
                ensure!(total <= 64 * 1024 * 1024, "Registry file too large");
                if let Some(file) = name.strip_prefix("packages/") {
                    let digest = file
                        .strip_suffix(".sig")
                        .unwrap_or(file)
                        .strip_suffix(".mosspkg")
                        .context("Invalid package name")?;
                    ensure!(trust::valid_digest(digest), "Invalid package digest");
                    folder.create_subdir("packages")?.write(file, &bytes)?;
                } else if let Some(file) = name.strip_prefix("media/") {
                    let (digest, extension) = file.split_once('.').context("Invalid media name")?;
                    ensure!(
                        trust::valid_digest(digest)
                            && !extension.is_empty()
                            && extension
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                            && trust::digest(&bytes) == digest,
                        "Invalid media digest"
                    );
                    folder.create_subdir("media")?.write(file, &bytes)?;
                } else {
                    ensure!(
                        [
                            "registry.json",
                            "registry.json.sig",
                            "index.json",
                            "index.json.sig",
                            "bundle.json",
                            "bundle.json.sig"
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
                first_party_key: first_party_key(instance)?,
            };
            // Mirror validation includes content hashes; ordinary expired-index rules still
            // apply when a person later installs from an imported bundle.
            let catalog = checked(&source, history)?;
            let bundle = folder.path().join("bundle.json").exists();
            let signature = folder.path().join("bundle.json.sig").exists();
            ensure!(bundle == signature, "Bundle needs its signature");
            if bundle {
                catalog.verify_bundle(
                    &catalog
                        .source
                        .fetch("bundle.json", moss_module_host::registry::MAX_INDEX)?,
                    &catalog.source.fetch("bundle.json.sig", 4096)?,
                )?;
            }

            for artifact in &catalog.index.modules {
                let name = format!("packages/{}.mosspkg", artifact.digest);
                let signature = format!("{name}.sig");
                if folder.path().join(&signature).exists() {
                    catalog.trust.verify_package(
                        &artifact.publisher_key,
                        &artifact.id,
                        &artifact.digest,
                        std::str::from_utf8(&catalog.source.fetch(&signature, 4096)?)?,
                    )?;
                }
                if folder.path().join(&name).exists() {
                    let bytes = catalog.source.fetch(&name, artifact.size)?;
                    ensure!(
                        bytes.len() as u64 == artifact.size
                            && trust::digest(&bytes) == artifact.digest,
                        "Wrong package bytes"
                    );
                }
            }
            stage(instance, source, history)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(folder.path());
        }
        result
    })
    .await
}
