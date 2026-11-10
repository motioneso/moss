//! Instance admin routes for user accounts.
//!
//! Admin power is configuration power only. Each route checks the admin flag inside the admin's
//! own data context on the app role, so row-level security applies to the admin like anyone else
//! and the check shares one transaction with the change it guards. Sessions are revoked on the
//! auth role, the only role allowed to touch the session tables.
//!
//! The guards run in the TypeScript order (`packages/settings/src/routes.ts`). Deleting an
//! account's data is not ported, so delete and reject answer 501 once every guard has passed.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::Router;
use serde_json::{json, Value};
use tokio_postgres::Row;
use uuid::Uuid;

use crate::auth::{is_uuid, resolve_access, serialize_user, USER_FIELDS};
use crate::db::{DataContext, Database, RuntimeRole};
use crate::error::{json_reply, ApiError};
use crate::http::Platform;

/// Serializes every change that could remove the last active admin.
const LAST_ADMIN_LOCK: &str = "SELECT pg_advisory_xact_lock(hashtext('jarv1s:last-active-admin'))";

pub fn routes() -> Router<Arc<Platform>> {
    Router::new()
        .route("/api/admin/users", get(list_users))
        .route("/api/admin/users/{id}", delete(delete_user))
        .route("/api/admin/users/{id}/approve", post(approve))
        .route("/api/admin/users/{id}/reactivate", post(reactivate))
        .route("/api/admin/users/{id}/deactivate", post(deactivate))
        .route("/api/admin/users/{id}/revoke-sessions", post(revoke_sessions))
        .route("/api/admin/users/{id}/promote", post(promote))
        .route("/api/admin/users/{id}/demote", post(demote))
        .route("/api/admin/users/{id}/reject", post(reject))
}

/// Signs a user out everywhere: browser sessions and linked companion devices.
pub async fn revoke_user_sessions(auth: &Database, user_id: Uuid) -> Result<u64, ApiError> {
    if auth.role() != RuntimeRole::Auth {
        return Err(ApiError::Internal("revoking sessions needs the auth role".into()));
    }
    let mut client = auth.client().await?;
    let tx = client.transaction().await?;
    let browser =
        tx.execute("DELETE FROM app.better_auth_sessions WHERE user_id = $1", &[&user_id]).await?;
    let companion =
        tx.execute("DELETE FROM app.companion_devices WHERE user_id = $1", &[&user_id]).await?;
    tx.commit().await?;
    Ok(browser + companion)
}

/// `assertAdminUser`. An actor with no user row is signed out; a member is refused.
async fn open_as_admin(platform: &Platform, headers: &HeaderMap) -> Result<DataContext, ApiError> {
    let access = resolve_access(platform, headers).await?;
    let cx = DataContext::open(&platform.app, &access).await?;
    let row = cx
        .db()
        .query_opt(
            "SELECT is_instance_admin FROM app.get_user_by_id($1::uuid)",
            &[&cx.actor_user_id()],
        )
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if !row.get::<_, bool>(0) {
        return Err(ApiError::http(403, "Instance admin permission is required"));
    }
    Ok(cx)
}

fn not_found() -> ApiError {
    ApiError::http(404, "User not found")
}

/// A malformed id names nobody.
fn parse_target(id: &str) -> Result<Uuid, ApiError> {
    if !is_uuid(id) {
        return Err(not_found());
    }
    Uuid::parse_str(id).map_err(|_| not_found())
}

async fn require_user(cx: &DataContext, id: Uuid) -> Result<Row, ApiError> {
    let sql = format!("SELECT {USER_FIELDS} FROM app.get_user_by_id($1::uuid)");
    cx.db().query_opt(&sql, &[&id]).await?.ok_or_else(not_found)
}

/// Fails unless an active admin other than `excluding` remains. The caller holds the lock.
async fn ensure_another_active_admin(cx: &DataContext, excluding: Uuid) -> Result<(), ApiError> {
    let other = cx
        .db()
        .query_opt(
            "SELECT id FROM app.list_all_users() \
             WHERE is_instance_admin = true AND status = 'active' AND id != $1::uuid LIMIT 1",
            &[&excluding],
        )
        .await?;
    match other {
        Some(_) => Ok(()),
        None => Err(ApiError::http(409, "Cannot remove the last active admin")),
    }
}

