//! Meetings package core (part 1): owner-only records, personal notes and capture preferences.
//! All effects cross the guest-safe SDK Host interface.
pub mod approval;
pub mod js;
pub mod jobs;
pub mod lifecycle;
pub mod preferences;
pub mod records;
pub mod schema;
pub mod store;
pub mod text;
pub mod transcript;
pub mod transcript_batch;
pub mod transcript_routes;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

/// Routes use the module-relative path template. The first two failures are the shapes the
/// TypeScript app returned for an unknown route and for a host failure.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let records = records::Records::new(host);
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/records") => records.list(&request),
        ("POST", "/records") => records.create(request.body.clone()),
        ("GET", "/records/:id") => records.get(&request),
        ("DELETE", "/records/:id") => records.delete(&request),
        ("PUT", "/records/:id/title") => records.put_title(&request),
        ("PUT", "/records/:id/notes") => records.put_notes(&request),
        ("POST", "/records/:id/transcript") => transcript_routes::post(host, &request),
        ("GET", "/records/:id/transcript") => transcript_routes::get(host, &request),
        ("GET", "/records/:id/transcript/evidence") => transcript_routes::evidence(host, &request),
        ("GET", "/preferences") => preferences::get(host),
        ("PUT", "/preferences") => preferences::put(host, &request.body),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    // Host errors can carry request text, so only a fixed message leaves the guest.
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
        _ => Err(moss_module_sdk::Error::new("Unsupported Meetings invocation")),
    }
}

fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "prepareMeetingRoute")]
        PrepareRoute(PrepareRoute),
        #[serde(rename = "collectMeetingsExportSection")]
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
        Api::PrepareRoute(r) => approval::handle(
            host,
            &r.route,
            r.params_json.as_deref(),
            r.query_json.as_deref(),
            r.body_json.as_deref(),
        ),
        Api::Export(_) => json!({"ok":lifecycle::collect(host)?}),
    }
    .to_string())
}
