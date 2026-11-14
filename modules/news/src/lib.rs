//! News package: saved source and topic choices, added sources, excluded publishers and account
//! export, and adding a source. All effects cross the guest-safe SDK Host interface, including
//! public-web reads and model calls.
pub mod catalog;
pub mod compile;
pub mod domain;
pub mod input;
pub mod lifecycle;
pub mod personalization;
pub mod policy;
pub mod prefs;
pub mod previews;
pub mod resolve;
pub mod sources;
pub mod util;
pub mod web;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

/// Routes use the module-relative path template. A host failure leaves as a fixed message,
/// because host errors can carry request text.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/catalog") => Ok(Response::new(200, catalog::response())),
        ("GET", "/overview") => compile::overview(host),
        ("GET", "/prefs") => prefs::list(host),
        ("POST", "/prefs") => prefs::create(host, &request),
        ("DELETE", "/prefs/:id") => prefs::remove(host, &request),
        ("GET", "/personalization") => personalization::get(host),
        ("POST", "/source-exclusions") => personalization::add_exclusion(host, &request),
        ("DELETE", "/source-exclusions/:id") => personalization::remove_exclusion(host, &request),
        ("POST", "/topics") => personalization::add_topic(host, &request),
        ("PATCH", "/topics/:id") => personalization::change_topic(host, &request),
        ("DELETE", "/topics/:id") => personalization::remove_topic(host, &request),
        ("POST", "/sources/preview") => sources::preview(host, &request),
        ("POST", "/sources") => sources::confirm(host, &request),
        ("DELETE", "/sources/:id") => personalization::remove_source(host, &request),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"message":"Internal server error"})))
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(host: &H, kind: &str, payload: &str) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route(host, request))?)
        }
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported News invocation")),
    }
}

fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "collectNewsPersonalizationExportSection")]
        Export(#[allow(dead_code)] Value),
    }
    Ok(match serde_json::from_str(payload)? {
        Api::Export(_) => json!({"ok":lifecycle::collect(host)?}),
    }
    .to_string())
}
