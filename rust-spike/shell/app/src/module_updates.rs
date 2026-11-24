//! Installed registry module updates reuse the digest-bound management operation journal.
use crate::{
    module_admin::{self, Admin},
    module_management, module_sources,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Extension, Json, Router,
};
use moss_shell_contract::module_management::{
    ExecuteModule, PinModule, ReviewModule, SkipModuleUpdate, UpdateModule,
};
use safety_core::access::AccessContext;
use std::sync::Arc;

pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route("/api/modules/update-review", post(review))
        .route("/api/modules/{module}/update", post(update))
        .route("/api/modules/{module}/skip", post(skip))
        .route("/api/modules/{module}/pin", post(pin))
}
async fn review(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(pick): Json<ReviewModule>,
) -> Response {
    module_management::review_selected(admin, access, pick, true).await
}
async fn update(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(module): Path<String>,
    Json(pick): Json<UpdateModule>,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    let record = match module_management::owned(&admin, &access, &pick.operation) {
        Ok(record) => record,
        Err(response) => return response,
    };
    if !record
        .view
        .review
        .as_ref()
        .is_some_and(|review| review.module == module && review.previous.is_some())
    {
        return module_admin::say(
            StatusCode::BAD_REQUEST,
            "Review this installed module before updating",
        );
    }
    module_management::execute(
        State(admin),
        Extension(access),
        Path(pick.operation),
        Json(ExecuteModule {
            approve: pick.approve,
        }),
    )
    .await
}
async fn skip(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(module): Path<String>,
    Json(pick): Json<SkipModuleUpdate>,
) -> Response {
    if !moss_module_host::trust::valid_digest(&pick.digest) {
        return module_admin::say(StatusCode::BAD_REQUEST, "Invalid skipped digest");
    }
    policy(
        admin,
        access,
        module,
        pick.source,
        vec!["--skip-digest".into(), pick.digest],
    )
    .await
}
async fn pin(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(module): Path<String>,
    Json(pick): Json<PinModule>,
) -> Response {
    policy(
        admin,
        access,
        module,
        pick.source,
        match pick.version {
            Some(version) => vec!["--pin-version".into(), version],
            None => vec!["--unpin".into()],
        },
    )
    .await
}
async fn policy(
    admin: Arc<Admin>,
    access: AccessContext,
    module: String,
    source: String,
    extra: Vec<String>,
) -> Response {
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    if !module_admin::valid_name(&module) {
        return module_admin::say(StatusCode::BAD_REQUEST, "Invalid module name");
    }
    let Ok(source) = module_sources::select(&admin.instance, Some(&source)) else {
        return module_admin::say(
            StatusCode::BAD_REQUEST,
            "The source registry is not configured",
        );
    };
    let instance = admin.instance.clone();
    let actor = access.actor_user_id().to_string();
    match tokio::task::spawn_blocking(move || module_admin::run_json(&instance, &source, &extra, &[module], &actor)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(_)) => module_admin::say(StatusCode::UNPROCESSABLE_ENTITY, "The module update choice could not be saved; check the installed version and source, then try again"),
        Err(_) => module_admin::say(StatusCode::INTERNAL_SERVER_ERROR, "The installer stopped"),
    }
}
