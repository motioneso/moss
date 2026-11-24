//! Authenticated management projection and durable review/execution, over the existing child.
use crate::{
    module_admin::{self, Admin},
    module_operation::{self, Record},
    module_sources,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use moss_shell_contract::module_management::*;
use safety_core::access::AccessContext;
use std::{collections::BTreeMap, sync::Arc};

pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route("/api/modules/catalog", get(catalog))
        .route("/api/modules/review", post(review))
        .route("/api/modules/operations/{id}", get(operation))
        .route("/api/modules/operations/{id}/execute", post(execute))
}

fn unavailable() -> Response {
    module_admin::say(
        StatusCode::UNPROCESSABLE_ENTITY,
        "The module operation could not be read or saved",
    )
}
pub(crate) fn owned(admin: &Admin, access: &AccessContext, id: &str) -> Result<Record, Response> {
    let record = Record::read(&admin.instance, id)
        .map_err(|_| module_admin::say(StatusCode::NOT_FOUND, "Module operation not found"))?;
    if record.actor != access.actor_user_id().to_string() {
        return Err(module_admin::say(
            StatusCode::FORBIDDEN,
            "This review belongs to another administrator",
        ));
    }
    Ok(record)
}

/// Source failures stay attached to their source; publisher collisions refuse the catalog.
async fn projection(admin: &Admin, access: &AccessContext) -> Result<ModuleCatalog, Response> {
    let sources = module_sources::read(&admin.instance).map_err(|_| {
        module_admin::say(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The module registry settings are not valid",
        )
    })?;
    let instance = admin.instance.clone();
    let actor = access.actor_user_id().to_string();
    tokio::task::spawn_blocking(move || {
        let mut result = ModuleCatalog { sources: vec![], modules: vec![] };
        let mut publishers = BTreeMap::new();
        for source in sources {
            let reply = module_admin::run_json(&instance, &source, &["--list".into()], &[], &actor)
                .and_then(|value| {
                    let modules: Vec<CatalogModule> = serde_json::from_value(value["modules"].clone())
                        .map_err(|_| "Unreadable module catalog".to_owned())?;
                    Ok((value, modules))
                });
            match reply {
                Ok((value, modules)) => {
                    for module in &modules {
                        if publishers.insert(module.id.clone(), module.publisher.clone()).is_some_and(|key| key != module.publisher) {
                            return Err("Two sources assign this module to different publishers".into());
                        }
                    }
                    result.sources.push(ModuleSource { id: source.id.clone(), name: value["name"].as_str().unwrap_or(&source.id).into(), error: None });
                    result.modules.extend(modules);
                }
                Err(_) => result.sources.push(ModuleSource { id: source.id, name: "Unavailable registry".into(), error: Some("The signed registry could not be read; check its configuration and try again".into()) }),
            }
        }
        Ok(result)
    }).await.map_err(|_| unavailable())?
        .map_err(|message: String| module_admin::say(StatusCode::UNPROCESSABLE_ENTITY, &message))
}

