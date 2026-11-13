//! Briefings package: definitions and runs routes, schedule alignment and account export.
//! All effects cross the guest-safe SDK Host interface.
pub mod body;
pub mod definitions;
pub mod jobs;
pub mod lifecycle;
pub mod runs;
pub mod schedule;
pub mod sources;
pub mod text;
pub mod util;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

/// Routes use the module-relative path template. An unknown route and a host failure keep the
/// shapes the TypeScript app returned. Host errors can carry request text, so only a fixed
/// message leaves the guest.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/definitions") => definitions::list(host),
        ("POST", "/definitions") => definitions::create(host, &request),
        ("PATCH", "/definitions/:id") => definitions::update(host, &request),
        ("GET", "/definitions/:id/runs") => runs::list(host, &request),
        ("GET", "/definitions/:id/runs/:run_id") => runs::get(host, &request),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"message":"Internal server error"})))
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
        "job" => jobs::handle(payload),
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported Briefings invocation")),
    }
}

fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "collectBriefingsExportSection")]
        Export(#[allow(dead_code)] Value),
    }
    Ok(match serde_json::from_str(payload)? {
        Api::Export(_) => json!({"ok":lifecycle::collect(host)?}),
    }
    .to_string())
}
