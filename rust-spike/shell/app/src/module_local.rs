#[cfg(unix)]
pub use platform::routes;
#[cfg(not(unix))]
pub fn routes() -> axum::Router<std::sync::Arc<crate::module_admin::Admin>> {
    async fn unavailable() -> impl axum::response::IntoResponse {
        (
            axum::http::StatusCode::NOT_IMPLEMENTED,
            axum::Json(
                serde_json::json!({"error":"Local signing is unavailable on this platform"}),
            ),
        )
    }
    axum::Router::new()
        .route("/api/modules/local/sign", axum::routing::post(unavailable))
        .route(
            "/api/modules/local/verify",
            axum::routing::post(unavailable),
        )
}
#[cfg(unix)]
mod platform {
    // Local signing takes its account from authenticated middleware, never package input.
    // This slice records trust only; it does not activate packages or expose their contents.
    use crate::module_admin::{say, Admin};
    use axum::{
        extract::{DefaultBodyLimit, State},
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::post,
        Extension, Json, Router,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use moss_module_host::local_packages::{self, LocalPackages, Signature};
    use safety_core::access::AccessContext;
    use serde::Deserialize;
    use std::sync::Arc;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        package: String,
        signature: Option<Signature>,
    }
    pub fn routes() -> Router<Arc<Admin>> {
        Router::new()
            .route("/api/modules/local/sign", post(sign))
            .route("/api/modules/local/verify", post(verify))
            .layer(DefaultBodyLimit::max(
                (((moss_module_host::archive::MAX_PACKAGE + 2) / 3) * 4 + 1024 * 1024) as usize,
            ))
    }
    async fn sign(
        State(admin): State<Arc<Admin>>,
        Extension(access): Extension<AccessContext>,
        Json(input): Json<Request>,
    ) -> Response {
        if input.signature.is_some() {
            return say(StatusCode::BAD_REQUEST, "Signing does not take a signature");
        }
        run(admin, access, input, true).await
    }
    async fn verify(
        State(admin): State<Arc<Admin>>,
        Extension(access): Extension<AccessContext>,
        Json(input): Json<Request>,
    ) -> Response {
        if input.signature.is_none() {
            return say(StatusCode::BAD_REQUEST, "Verification needs a signature");
        }
        run(admin, access, input, false).await
    }
    // Bootstrap fixed host SQL through the existing one-shot supervisor, never package SQL.
    async fn ensure_catalog(admin: &Admin, access: &AccessContext) -> anyhow::Result<()> {
        let cx = safety_core::db::DataContext::open(&admin.platform.app, access)
            .await
            .map_err(|_| anyhow::anyhow!("Cannot check local catalog"))?;
        let present: bool = cx.db().query_one("SELECT to_regclass('moss_modules.local_packages') IS NOT NULL AND to_regclass('moss_modules.local_trust') IS NOT NULL", &[]).await?.get(0);
        cx.commit()
            .await
            .map_err(|_| anyhow::anyhow!("Cannot finish local catalog check"))?;
        if present {
            return Ok(());
        }
        let instance = admin.instance.clone();
        let (url, _fence) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let fence = crate::module_operation::lock_file(&instance.join("module-install.lock"))?;
            fence.lock()?;
            let url = crate::module_admin::elevated_url(&instance).map_err(anyhow::Error::msg)?;
            Ok((url, fence))
        })
        .await??;
        crate::module_install::prepare_host_schema(&url).await?;
        Ok(())
    }
    async fn run(
        admin: Arc<Admin>,
        access: AccessContext,
        input: Request,
        signing: bool,
    ) -> Response {
        let _gate = admin.gate.lock().await;
        let Ok(bytes) = STANDARD.decode(&input.package) else {
            return say(StatusCode::BAD_REQUEST, "Invalid package encoding");
        };
        let actor = access.clone();
        let result = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let local = LocalPackages::host_storage();
            let signature = if signing {
                local.sign(&actor, &bytes)?
            } else {
                input.signature.unwrap()
            };
            let verified = local.verify(&actor, &bytes, &signature)?;
            Ok((signature, verified))
        })
        .await;
        match result {
        Ok(Ok((signature, verified))) => {
            if ensure_catalog(&admin, &access).await.is_err() {
                return say(StatusCode::UNPROCESSABLE_ENTITY, "Local package catalog is unavailable; check the host database supervisor");
            }
            if let Err(error) = local_packages::record(&admin.platform.app, &access, &verified).await {
                // Do not relay database errors or internal configuration to the browser.
                let _ = error;
                return say(StatusCode::UNPROCESSABLE_ENTITY, "Local package catalog refused this package");
            }
            Json(serde_json::json!({"signature":signature,"record":verified.record()})).into_response()
        }
        Ok(Err(_)) => say(StatusCode::UNPROCESSABLE_ENTITY, "Local package refused: check the account prefix, install signature, package bytes, imports and SQL; unlock host secret storage before signing"),
        Err(_) => say(StatusCode::INTERNAL_SERVER_ERROR, "Local package validation stopped"),
    }
    }
}
