//! Thin session-owned adapter over the existing local signing and activation backend.
use crate::{
    module_admin::{self, Admin},
    modules,
};
use axum::{
    extract::{Path, State},
    http::{header::CACHE_CONTROL, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use moss_shell_contract::module_trust::*;
use safety_core::access::AccessContext;
use std::sync::Arc;

pub fn routes() -> Router<Arc<Admin>> {
    let routes = Router::new().route("/api/modules/trust/{id}", get(read));
    #[cfg(unix)]
    let routes = routes.merge(local::routes());
    routes
}
async fn read(
    State(admin): State<Arc<Admin>>,
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
) -> Response {
    let Some(host) = modules::host(&slot) else {
        return unavailable();
    };
    let can_manage = module_admin::require_admin(&admin, &access).await.is_ok();
    match tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ModuleTrust>> {
        // Filter through the backend's account projection before revealing any provenance.
        let Some(module) = host
            .installer
            .installed_for(&access)?
            .into_iter()
            .find(|m| m.manifest.id == id)
        else {
            return Ok(None);
        };
        let source_name = if module.local_owner.is_some() {
            "Local package".into()
        } else {
            host.installer
                .catalog_for(&access, &module.registry)
                .map(|c| c.trust.identity.name.clone())
                .unwrap_or_else(|_| module.registry.clone())
        };
        Ok(Some(ModuleTrust {
            id: module.manifest.id,
            name: module.manifest.name,
            version: module.manifest.version.to_string(),
            source: module.registry,
            source_name,
            digest: module.digest,
            local: module.local_owner.is_some(),
            can_manage: can_manage && module.local_owner.is_none(),
            fingerprint: module.local_owner.map(|_| module.publisher_key),
            notices: module
                .revocations
                .into_iter()
                .map(|n| TrustNotice {
                    source: n.source,
                    reason: n.reason,
                    level: match n.level {
                        moss_module_host::registry::RevocationLevel::Block => "block",
                        _ => "warn",
                    }
                    .into(),
                })
                .collect(),
        }))
    })
    .await
    {
        Ok(Ok(Some(view))) => ([(CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Ok(Ok(None)) => {
            module_admin::say(StatusCode::NOT_FOUND, "Module unavailable for this account")
        }
        _ => unavailable(),
    }
}
fn unavailable() -> Response {
    module_admin::say(StatusCode::UNPROCESSABLE_ENTITY,"Package unavailable; check the signed-in account, package and host key storage, then retry")
}
#[cfg(unix)]
mod local {
    use super::*;
    use axum::{extract::DefaultBodyLimit, routing::post};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use moss_module_host::{
        archive::Package,
        local_packages::{LocalPackages, Signature},
    };
    use serde::Deserialize;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        package: String,
        signature: Option<Signature>,
        #[serde(default)]
        approve: bool,
    }
    pub fn routes() -> Router<Arc<Admin>> {
        Router::new()
            .route("/api/modules/local/review", post(review))
            .route("/api/modules/local/install", post(install))
            .layer(DefaultBodyLimit::max(96 * 1024 * 1024))
    }
    async fn review(
        State(admin): State<Arc<Admin>>,
        Extension(access): Extension<AccessContext>,
        Json(input): Json<Input>,
    ) -> Response {
        if input.signature.is_some() || input.approve {
            return module_admin::say(StatusCode::BAD_REQUEST, "Review takes only a built package");
        }
        let _gate = admin.gate.lock().await;
        match tokio::task::spawn_blocking(move || -> anyhow::Result<LocalReview> {
            let bytes = STANDARD.decode(&input.package)?;
            let local = LocalPackages::host_storage();
            // Sign checks the manifest's local.<session owner> prefix and owner-only declarations.
            let signature = local.sign(&access, &bytes)?;
            let verified = local.verify(&access, &bytes, &signature)?;
            let package = Package::read(&bytes, &verified.record().digest, &"0.1.0".parse()?)?;
            Ok(LocalReview {
                id: package.manifest.id.clone(),
                name: package.manifest.name.clone(),
                version: package.manifest.version.to_string(),
                digest: package.digest,
                fingerprint: verified.trust().fingerprint.clone(),
                permissions: package
                    .manifest
                    .permissions()
                    .into_iter()
                    .map(|p| p.headline)
                    .collect(),
                signature: serde_json::to_value(signature)?,
            })
        })
        .await
        {
            Ok(Ok(view)) => ([(CACHE_CONTROL, "no-store")], Json(view)).into_response(),
            _ => unavailable(),
        }
    }
    async fn install(
        State(admin): State<Arc<Admin>>,
        Extension(slot): Extension<modules::Slot>,
        Extension(access): Extension<AccessContext>,
        Json(input): Json<Input>,
    ) -> Response {
        if !input.approve || input.signature.is_none() {
            return module_admin::say(
                StatusCode::BAD_REQUEST,
                "Review and approve this local package first",
            );
        }
        let Some(_host) = modules::host(&slot) else {
            return unavailable();
        };
        let _gate = admin.gate.lock().await;
        let instance = admin.instance.clone();
        match tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let bytes = STANDARD.decode(&input.package)?;
            let signature = input.signature.unwrap();
            LocalPackages::host_storage().verify(&access, &bytes, &signature)?;
            crate::module_package_apply::apply(
                &instance,
                &access,
                crate::module_package_apply::Input {
                    package: input.package,
                    signature: serde_json::to_value(signature)?,
                    source: None,
                },
            )
        })
        .await
        {
            Ok(Ok(())) => (
                [(CACHE_CONTROL, "no-store")],
                Json(serde_json::json!({"installed":true})),
            )
                .into_response(),
            _ => unavailable(),
        }
    }
}
