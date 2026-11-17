//! `GET /headlines/:headline_id/photo` and `DELETE /sources/:id/photos`.
use crate::photo_store as store;
use crate::public_cache::now_ms;
use crate::source_routes::source_id;
use crate::sources::{self, SOURCES};
use crate::util::{is_uuid, values};
use moss_module_sdk::{query::{Filter, Query}, Client, Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

/// The stored photo of one story, as JSON with the picture in base64 because a package reply has
/// no raw image channel. Row level security hides another person's source, so it answers the
/// same as a story with no photo.
pub fn photo<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("headline_id").map(String::as_str).unwrap_or_default();
    let not_found = || Response::new(404, json!({"error": "Sports headline photo not found"}));
    let Some((source, _)) = id.split_once(':') else { return Ok(not_found()) };
    if !is_uuid(source) || sources::find(host, source)?.is_none() {
        return Ok(not_found());
    }
    let Some(key) = store::link(host, id)? else { return Ok(not_found()) };
    match store::serve(host, &key, now_ms(host)?)? {
        Some(body) => Ok(Response::new(200, json!({"contentType": "image/jpeg", "bodyBase64": body}))),
        None => Ok(not_found()),
    }
}

/// Stops using Moss's photos for a source: forgets the saved rule and deletes the copies.
pub fn stop_photos<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match source_id(request) {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };
    let cleared = values(vec![
        ("photo_rule_json", Value::Null),
        ("photo_rule_state", json!("none")),
        ("photo_miss_streak", json!(0)),
        ("photo_relook_at", Value::Null),
    ]);
    let changed = Client(host).query(SOURCES, &Query::update(Filter::eq("id", id.as_str()), cleared))?;
    let found = if changed.is_empty() { None } else { sources::find(host, &id)? };
    let Some((row, assignments)) = found else { return Ok(Response::new(404, json!({"error": "Source not found"}))) };
    store::remove_source(host, &id)?;
    Ok(Response::new(200, json!({"source": sources::source_dto(&row, &assignments)?})))
}
