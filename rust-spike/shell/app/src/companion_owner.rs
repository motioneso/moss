//! The signed-in owner's view of their linked devices: list, rename and unlink. Browser cookie
//! only, never a device credential, and every answer is scoped to the owner.
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use safety_core::error::ApiError;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    companion::{browser_actor, devices, internal, json_body, pairing, trusted_origin, Reply},
    Accounts,
};

fn unknown() -> ApiError {
    ApiError::http(404, "That device is not linked")
}

/// Listing, renaming and unlinking stay available when Meetings is off, so an owner can always
/// remove a device.
pub async fn list(State(data): State<Arc<Accounts>>, headers: HeaderMap) -> Reply {
    let owner = browser_actor(&data, &headers).await?.actor_user_id();
    let found = devices(&data).list(owner).await.map_err(internal)?;
    let mut reply = Json(json!({ "devices": found })).into_response();
    reply.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().expect("header"));
    Ok(reply)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rename {
    display_name: String,
}

pub async fn rename(
    State(data): State<Arc<Accounts>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<Rename>, JsonRejection>,
) -> Reply {
    let name = json_body(body)?.display_name.trim().to_owned();
    trusted_origin(&data, &headers)?;
    let owner = browser_actor(&data, &headers).await?.actor_user_id();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(ApiError::http(400, "Pick a name between 1 and 64 characters"));
    }
    if !devices(&data).rename(owner, id, &name).await.map_err(internal)? {
        return Err(unknown());
    }
    Ok(Json(json!({ "device": { "id": id, "displayName": name } })).into_response())
}

pub async fn unlink(State(data): State<Arc<Accounts>>, headers: HeaderMap, Path(id): Path<Uuid>) -> Reply {
    trusted_origin(&data, &headers)?;
    let owner = browser_actor(&data, &headers).await?.actor_user_id();
    if !pairing(&data).unlink(owner, id).await.map_err(internal)? {
        return Err(unknown());
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
