//! Route handlers for the Mac link. Each one answers a refusal with a code only and a fault
//! with the unavailable code, so no meeting text or host detail leaves the module.
use crate::capture_auth as auth;
use crate::capture_errors::{respond, CaptureCode, Failure, Stop};
use crate::capture_input as input;
use crate::{capture_connection, capture_start};
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

fn meeting(request: &RouteRequest) -> Result<String, Failure> {
    input::uuid(&request.params.get("id").map_or(Value::Null, |id| json!(id)))
}

/// The route, or `None` when the path is not a Mac link route.
pub fn dispatch<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Option<Response> {
    let body = &request.body;
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/capture/connection") => capture_connection::register(host, body),
        ("POST", "/capture/commands") => capture_connection::commands(host, body),
        ("POST", "/capture/claim") => capture_connection::claim(host, body),
        ("GET", "/capture/devices") => capture_connection::devices(host),
        ("POST", "/records/:id/capture/start") => meeting(request).map_err(Stop::from).and_then(|id| capture_start::start(host, &id, body)),
        ("POST", "/records/:id/capture/cancel-start") => {
            meeting(request).map_err(Stop::from).and_then(|id| capture_start::cancel_start(host, &id, body))
        }
        ("POST", "/recording-capability/attempt") => attempt(host, body),
        ("POST", "/recording-capability/decide") => decide(host, body),
        _ => return None,
    };
    Some(respond(result))
}

/// The recording-permission routes answer 401 with this body when the caller is not allowed.
fn gone<T>(result: Result<T, Stop>) -> Result<T, Stop> {
    result.map_err(|stop| match stop {
        Stop::Host(error) => Stop::Host(error),
        Stop::Fail(failure) if failure.status == 401 => Failure::new(CaptureCode::ConnectionUnavailable).into(),
        other => other,
    })
}

fn policy_one(value: &Value) -> bool {
    value.as_i64() == Some(1)
}

/// A linked Mac cannot open a second recording-approval flow, so the answer is always 410.
fn attempt<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response, Stop> {
    let map = input::object(body, &["requestKey", "proofHash", "policyVersion"], &["requestKey", "proofHash", "policyVersion"])?;
    input::uuid(&map["requestKey"])?;
    input::hex64(&map["proofHash"])?;
    if !policy_one(&map["policyVersion"]) {
        return Err(Failure::new(CaptureCode::InvalidInput).into());
    }
    gone(auth::native(host))?;
    Ok(Failure::new(CaptureCode::RelinkRequired).response())
}

/// Only versioned initial pairing may create recording authority, so the answer is always 410.
fn decide<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response, Stop> {
    let map = input::object(body, &["attemptId", "decision", "policyVersion"], &["attemptId", "decision", "policyVersion"])?;
    input::uuid(&map["attemptId"])?;
    if !matches!(map["decision"].as_str(), Some("approve" | "deny")) || !policy_one(&map["policyVersion"]) {
        return Err(Failure::new(CaptureCode::InvalidInput).into());
    }
    gone(auth::browser(host))?;
    Ok(Failure::new(CaptureCode::RelinkRequired).response())
}
