//! Wellness package, parts 13 and 14: mood check-ins, the assistant-access choice, medications,
//! dose logs and adherence counts, private to each owner. All effects cross the guest-safe SDK
//! Host interface. No model port is used, and no check-in or medication text is written to logs,
//! jobs or activity.
pub mod adherence;
pub mod checkins;
pub mod consent;
pub mod cursor;
pub mod input;
pub mod medication_input;
pub mod medications;
pub mod occurrence;
pub mod schedule;
pub mod taxonomy;
pub mod util;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::json;

/// Routes use the module-relative path template. A host failure leaves as a fixed message,
/// because host errors can carry request text.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/wellness/ai-consent") => consent::get(host),
        ("PUT", "/wellness/ai-consent") => consent::put(host, &request),
        ("POST", "/wellness/checkins") => checkins::create(host, &request),
        ("GET", "/wellness/checkins") => checkins::list(host, &request),
        ("PATCH", "/wellness/checkins/:id") => checkins::change(host, &request),
        ("GET", "/wellness/medications") => medications::list(host),
        ("POST", "/wellness/medications") => medications::create(host, &request),
        ("PATCH", "/wellness/medications/:id") => medications::change(host, &request),
        ("GET", "/wellness/medications/schedule") => adherence::day(host, &request),
        ("GET", "/wellness/medications/logs") => adherence::summary(host, &request),
        ("POST", "/wellness/medications/:id/logs") => medications::log_dose(host, &request),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"error":"Internal server error"})))
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(
    host: &H,
    kind: &str,
    payload: &str,
) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route(host, request))?)
        }
        "api" => {
            let call: serde_json::Value = serde_json::from_str(payload)?;
            match call["name"].as_str() {
                Some("medicationAdherence") => Ok(serde_json::to_string(&adherence::counts(host)?)?),
                _ => Err(moss_module_sdk::Error::new("Unsupported Wellness function")),
            }
        }
        _ => Err(moss_module_sdk::Error::new("Unsupported Wellness invocation")),
    }
}
