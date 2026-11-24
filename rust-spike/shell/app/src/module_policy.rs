//! Switches use the session actor and the existing host activation checks.
use crate::{
    module_admin::{self, Admin},
    modules,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use moss_module_host::{application::Application, module_policy::UpdatePolicy};
use safety_core::access::AccessContext;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Switch {
    enabled: bool,
}

pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route(
            "/api/modules/{module}/account-switch",
            get(read_switch).post(account_switch),
        )
        .route("/api/modules/{module}/server-switch", post(server_switch))
        .route("/api/modules/policy", get(read_policy).post(save_policy))
        .route("/api/modules/refresh", post(refresh))
}
fn refused() -> Response {
    module_admin::say(StatusCode::UNPROCESSABLE_ENTITY, "The module choice could not be saved or read; check the installed module and your permissions, then try again")
}
async fn with_host<T, F>(slot: modules::Slot, action: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(Arc<Application>) -> anyhow::Result<T> + Send + 'static,
{
    let Some(host) = modules::host(&slot) else {
        return module_admin::say(
            StatusCode::SERVICE_UNAVAILABLE,
            "Modules are still starting; try again shortly",
        );
    };
    match tokio::task::spawn_blocking(move || action(host)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        _ => refused(),
    }
}
async fn read_switch(
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
    Path(module): Path<String>,
) -> Response {
    with_host(slot, move |host| {
        host.installer.switch_state(&access, &module)
    })
    .await
}
async fn account_switch(
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
    Path(module): Path<String>,
    Json(pick): Json<Switch>,
) -> Response {
    with_host(slot, move |host| {
        host.installer.set_enabled(&access, &module, pick.enabled)?;
        host.installer.switch_state(&access, &module)
    })
    .await
}
async fn server_switch(
    State(admin): State<Arc<Admin>>,
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
    Path(module): Path<String>,
    Json(pick): Json<Switch>,
) -> Response {
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    with_host(slot, move |host| {
        host.installer
            .set_server_enabled(&access, &module, pick.enabled)?;
        host.installer.switch_state(&access, &module)
    })
    .await
}
async fn read_policy(
    State(admin): State<Arc<Admin>>,
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    with_host(slot, move |host| host.installer.update_policy(&access)).await
}
async fn save_policy(
    State(admin): State<Arc<Admin>>,
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
    Json(policy): Json<UpdatePolicy>,
) -> Response {
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    with_host(slot, move |host| {
        host.installer.set_update_policy(&access, policy.clone())?;
        Ok(policy)
    })
    .await
}
async fn refresh(
    State(admin): State<Arc<Admin>>,
    Extension(slot): Extension<modules::Slot>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    match crate::module_refresh::open(&admin, &slot, &access).await {
        Ok(value) => Json(value).into_response(),
        Err(_) => refused(),
    }
}