/// Guards a deactivate or demote. The admin flag is read again under the lock, so a stale read
/// taken before the lock cannot skip the check.
async fn removing_admin_is_safe(cx: &DataContext, target: Uuid) -> Result<(), ApiError> {
    cx.db().execute(LAST_ADMIN_LOCK, &[]).await?;
    if require_user(cx, target).await?.get::<_, bool>("is_instance_admin") {
        ensure_another_active_admin(cx, target).await?;
    }
    Ok(())
}

async fn audit(cx: &DataContext, action: &str, target: Uuid, metadata: Value) -> Result<(), ApiError> {
    cx.db()
        .execute(
            "INSERT INTO app.admin_audit_events \
               (id, actor_user_id, action, target_type, target_id, metadata, request_id, created_at) \
             VALUES ($1, $2, $3, 'user', $4, $5, $6, now())",
            &[
                &Uuid::new_v4(),
                &cx.actor_user_id(),
                &action,
                &target.to_string(),
                &metadata,
                &cx.access().request_id(),
            ],
        )
        .await?;
    Ok(())
}

/// `setUserStatus`.
async fn set_status(cx: &DataContext, target: Uuid, status: &str, action: &str) -> Result<Row, ApiError> {
    let user = require_user(cx, target).await?;
    let deactivating = status == "deactivated";
    if deactivating && user.get::<_, bool>("is_bootstrap_owner") {
        return Err(ApiError::http(409, "The bootstrap owner cannot be deactivated"));
    }
    if deactivating && target == cx.actor_user_id() {
        return Err(ApiError::http(422, "You cannot deactivate your own account"));
    }
    if deactivating {
        removing_admin_is_safe(cx, target).await?;
    }
    let sql = format!(
        "UPDATE app.users SET status = $2, updated_at = now() WHERE id = $1 RETURNING {USER_FIELDS}"
    );
    let updated = cx.db().query_one(&sql, &[&target, &status]).await?;
    audit(cx, action, target, json!({ "status": status })).await?;
    Ok(updated)
}

/// `setUserAdmin`.
async fn set_admin(cx: &DataContext, target: Uuid, is_admin: bool) -> Result<Row, ApiError> {
    let user = require_user(cx, target).await?;
    if !is_admin {
        if user.get::<_, bool>("is_bootstrap_owner") {
            return Err(ApiError::http(409, "The bootstrap owner cannot be demoted"));
        }
        removing_admin_is_safe(cx, target).await?;
    }
    let sql = format!(
        "UPDATE app.users SET is_instance_admin = $2, updated_at = now() WHERE id = $1 \
         RETURNING {USER_FIELDS}"
    );
    let updated = cx.db().query_one(&sql, &[&target, &is_admin]).await?;
    let action = if is_admin { "user.promote" } else { "user.demote" };
    audit(cx, action, target, json!({ "isInstanceAdmin": is_admin })).await?;
    Ok(updated)
}

fn user_reply(row: &Row) -> Response {
    json_reply(200, &json!({ "user": serialize_user(row) }))
}

async fn list_users(
    State(platform): State<Arc<Platform>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let cx = open_as_admin(&platform, &headers).await?;
    let sql = format!("SELECT {USER_FIELDS} FROM app.list_all_users()");
    let rows = cx.db().query(&sql, &[]).await?;
    cx.commit().await?;
    let users: Vec<Value> = rows.iter().map(serialize_user).collect();
    Ok(json_reply(200, &json!({ "users": users })))
}

async fn approve(
    State(platform): State<Arc<Platform>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let cx = open_as_admin(&platform, &headers).await?;
    let target = parse_target(&id)?;
    if require_user(&cx, target).await?.get::<_, String>("status") != "pending" {
        return Err(ApiError::http(409, "Only pending accounts can be approved"));
    }
    let updated = set_status(&cx, target, "active", "user.approve").await?;
    cx.commit().await?;
    Ok(user_reply(&updated))
}

