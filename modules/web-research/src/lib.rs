//! Web Research package: web search through the configured provider, the gate that says whether
//! search is on, and the reasons it is off. No screen, no tables and no page reading yet. All
//! effects cross the guest-safe SDK Host interface.
pub mod brave;
pub mod gate;
pub mod search;
pub mod tools;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

fn refuse(status: u16, message: &str) -> Response {
    Response::new(status, json!({"message": message}))
}

/// Routes use the module-relative path template.
pub fn route_from<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/status") => Response::new(200, gate::current(host).status()),
        _ => refuse(404, "Route not found"),
    }
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(host: &H, kind: &str, payload: &str) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route_from(host, request))?)
        }
        "tool" => {
            let request = serde_json::from_str(payload)?;
            let result = tools::handle(host, request).map_err(|_| moss_module_sdk::Error::new("Web Research tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported Web Research invocation")),
    }
}

/// The calls other packages make. News asks `webSearchStatus` for its gate and `webSearch` for
/// stories' sources. A failed search says so in fixed words.
fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "webSearch")]
        Search(Value),
        #[serde(rename = "webSearchStatus")]
        Status(#[allow(dead_code)] Value),
    }
    Ok(match serde_json::from_str(payload)? {
        Api::Status(_) => json!({"data": gate::current(host).status()}),
        Api::Search(input) => match search::run(host, &input) {
            Ok(data) => json!({"data": data}),
            Err(message) => json!({"error": message}),
        },
    }
    .to_string())
}
