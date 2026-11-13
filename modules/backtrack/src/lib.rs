//! Backtrack package core (plan part 13): stored screen text, the pause switch, delete ranges,
//! the Mac upload with its clock check, the hourly sweep and the account export.
//! All effects cross the guest-safe SDK Host interface.
pub mod approval;
pub mod chunking;
pub mod clock;
pub mod codes;
pub mod ingest;
pub mod jobs;
pub mod lifecycle;
pub mod range;
pub mod redact;
pub mod store;
pub mod upkeep;
pub mod user_routes;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

/// Routes use the module-relative path template. Host failures never carry request text.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/status") => user_routes::status(host),
        ("PUT", "/preferences") => user_routes::set_paused(host, &request),
        ("DELETE", "/segments") => user_routes::delete(host, &request),
        ("POST", "/ingest") => ingest::post(host, &request),
        _ => return Response::new(404, json!({"message": "Route not found"})),
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"message": "Internal server error"})))
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(host: &H, kind: &str, payload: &str) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route(host, request))?)
        }
        "job" => jobs::handle(host, payload),
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported Backtrack invocation")),
    }
}

fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "prepareBacktrackRoute")]
        PrepareRoute(PrepareRoute),
        #[serde(rename = "collectBacktrackSegmentsExportSection")]
        Export(#[allow(dead_code)] Value),
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PrepareRoute {
        route: String,
        params_json: Option<String>,
        query_json: Option<String>,
        body_json: Option<String>,
    }
    Ok(match serde_json::from_str(payload)? {
        Api::PrepareRoute(r) => {
            let card = approval::prepare(&r.route, r.params_json.as_deref(), r.query_json.as_deref(), r.body_json.as_deref());
            json!({"ok": card})
        }
        Api::Export(_) => json!({"ok": lifecycle::collect(host)?}),
    }
    .to_string())
}