async fn change_status(
    platform: &Platform,
    headers: &HeaderMap,
    id: &str,
    status: &str,
    action: &str,
) -> Result<Row, ApiError> {
    let cx = open_as_admin(platform, headers).await?;
    let updated = set_status(&cx, parse_target(id)?, status, action).await?;
    cx.commit().await?;
    Ok(updated)
}

async fn reactivate(
    State(platform): State<Arc<Platform>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let updated = change_status(&platform, &headers, &id, "active", "user.reactivate").await?;
    Ok(user_reply(&updated))
}

/// The status change commits first, then every session the user holds is revoked.
async fn deactivate(
    State(platform): State<Arc<Platform>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let updated = change_status(&platform, &headers, &id, "deactivated", "user.deactivate").await?;
    revoke_user_sessions(&platform.auth, updated.get("id")).await?;
    Ok(user_reply(&updated))
}

/// The reply carries the number of sessions removed and nothing from the session rows.
async fn revoke_sessions(
    State(platform): State<Arc<Platform>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let cx = open_as_admin(&platform, &headers).await?;
    let target = parse_target(&id)?;
    require_user(&cx, target).await?;
    cx.commit().await?;
    let count = revoke_user_sessions(&platform.auth, target).await?;
    Ok(json_reply(200, &json!({ "success": true, "count": count })))
}

async fn change_admin(
    platform: &Platform,
    headers: &HeaderMap,
    id: &str,
    is_admin: bool,
) -> Result<Response, ApiError> {
    let cx = open_as_admin(platform, headers).await?;
    let updated = set_admin(&cx, parse_target(id)?, is_admin).await?;
    cx.commit().await?;
    Ok(user_reply(&updated))
}

async fn promote(
    State(platform): State<Arc<Platform>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    change_admin(&platform, &headers, &id, true).await
}

async fn demote(
    State(platform): State<Arc<Platform>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    change_admin(&platform, &headers, &id, false).await
}

/// `tearDownAccount`'s guards. Nothing is deleted: a request that passes them gets 501.
async fn tear_down(
    platform: &Platform,
    headers: &HeaderMap,
    id: &str,
    require_pending: bool,
) -> Result<Response, ApiError> {
    let cx = open_as_admin(platform, headers).await?;
    let target = parse_target(id)?;
    let user = require_user(&cx, target).await?;
    if require_pending && user.get::<_, String>("status") != "pending" {
        return Err(ApiError::http(409, "Only pending accounts can be rejected"));
    }
    if target == cx.actor_user_id() {
        return Err(ApiError::http(422, "You cannot delete your own account"));
    }
    if user.get::<_, bool>("is_bootstrap_owner") {
        return Err(ApiError::http(409, "The bootstrap owner cannot be deleted"));
    }
    if user.get::<_, bool>("is_instance_admin") {
        cx.db().execute(LAST_ADMIN_LOCK, &[]).await?;
        ensure_another_active_admin(&cx, target).await?;
    }
    cx.commit().await?;
    Err(ApiError::http(501, "Deleting an account is not available on this server yet"))
}

async fn reject(
    State(platform): State<Arc<Platform>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    tear_down(&platform, &headers, &id, true).await
}

async fn delete_user(
    State(platform): State<Arc<Platform>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    tear_down(&platform, &headers, &id, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_ids_name_nobody() {
        for id in ["", "me", "00000000-0000-0000-0000-00000000000", "{00000000-0000-0000-0000-000000000000}"] {
            let (status, body) = parse_target(id).unwrap_err().status_and_body();
            assert_eq!((status, body), (404, json!({ "error": "User not found" })), "{id}");
        }
        let id = "0F8FAD5B-D9CB-469F-A165-70867728950E";
        assert_eq!(parse_target(id).unwrap(), Uuid::parse_str(id).unwrap());
    }

    #[test]
    fn routes_build() {
        let _ = routes();
    }
}
