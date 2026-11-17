//! Wellness package: mood check-ins, the assistant-access choice, therapy notes, the selective
//! export and the Wellness parts of account export and delete, all private to each owner. All
//! effects cross the guest-safe SDK Host interface. No model port is used, and no check-in or
//! note text is written to logs, jobs or activity.
pub mod account;
pub mod checkins;
pub mod consent;
pub mod cursor;
pub mod export;
pub mod input;
pub mod notes;
pub mod render;
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
        ("GET", "/wellness/therapy-notes") => notes::list(host),
        ("POST", "/wellness/therapy-notes") => notes::create(host, &request),
        ("DELETE", "/wellness/therapy-notes/:id") => notes::remove(host, &request),
        ("POST", "/wellness/export") => export::create(host, &request),
        ("GET", "/wellness/export/:id") => export::status(host, &request),
        ("GET", "/wellness/export/:id/download") => export::download(host, &request),
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
        "job" => export::run(host, payload),
        "api" => {
            let call = account::execute(host, serde_json::from_str(payload)?)
                .map_err(|_| moss_module_sdk::Error::new("Wellness account operation failed"))?;
            Ok(serde_json::to_string(&call)?)
        }
        _ => Err(moss_module_sdk::Error::new("Unsupported Wellness invocation")),
    }
}
