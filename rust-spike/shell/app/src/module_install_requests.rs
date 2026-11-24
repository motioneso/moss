//! Account-owned requests; only configuration metadata is visible to administrators.
use crate::{
    module_admin::{self, Admin},
    module_management,
    module_operation::Record,
};
use axum::{
    extract::{Path, State},
    http::{header::CACHE_CONTROL, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use moss_shell_contract::{
    install_requests::{ApproveInstallRequest, InstallRequest, RequestInstall},
    module_management::{ExecuteModule, ModuleOperationStage},
};
use safety_core::{access::AccessContext, db::DataContext};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

pub(crate) const MIGRATION: &str = include_str!("module_install_requests.sql");
const COLUMNS: &str =
    "id::text, owner_account_id::text, source, module, created_at::text, operation_id::text";

pub fn routes() -> Router<Arc<Admin>> {
    Router::new()
        .route("/api/modules/requests", get(list).post(submit))
        .route("/api/modules/requests/{id}", get(status))
        .route("/api/modules/requests/{id}/approve", post(approve))
}

fn unavailable() -> Response {
    module_admin::say(
        StatusCode::UNPROCESSABLE_ENTITY,
        "The install request could not be read or saved; try again",
    )
}
fn missing() -> Response {
    module_admin::say(StatusCode::NOT_FOUND, "Install request not found")
}
fn reply(value: impl serde::Serialize) -> Response {
    ([(CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

// The same one-shot trusted schema bootstrap used by local trust, with no caller SQL.
// The file fence serializes bootstrap with other server/installer processes.
async fn context(admin: &Admin, access: &AccessContext) -> anyhow::Result<DataContext> {
    let cx = DataContext::open(&admin.platform.app, access)
        .await
        .map_err(|_| anyhow::anyhow!("Cannot open install request context"))?;
    let present: bool = cx
        .db()
        .query_one(
            "SELECT to_regclass('moss_modules.install_requests') IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    cx.commit()
        .await
        .map_err(|_| anyhow::anyhow!("Cannot save install request"))?;
    if !present {
        let instance = admin.instance.clone();
        let (url, _fence) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let fence = crate::module_operation::lock_file(&instance.join("module-install.lock"))?;
            fence.lock()?;
            let url = module_admin::elevated_url(&instance).map_err(anyhow::Error::msg)?;
            Ok((url, fence))
        })
        .await??;
        crate::module_install::prepare_host_schema(&url).await?;
    }
    Ok(DataContext::open(&admin.platform.app, access)
        .await
        .map_err(|_| anyhow::anyhow!("Cannot open install request context"))?)
}

fn view(admin: &Admin, row: &tokio_postgres::Row) -> InstallRequest {
    let operation_id: Option<String> = row.get(5);
    let status = match operation_id.as_deref() {
        None => "pending",
        Some(id) => match Record::read(&admin.instance, id).map(|r| r.view.stage) {
            Ok(ModuleOperationStage::Reviewed) => "reviewed",
            Ok(ModuleOperationStage::Queued) => "queued",
            Ok(ModuleOperationStage::Checking) => "checking",
            Ok(ModuleOperationStage::Installing) => "installing",
            Ok(ModuleOperationStage::Succeeded) => "succeeded",
            Ok(ModuleOperationStage::Failed) => "failed",
            Err(_) => "unavailable",
        },
    };
    InstallRequest {
        id: row.get(0),
        owner_account_id: row.get(1),
        source: row.get(2),
        module: row.get(3),
        created_at: row.get(4),
        operation_id,
        status: status.into(),
        // Neither the guest notify port nor the existing repository can select admins.
        // Do not impersonate another recipient or pretend a notice was delivered.
        notice: "unsupported",
        notice_reason:
            "Automatic admin notices are unavailable; an administrator can read install requests",
    }
}

async fn submit(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(pick): Json<RequestInstall>,
) -> Response {
    if !module_admin::valid_name(&pick.module) || !module_admin::valid_name(&pick.source) {
        return module_admin::say(StatusCode::BAD_REQUEST, "Invalid module or source name");
    }
    let _gate = admin.gate.lock().await;
    let result = async {
        let cx = context(&admin, &access).await?;
        let actor = access.actor_user_id();
        let query = format!("SELECT {COLUMNS} FROM moss_modules.install_requests WHERE owner_account_id=$1 AND source=$2 AND module=$3");
        if let Some(row) = cx.db().query_opt(&query, &[&actor, &pick.source, &pick.module]).await? {
            let result = view(&admin, &row);
            cx.commit().await.map_err(|_| anyhow::anyhow!("Cannot save install request"))?;
            return Ok::<_, anyhow::Error>(Some(result));
        }
        let instance = admin.instance.clone();
        let source = pick.source.clone();
        let module = pick.module.clone();
        let offered = tokio::task::spawn_blocking(move || {
            crate::module_registries::requestable(&instance, &source, &module)
        }).await?.unwrap_or(false);
        if !offered {
            return Ok(None);
        }
        // A uniqueness constraint, not an in-memory set, owns duplicate suppression.
        cx.db().execute(
            "INSERT INTO moss_modules.install_requests(id,owner_account_id,source,module) VALUES($1,$2,$3,$4) ON CONFLICT(owner_account_id,source,module) DO NOTHING",
            &[&Uuid::new_v4(), &actor, &pick.source, &pick.module],
        ).await?;
        let row = cx.db().query_one(&query, &[&actor, &pick.source, &pick.module]).await?;
        let result = view(&admin, &row);
        cx.commit().await.map_err(|_| anyhow::anyhow!("Cannot save install request"))?;
        Ok(Some(result))
    }.await;
    match result {
        Ok(Some(value)) => reply(value),
        Ok(None) => module_admin::say(StatusCode::UNPROCESSABLE_ENTITY,
            "The module is unavailable from this source; ask an administrator to check the registry"),
        Err(_) => unavailable(),
    }
}

async fn list(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    let result = async {
        let cx = context(&admin, &access).await?;
        // RLS exposes only the requester's rows, or configuration metadata to an admin.
        let rows = cx
            .db()
            .query(
                &format!(
                    "SELECT {COLUMNS} FROM moss_modules.install_requests ORDER BY created_at,id"
                ),
                &[],
            )
            .await?;
        let values: Vec<_> = rows.iter().map(|row| view(&admin, row)).collect();
        cx.commit()
            .await
            .map_err(|_| anyhow::anyhow!("Cannot save install request"))?;
        Ok::<_, anyhow::Error>(values)
    }
    .await;
    match result {
        Ok(values) => reply(json!({"requests":values})),
        Err(_) => unavailable(),
    }
}

async fn status(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
) -> Response {
    let Ok(id) = Uuid::parse_str(&id) else {
        return missing();
    };
    let result = async {
        let cx = context(&admin, &access).await?;
        let row = cx
            .db()
            .query_opt(
                &format!("SELECT {COLUMNS} FROM moss_modules.install_requests WHERE id=$1"),
                &[&id],
            )
            .await?;
        let result = row.as_ref().map(|row| view(&admin, row));
        cx.commit()
            .await
            .map_err(|_| anyhow::anyhow!("Cannot save install request"))?;
        Ok::<_, anyhow::Error>(result)
    }
    .await;
    match result {
        Ok(Some(value)) => reply(value),
        Ok(None) => missing(),
        Err(_) => unavailable(),
    }
}

async fn approve(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    Json(decision): Json<ApproveInstallRequest>,
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
    let Ok(id) = Uuid::parse_str(&id) else {
        return missing();
    };
    let record = match module_management::owned(&admin, &access, &decision.operation) {
        Ok(record) => record,
        Err(response) => return response,
    };
    let Some(review) = &record.view.review else {
        return module_admin::say(
            StatusCode::CONFLICT,
            "Review an installable package for this request",
        );
    };
    let Ok(operation) = Uuid::parse_str(&decision.operation) else {
        return unavailable();
    };
    {
        let _gate = admin.gate.lock().await;
        let Ok(cx) = context(&admin, &access).await else {
            return unavailable();
        };
        let row = match cx
            .db()
            .query_opt(
                &format!(
                    "SELECT {COLUMNS} FROM moss_modules.install_requests WHERE id=$1 FOR UPDATE"
                ),
                &[&id],
            )
            .await
        {
            Ok(Some(row)) => row,
            Ok(None) => return missing(),
            Err(_) => return unavailable(),
        };
        let saved = view(&admin, &row);
        if review.module != saved.module
            || review.source != saved.source
            || record.lifecycle.is_some()
        {
            return module_admin::say(
                StatusCode::CONFLICT,
                "Review this request's module and source before approving",
            );
        }
        let same_operation = saved.operation_id.as_deref() == Some(decision.operation.as_str());
        let fresh_review = !record.approved && record.view.stage == ModuleOperationStage::Reviewed;
        let retryable = saved.operation_id.is_none() || saved.status == "failed";
        if !same_operation && !(retryable && fresh_review) {
            return module_admin::say(
                StatusCode::CONFLICT,
                "Use the request's saved operation, or obtain a fresh review before approval",
            );
        }
        if cx.db().execute("UPDATE moss_modules.install_requests SET operation_id=$2,approved_by=$3 WHERE id=$1", &[&id, &operation, &access.actor_user_id()]).await.is_err()
            || cx.commit().await.is_err() { return unavailable(); }
    }
    // Reuses part 1's authorization, source/digest revalidation and restart/idempotency journal.
    module_management::execute(
        State(admin),
        Extension(access),
        Path(decision.operation),
        Json(ExecuteModule { approve: true }),
    )
    .await
}
