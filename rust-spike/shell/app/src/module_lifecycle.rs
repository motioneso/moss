//! Authenticated lifecycle requests reuse the durable operation record and one-shot child.
use crate::{
    module_admin::{self, Admin},
    module_management::owned,
    module_operation::{self, LifecycleState, Record},
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
use serde_json::Value;
use std::{
    path::Path as FilePath,
    process::{Command, Stdio},
    sync::Arc,
};

pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route("/api/modules/remove", post(remove))
        .route("/api/modules/restore", post(restore))
        .route("/api/modules/snapshots", get(snapshots))
        .route("/api/modules/operations/{id}/cancel", post(cancel))
}
/// Durable requests accepted before restart do not depend on a browser staying open.
pub(crate) fn resume_pending(admin: Arc<Admin>) {
    let Ok(entries) = std::fs::read_dir(admin.instance.join("module-operations")) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(record) = Record::read(&admin.instance, id) else {
            continue;
        };
        if record.lifecycle.is_some() && !record.view.stage.terminal() {
            if let Ok(actor) = record.actor.parse() {
                launch(
                    admin.clone(),
                    AccessContext::new(actor, "module-lifecycle-restart"),
                    id.to_string(),
                );
            }
        }
    }
}
fn unavailable() -> Response {
    module_admin::say(
        StatusCode::UNPROCESSABLE_ENTITY,
        "The module lifecycle service is unavailable; read the saved operation and try again",
    )
}
/// The supervisor supplies the same short-lived migration login used by installation.
fn child(instance: &FilePath, actor: &str, operation: Option<&str>) -> anyhow::Result<Value> {
    let url = module_admin::elevated_url(instance).map_err(anyhow::Error::msg)?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("lifecycle-module")
        .arg("--instance")
        .arg(instance)
        .args(["--actor", actor]);
    if let Some(id) = operation {
        command.args(["--operation", id]);
    } else {
        command.arg("--snapshots");
    }
    let output = command
        .env(crate::module_install::INSTALL_URL_VARIABLE, url)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    anyhow::ensure!(output.status.success(), "The lifecycle child stopped");
    Ok(serde_json::from_slice(&output.stdout)?)
}
async fn submit(
    admin: Arc<Admin>,
    access: AccessContext,
    lifecycle: ModuleLifecycle,
    typed_name: String,
    acknowledge_data_loss: bool,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    if !module_admin::valid_name(&lifecycle.module)
        || lifecycle
            .snapshot
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return module_admin::say(StatusCode::BAD_REQUEST, "Invalid module or snapshot name");
    }
    let record = Record {
        actor: access.actor_user_id().to_string(),
        source_binding: String::new(),
        approved: true,
        pin_after_install: false,
        lifecycle: Some(LifecycleState {
            typed_name,
            acknowledge_data_loss,
            before_revision: None,
            expected_digest: None,
        }),
        view: ModuleOperation {
            id: uuid::Uuid::new_v4().to_string(),
            review: None,
            lifecycle: Some(lifecycle),
            stage: ModuleOperationStage::Queued,
            stages: vec![ModuleOperationStage::Queued],
            result: None,
        },
    };
    if record.save(&admin.instance).is_err() {
        return unavailable();
    }
    launch(admin, access, record.view.id.clone());
    (StatusCode::ACCEPTED, Json(record.view)).into_response()
}
async fn remove(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(pick): Json<RemoveModule>,
) -> Response {
    submit(
        admin,
        access,
        ModuleLifecycle {
            module: pick.module,
            action: if pick.delete_data {
                LifecycleAction::DeleteData
            } else {
                LifecycleAction::Remove
            },
            snapshot: None,
        },
        pick.typed_name,
        false,
    )
    .await
}
async fn restore(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(pick): Json<RestoreModule>,
) -> Response {
    submit(
        admin,
        access,
        ModuleLifecycle {
            module: pick.module,
            action: LifecycleAction::Restore,
            snapshot: Some(pick.snapshot),
        },
        pick.typed_name,
        pick.acknowledge_data_loss,
    )
    .await
}
async fn snapshots(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    let _gate = admin.gate.lock().await;
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    let instance = admin.instance.clone();
    let actor = access.actor_user_id().to_string();
    match tokio::task::spawn_blocking(move || child(&instance, &actor, None)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        _ => unavailable(),
    }
}
/// Reading a nonterminal result after restart resumes the trusted child. Its instance and
/// operation file locks serialize with an older child, which may still be alive.
pub(crate) fn launch(admin: Arc<Admin>, access: AccessContext, id: String) {
    let Ok(mut active) = admin.active.lock() else {
        return;
    };
    if !active.insert(id.clone()) {
        return;
    }
    drop(active);
    tokio::spawn(async move {
        let _gate = admin.gate.lock().await;
        if module_admin::require_admin(&admin, &access).await.is_ok() {
            let instance = admin.instance.clone();
            let actor = access.actor_user_id().to_string();
            let task_id = id.clone();
            // A killed child leaves its stage readable and recoverable. Do not replace it
            // with a guessed failure before the migration service has recovered its journal.
            let _ =
                tokio::task::spawn_blocking(move || child(&instance, &actor, Some(&task_id))).await;
        } else if let Ok(file) = module_operation::operation_lock(&admin.instance, &id) {
            if file.try_lock().is_ok() {
                if let Ok(mut record) = Record::read(&admin.instance, &id) {
                    if record
                        .lifecycle
                        .as_ref()
                        .is_some_and(|s| s.before_revision.is_none())
                        && !record.view.stage.terminal()
                    {
                        let _ = record.finish(
                            &admin.instance,
                            Err("Administrator permission changed before the operation started"),
                        );
                    }
                }
            }
        }
        if let Ok(mut active) = admin.active.lock() {
            active.remove(&id);
        }
    });
}
async fn cancel(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
    if let Err(response) = owned(&admin, &access, &id) {
        return response;
    }
    let Ok(file) = module_operation::operation_lock(&admin.instance, &id) else {
        return unavailable();
    };
    if file.try_lock().is_err() {
        return module_admin::say(
            StatusCode::CONFLICT,
            "The operation is already changing data; let it complete safely and read its result",
        );
    }
    let mut record = match owned(&admin, &access, &id) {
        Ok(record) => record,
        Err(response) => return response,
    };
    if !record.view.stage.terminal() {
        if record.lifecycle.is_none() || record.view.stage != ModuleOperationStage::Queued {
            return module_admin::say(
                StatusCode::CONFLICT,
                "The operation needs recovery; read its result before trying again",
            );
        }
        if record
            .finish(
                &admin.instance,
                Err("The module operation was cancelled before changes started"),
            )
            .is_err()
        {
            return unavailable();
        }
    }
    Json(record.view).into_response()
}
