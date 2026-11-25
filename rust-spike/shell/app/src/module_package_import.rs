//! Administrator-only adapter: verify uploaded bytes against saved root trust before storage.
use crate::{
    module_admin::{self, Admin},
    modules,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header::CACHE_CONTROL, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Extension, Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{archive::Package, trust};
use moss_shell_contract::module_trust::PackageReview;
use safety_core::access::AccessContext;
use serde::Deserialize;
use std::sync::Arc;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    source: String,
    package: String,
    signature: String,
    #[serde(default)]
    approve: bool,
}
pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route("/api/modules/packages/import", post(import))
        .layer(DefaultBodyLimit::max(96 * 1024 * 1024))
}
async fn import(
    State(admin): State<Arc<Admin>>,
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
    Json(input): Json<Input>,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    let Some(host) = modules::host(&slot) else {
        return refused();
    };
    let _gate = admin.gate.lock().await;
    match tokio::task::spawn_blocking(move || -> anyhow::Result<PackageReview> {
        let bytes = STANDARD.decode(&input.package)?;
        let catalog = host.installer.saved_catalog(&access, &input.source)?;
        let digest = trust::digest(&bytes);
        let package = Package::read(&bytes, &digest, &"0.1.0".parse()?)?;
        let offer = catalog
            .index
            .modules
            .iter()
            .find(|a| a.digest == digest && a.id == package.manifest.id)
            .ok_or_else(|| anyhow::anyhow!("Package not in trusted index"))?;
        catalog.trust.verify_package(
            &offer.publisher_key,
            &package.manifest.id,
            &digest,
            input.signature.trim(),
        )?;
        // import_file rechecks current trust, revocations and compatibility before staging bytes.
        if input.approve {
            host.installer.import_file(
                &access,
                &catalog,
                &bytes,
                input.signature.trim(),
                &offer.publisher_key,
                true,
            )?;
        }
        Ok(PackageReview {
            id: package.manifest.id.clone(),
            name: package.manifest.name.clone(),
            version: package.manifest.version.to_string(),
            source: catalog.trust.identity.name.clone(),
            digest,
            fingerprint: catalog.trust.identity.root_fingerprint.clone(),
            permissions: package
                .manifest
                .permissions()
                .into_iter()
                .map(|p| p.headline)
                .collect(),
            installed: input.approve,
        })
    })
    .await
    {
        Ok(Ok(view)) => ([(CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        _ => refused(),
    }
}
fn refused() -> Response {
    module_admin::say(
        StatusCode::UNPROCESSABLE_ENTITY,
        "Package refused; check the trusted registry, package and signature, then retry",
    )
}
