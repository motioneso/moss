//! Assistant-access choice, kept in the account preference the old routes used.
use crate::input;
use crate::util::bad_request;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

/// The saved choice if there is one. Without it, access follows the module being installed.
fn state<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let read = host.call("kv", "preference.read", "ai-consent", json!({}))?;
    let explicit = read["value"].as_bool();
    Ok(Response::new(
        200,
        json!({"effective": explicit.unwrap_or(true), "explicit": explicit.map_or(Value::Null, Value::Bool)}),
    ))
}

/// Whether the assistant may use the person's check-ins and counts. Until a person chooses, it may.
pub fn effective<H: Host + ?Sized>(host: &H) -> Result<bool> {
    let read = host.call("kv", "preference.read", "ai-consent", json!({}))?;
    Ok(read["value"].as_bool().unwrap_or(true))
}

/// The reply every consent-gated tool gives while the choice is off. It carries no private value.
pub fn refused() -> Value {
    json!({"data": {"error": "Consent not granted", "code": "WELLNESS_CONSENT_REQUIRED"}})
}

/// `GET /wellness/ai-consent`.
pub fn get<H: Host + ?Sized>(host: &H) -> Result<Response> {
    state(host)
}

/// `PUT /wellness/ai-consent`.
pub fn put<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let granted = match input::consent(&request.body) {
        Ok(granted) => granted,
        Err(message) => return Ok(bad_request(message)),
    };
    host.call("kv", "preference.write", "ai-consent", json!({"value": granted}))?;
    state(host)
}
