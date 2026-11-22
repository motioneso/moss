//! The Email and Calendar briefing switches, shown on Briefings settings. Each owner keeps its own
//! switch, so these routes only go through the owner's public calls for the caller.
use crate::gather::api;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Map, Value};

/// A source that cannot be asked (not installed, or failing) is left out of the reply.
fn read<H: Host + ?Sized>(host: &H) -> Value {
    let mut out = Map::new();
    if let Ok(reply) = api(host, "email", "getBriefingSource", json!({})) {
        out.insert("email".into(), json!(reply["enabled"].as_bool().unwrap_or(true)));
    }
    if let Ok(reply) = api(host, "calendar", "getSourceSwitches", json!({})) {
        out.insert("calendar".into(), json!(reply["briefings"].as_bool().unwrap_or(true)));
    }
    Value::Object(out)
}

pub fn get<H: Host + ?Sized>(host: &H) -> Result<Response> {
    Ok(Response::new(200, read(host)))
}

fn bad(message: &str) -> Response {
    Response::new(400, json!({"error": message}))
}

/// Only `email` and `calendar` are accepted, each a boolean, and at least one must be present.
pub fn patch<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(body) = request.body.as_object() else {
        return Ok(bad("Send an object with email or calendar"));
    };
    let valid = !body.is_empty()
        && body.iter().all(|(k, v)| matches!(k.as_str(), "email" | "calendar") && v.is_boolean());
    if !valid {
        return Ok(bad("Send email or calendar as true or false"));
    }
    if let Some(on) = body.get("email") {
        if api(host, "email", "setBriefingSource", json!({"enabled": on})).is_err() {
            return Ok(Response::new(404, json!({"error": "Email is not available", "code": "briefing_source_unavailable"})));
        }
    }
    if let Some(on) = body.get("calendar") {
        if api(host, "calendar", "setSourceSwitches", json!({"briefings": on})).is_err() {
            return Ok(Response::new(404, json!({"error": "Calendar is not available", "code": "briefing_source_unavailable"})));
        }
    }
    Ok(Response::new(200, read(host)))
}
