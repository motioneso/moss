//! Session-scoped display projection. Existing management and write routes remain admin-only.
use crate::{
    module_admin::{self, Admin},
    module_sources, modules,
};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use moss_module_host::{
    application::Application,
    registry::{Artifact, Catalog},
    store::Installed,
};
use moss_shell_contract::catalog_view::*;
use safety_core::access::AccessContext;
use std::{collections::BTreeMap, sync::Arc};

pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route("/api/modules/catalog-view", get(read))
        .route("/api/modules/catalog-media/{source}/{file}", get(media))
}
fn unavailable() -> Response {
    module_admin::say(
        StatusCode::SERVICE_UNAVAILABLE,
        "Modules could not be read; try again",
    )
}
async fn read(
    State(admin): State<Arc<Admin>>,
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    let Some(host) = modules::host(&slot) else {
        return unavailable();
    };
    let can_manage = module_admin::require_admin(&admin, &access).await.is_ok();
    // Opening as an admin uses the existing refresh path; members never trigger policy writes.
    if can_manage {
        let _ = crate::module_refresh::open(&admin, &slot, &access).await;
    }
    let sources = match module_sources::read(&admin.instance) {
        Ok(s) => s,
        Err(_) => return unavailable(),
    };
    let failures: Vec<String> = {
        let report = admin
            .refresh_report
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sources
            .iter()
            .filter(|s| report.as_ref().is_some_and(|r| r.error(&s.id).is_some()))
            .map(|s| s.id.clone())
            .collect()
    };
    match tokio::task::spawn_blocking(move || {
        let mut view = project(host, &access, sources, can_manage)?;
        for source in &mut view.sources {
            if failures.contains(&source.id) {
                source.error = Some("Registry unavailable. Try again.".into());
            }
        }
        Ok::<_, anyhow::Error>(view)
    })
    .await
    {
        Ok(Ok(view)) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        _ => unavailable(),
    }
}
fn project(
    host: Arc<Application>,
    access: &AccessContext,
    sources: Vec<module_sources::Registry>,
    can_manage: bool,
) -> anyhow::Result<CatalogView> {
    let installed = host.installer.installed_for(access)?;
    let activity = host.installer.activity_for(access)?;
    let mut view = CatalogView {
        modules: vec![],
        sources: vec![],
        management: can_manage.then(Vec::new),
    };
    for source in sources {
        match host.installer.catalog_for(access, &source.id) {
            Ok(catalog) => {
                let name = catalog.trust.identity.name.clone();
                // One offer per source and module: the newest stable version compatible with this host.
                let mut offers = BTreeMap::<String, &Artifact>::new();
                for artifact in &catalog.index.modules {
                    if artifact.channel != moss_module_host::registry::Channel::Stable
                        || !artifact.requires_moss.matches(&"0.1.0".parse()?)
                    {
                        continue;
                    }
                    if offers
                        .get(&artifact.id)
                        .is_none_or(|old| old.version < artifact.version)
                    {
                        offers.insert(artifact.id.clone(), artifact);
                    }
                }
                for artifact in offers.values() {
                    let active = installed
                        .iter()
                        .find(|m| m.manifest.id == artifact.id && m.registry == source.id);
                    let mut module = entry(&catalog, artifact, active, &source.first_party_key);
                    if let Some(active) = active {
                        let enabled = host.installer.switch_state(access, &artifact.id)?.enabled;
                        module.enabled = Some(enabled);
                        module.status = status(active, enabled);
                        module.settings_path = settings(active, can_manage);
                        module.activity = activity
                            .iter()
                            .rev()
                            .filter(|e| e.module == artifact.id && e.source == source.id)
                            .take(8)
                            .map(|e| RecentActivity {
                                at: e.at.to_rfc3339(),
                                label: e.reason.clone(),
                                source: name.clone(),
                            })
                            .collect();
                        if let Some(controls) = &mut view.management {
                            controls.push(ModuleControl {
                                id: artifact.id.clone(),
                                source: source.id.clone(),
                                on_for_everyone: active.disabled.is_none(),
                                pin: active.pin.as_ref().map(ToString::to_string),
                            });
                        }
                    }
                    view.modules.push(module);
                }
                view.sources.push(SourceView {
                    id: source.id,
                    name,
                    error: None,
                });
            }
            Err(_) => view.sources.push(SourceView {
                id: source.id.clone(),
                name: source.id,
                error: Some("Registry unavailable. Try again.".into()),
            }),
        }
    }
    // Installed records remain visible when their source is offline, removed, or no longer offers them.
    for active in &installed {
        if view
            .modules
            .iter()
            .any(|m| m.id == active.manifest.id && m.source == active.registry)
        {
            continue;
        }
        let name = if active.local_owner.is_some() {
            "Local package".into()
        } else {
            active.registry.clone()
        };
        let enabled = host
            .installer
            .switch_state(access, &active.manifest.id)?
            .enabled;
        view.modules.push(ModuleView {
            id: active.manifest.id.clone(),
            source: active.registry.clone(),
            source_name: name,
            name: active.manifest.name.clone(),
            description: active.manifest.description.clone(),
            publisher: active.manifest.publisher.clone(),
            first_party: false,
            category: String::new(),
            version: active.manifest.version.to_string(),
            installed_version: Some(active.manifest.version.to_string()),
            enabled: Some(enabled),
            supports_user_disable: active.manifest.accounts.supports_user_disable,
            status: status(active, enabled),
            update_available: false,
            pinned: active.pin.is_some(),
            changelog: String::new(),
            permissions: active
                .manifest
                .permissions()
                .into_iter()
                .map(|p| p.headline)
                .collect(),
            screenshots: vec![],
            activity: vec![],
            settings_path: settings(active, can_manage),
        });
        if active.local_owner.is_none() {
            if let Some(controls) = &mut view.management {
                controls.push(ModuleControl {
                    id: active.manifest.id.clone(),
                    source: active.registry.clone(),
                    on_for_everyone: active.disabled.is_none(),
                    pin: active.pin.as_ref().map(ToString::to_string),
                });
            }
        }
    }
    view.modules
        .sort_by(|a, b| a.name.cmp(&b.name).then(a.source.cmp(&b.source)));
    Ok(view)
}
fn status(active: &Installed, enabled: bool) -> String {
    if !active.revocations.is_empty()
        && active
            .revocations
            .iter()
            .any(|r| r.level == moss_module_host::registry::RevocationLevel::Block)
    {
        "Blocked"
    } else if active.disabled.is_some() {
        "Off for everyone"
    } else if !enabled {
        "Off for you"
    } else {
        "Up to date"
    }
    .into()
}
fn settings(active: &Installed, can_manage: bool) -> Option<String> {
    active
        .manifest
        .settings
        .iter()
        .find(|s| can_manage || s["scope"] == "user")
        .and_then(|s| s["path"].as_str())
        .filter(|p| p.starts_with('/') && !p.starts_with("//"))
        .map(str::to_owned)
}
fn entry(
    catalog: &Catalog,
    artifact: &Artifact,
    active: Option<&Installed>,
    first_party_key: &str,
) -> ModuleView {
    let presentation = artifact.presentation.as_ref();
    ModuleView {
        id: artifact.id.clone(),
        source: catalog.trust.identity.id.clone(),
        source_name: catalog.trust.identity.name.clone(),
        name: presentation
            .map(|p| p.name.clone())
            .or_else(|| active.map(|m| m.manifest.name.clone()))
            .unwrap_or(artifact.id.clone()),
        description: presentation
            .map(|p| p.description.clone())
            .or_else(|| active.map(|m| m.manifest.description.clone()))
            .unwrap_or_default(),
        publisher: presentation
            .map(|p| p.publisher.clone())
            .or_else(|| active.map(|m| m.manifest.publisher.clone()))
            .unwrap_or(artifact.publisher_key.clone()),
        first_party: catalog
            .trust
            .publisher(&artifact.publisher_key, &artifact.id)
            .is_ok_and(|p| p.key == first_party_key),
        category: presentation.map(|p| p.category.clone()).unwrap_or_default(),
        version: artifact.version.to_string(),
        installed_version: active.map(|m| m.manifest.version.to_string()),
        enabled: None,
        supports_user_disable: active.is_some_and(|m| m.manifest.accounts.supports_user_disable),
        status: active
            .map(|m| status(m, true))
            .unwrap_or("Available".into()),
        update_available: active
            .is_some_and(|m| m.digest != artifact.digest && m.manifest.version < artifact.version),
        pinned: active.is_some_and(|m| m.pin.is_some()),
        changelog: artifact.changelog.clone(),
        permissions: active
            .map(|m| {
                m.manifest
                    .permissions()
                    .into_iter()
                    .map(|p| p.headline)
                    .collect()
            })
            .unwrap_or_else(|| {
                artifact
                    .capabilities
                    .iter()
                    .map(|c| {
                        format!(
                            "{}: {}",
                            c.port,
                            c.operations.iter().cloned().collect::<Vec<_>>().join(", ")
                        )
                    })
                    .collect()
            }),
        screenshots: presentation
            .into_iter()
            .flat_map(|p| p.screenshots.iter())
            .map(|s| Preview {
                url: format!(
                    "/api/modules/catalog-media/{}/{}",
                    catalog.trust.identity.id, s.file
                ),
                caption: s.caption.clone(),
            })
            .collect(),
        activity: vec![],
        settings_path: active.and_then(|m| settings(m, false)),
    }
}
async fn media(
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
    Path((source, file)): Path<(String, String)>,
) -> Response {
    let Some(host) = modules::host(&slot) else {
        return unavailable();
    };
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let catalog = host.installer.catalog_for(&access, &source)?;
        anyhow::ensure!(
            catalog
                .index
                .modules
                .iter()
                .filter_map(|a| a.presentation.as_ref())
                .flat_map(|p| &p.screenshots)
                .any(|s| s.file == file),
            "Unknown screenshot"
        );
        let bytes = catalog
            .source
            .fetch(&format!("media/{file}"), 4 * 1024 * 1024)?;
        let (digest, extension) = file.rsplit_once('.').unwrap_or_default();
        anyhow::ensure!(
            moss_module_host::trust::digest(&bytes) == digest,
            "Screenshot digest mismatch"
        );
        let mime = match extension {
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "webp" => "image/webp",
            _ => anyhow::bail!("Unsupported image"),
        };
        Ok((mime, bytes))
    })
    .await;
    match result {
        Ok(Ok((mime, bytes))) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "private, max-age=3600"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        _ => module_admin::say(StatusCode::NOT_FOUND, "Screenshot unavailable"),
    }
}