async fn catalog(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    match projection(&admin, &access).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}
async fn review(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(pick): Json<ReviewModule>,
) -> Response {
    review_selected(admin, access, pick, false).await
}
pub(crate) async fn review_selected(
    admin: Arc<Admin>,
    access: AccessContext,
    pick: ReviewModule,
    updating: bool,
) -> Response {
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    if !module_admin::valid_name(&pick.module) {
        return module_admin::say(StatusCode::BAD_REQUEST, "Invalid module name");
    }
    let Ok(source) = module_sources::select(&admin.instance, Some(&pick.source)) else {
        return module_admin::say(
            StatusCode::BAD_REQUEST,
            "The source registry is not configured",
        );
    };
    // Refresh every source so the host and projection see publisher collisions before approval.
    let catalog = match projection(&admin, &access).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !catalog
        .modules
        .iter()
        .any(|m| m.id == pick.module && m.source == pick.source)
    {
        return module_admin::say(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The module is unavailable from this source",
        );
    }
    let instance = admin.instance.clone();
    let actor = access.actor_user_id().to_string();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Record> {
        let value = module_admin::run_json(
            &instance,
            &source,
            &["--plan".into()],
            &[pick.module],
            &actor,
        )
        .map_err(anyhow::Error::msg)?;
        let review: ModuleReview = serde_json::from_value(value["review"].clone())?;
        anyhow::ensure!(
            !updating || review.previous.is_some(),
            "This module is not installed"
        );
        let record = Record {
            actor,
            lifecycle: None,
            source_binding: source.binding()?,
            approved: false,
            pin_after_install: false,
            view: ModuleOperation {
                id: uuid::Uuid::new_v4().to_string(),
                review: Some(review),
                lifecycle: None,
                stage: ModuleOperationStage::Reviewed,
                result: None,
            },
        };
        record.save(&instance)?;
        Ok(record)
    })
    .await;
    match result {
        Ok(Ok(record)) => Json(record.view).into_response(),
        _ => unavailable(),
    }
}
async fn operation(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    match owned(&admin, &access, &id) {
        Ok(record) => {
            if record.lifecycle.is_some() && !record.view.stage.terminal() {
                crate::module_lifecycle::launch(admin.clone(), access, id);
            }
            Json(record.view).into_response()
        }
        Err(response) => response,
    }
}
pub(crate) async fn execute(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    Json(decision): Json<ExecuteModule>,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    if !decision.approve {
        return module_admin::say(
            StatusCode::BAD_REQUEST,
            "Approve the reviewed package before installing",
        );
    }
    let mut record = match owned(&admin, &access, &id) {
        Ok(record) => record,
        Err(response) => return response,
    };
    if record.lifecycle.is_some() {
        crate::module_lifecycle::launch(admin, access, id);
        return (StatusCode::ACCEPTED, Json(record.view)).into_response();
    }
    let Ok(file) = module_operation::operation_lock(&admin.instance, &id) else {
        return unavailable();
    };
    // A child from before a server restart may still own the operation.
    if file.try_lock().is_err() {
        return (StatusCode::ACCEPTED, Json(record.view)).into_response();
    }
    record = match owned(&admin, &access, &id) {
        Ok(record) => record,
        Err(response) => return response,
    };
    if record.view.stage.terminal() {
        return (StatusCode::ACCEPTED, Json(record.view)).into_response();
    }
    let Ok(mut active) = admin.active.lock() else {
        return unavailable();
    };
    if active.contains(&id) {
        return (StatusCode::ACCEPTED, Json(record.view)).into_response();
    }
    record.approved = true;
    if record
        .stage(&admin.instance, ModuleOperationStage::Queued)
        .is_err()
    {
        return unavailable();
    }
    active.insert(id.clone());
    let view = record.view.clone();
    drop(active);
    drop(file);
    tokio::spawn(async move {
        let _gate = admin.gate.lock().await;
        let result = if module_admin::require_admin(&admin, &access).await.is_err() {
            Err("Administrator permission changed; review this module again")
        } else {
            let instance = admin.instance.clone();
            let task_id = id.clone();
            let actor = access.actor_user_id().to_string();
            match tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let saved = Record::read(&instance, &task_id)?;
                let review = saved
                    .view
                    .review
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("Missing package review"))?;
                let source = module_sources::select(&instance, Some(&review.source))?;
                anyhow::ensure!(source.binding()? == saved.source_binding, "Source changed");
                module_admin::run_json(
                    &instance,
                    &source,
                    &["--operation".into(), task_id],
                    &[review.module.clone()],
                    &actor,
                )
                .map_err(anyhow::Error::msg)?;
                Ok(())
            })
            .await
            {
                Ok(Ok(())) => Ok(()),
                _ => Err("Package verification or installation failed; review this module again"),
            }
        };
        if let Err(message) = result {
            if let Ok(file) = module_operation::operation_lock(&admin.instance, &id) {
                if file.try_lock().is_ok() {
                    if let Ok(mut saved) = Record::read(&admin.instance, &id) {
                        if !saved.view.stage.terminal() {
                            let _ = saved.finish(&admin.instance, Err(message));
                        }
                    }
                }
            }
        }
        if let Ok(mut active) = admin.active.lock() {
            active.remove(&id);
        }
    });
    (StatusCode::ACCEPTED, Json(view)).into_response()
}
