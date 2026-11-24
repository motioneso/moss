//! Portable lists create ordinary digest-bound reviews; imports can only execute those adds.
use crate::{
    module_admin::{self, Admin},
    module_operation::Record,
    module_sources,
};
use anyhow::{ensure, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use moss_module_host::registry::ModuleList;
use moss_network::config::{private_read, private_write};
use moss_shell_contract::module_management::*;
use safety_core::access::AccessContext;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path as FsPath, sync::Arc};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    preview: String,
    approve: bool,
}
#[derive(Serialize, Deserialize)]
struct Preview {
    actor: String,
    operations: Vec<String>,
}
fn path(instance: &FsPath, id: &str) -> Result<std::path::PathBuf> {
    let uuid = uuid::Uuid::parse_str(id)?;
    ensure!(uuid.to_string() == id, "Invalid preview ID");
    Ok(instance.join(format!("module-list-{id}.json")))
}
pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route("/api/modules/list/export", get(export))
        .route("/api/modules/list/preview", post(preview))
        .route("/api/modules/list/import", post(import))
}
fn export_list(instance: &FsPath, actor: &str) -> Result<ModuleList> {
    // Export does not contact a source, including when the last source was removed.
    let source = module_sources::Registry {
        id: "export".into(),
        folder: Some(instance.into()),
        url: None,
        root_key: String::new(),
        first_party_key: String::new(),
    };
    let value = module_admin::run_json(instance, &source, &["--export-list".into()], &[], actor)
        .map_err(anyhow::Error::msg)?;
    Ok(serde_json::from_value(value)?)
}
fn refused() -> Response {
    module_admin::say(StatusCode::UNPROCESSABLE_ENTITY, "Module list refused; check its sources and pins, preview it again and approve the reviewed additions")
}
async fn export(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    let actor = access.actor_user_id().to_string();
    let instance = admin.instance.clone();
    match tokio::task::spawn_blocking(move || export_list(&instance, &actor)).await {
        Ok(Ok(list)) => Json(list).into_response(),
        _ => refused(),
    }
}
async fn preview(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(input): Json<Value>,
) -> Response {
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    let actor = access.actor_user_id().to_string();
    let instance = admin.instance.clone();
    let result = tokio::task::spawn_blocking(move || preview_list(&instance, actor, input)).await;
    match result {
        Ok(Ok(view)) => Json(view).into_response(),
        _ => refused(),
    }
}
async fn import(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(input): Json<Decision>,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    if !input.approve {
        return module_admin::say(
            StatusCode::BAD_REQUEST,
            "Approve the previewed additions first",
        );
    }
    let saved = (|| -> Result<Preview> {
        let saved: Preview = serde_json::from_slice(
            &private_read(&path(&admin.instance, &input.preview)?).map_err(anyhow::Error::msg)?,
        )?;
        ensure!(
            saved.actor == access.actor_user_id().to_string(),
            "Preview belongs to another account"
        );
        Ok(saved)
    })();
    let Ok(saved) = saved else {
        return refused();
    };
    let mut accepted = vec![];
    for id in saved.operations {
        let response = crate::module_management::execute(
            State(admin.clone()),
            Extension(access.clone()),
            Path(id.clone()),
            Json(ExecuteModule { approve: true }),
        )
        .await;
        if response.status() != StatusCode::ACCEPTED {
            return response;
        }
        accepted.push(id);
    }
    (StatusCode::ACCEPTED, Json(json!({"operations":accepted}))).into_response()
}

fn preview_list(instance: &FsPath, actor: String, input: Value) -> Result<Value> {
    let list = ModuleList::parse(&serde_json::to_vec(&input)?)?;
    let installed = export_list(instance, &actor)?;
    let mut records = vec![];
    for item in list.modules {
        // Lists never change an existing install, its source, pin, or data.
        if installed.modules.iter().any(|m| m.id == item.id) {
            continue;
        }
        let source = module_sources::select(instance, Some(&item.registry))?;
        let mut args = vec!["--plan".into()];
        if let Some(version) = &item.version {
            args.extend(["--version".into(), version.to_string()]);
        }
        let value = module_admin::run_json(instance, &source, &args, &[item.id], &actor)
            .map_err(anyhow::Error::msg)?;
        let review: ModuleReview = serde_json::from_value(value["review"].clone())?;
        let record = Record {
            actor: actor.clone(),
            lifecycle: None,
            source_binding: source.binding()?,
            approved: false,
            pin_after_install: item.version.is_some(),
            view: ModuleOperation {
                id: uuid::Uuid::new_v4().to_string(),
                review: Some(review),
                lifecycle: None,
                stage: ModuleOperationStage::Reviewed,
                result: None,
            },
        };
        records.push(record);
    }
    let id = uuid::Uuid::new_v4().to_string();
    for record in &records {
        record.save(instance)?;
    }
    let saved = Preview {
        actor,
        operations: records.iter().map(|r| r.view.id.clone()).collect(),
    };
    private_write(&path(&instance, &id)?, &serde_json::to_vec(&saved)?)
        .map_err(anyhow::Error::msg)?;
    Ok(
        json!({"preview":id,"operations":records.into_iter().map(|r|r.view).collect::<Vec<_>>(),"removals":[]}),
    )
}
