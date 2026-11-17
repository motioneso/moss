//! Web Research package: web search through the configured provider, the gate that says whether
//! search is on and the reasons it is off, and page reading through the host's public-web
//! fetch. No screen and no tables. All effects cross the guest-safe SDK Host interface.
pub mod brave;
pub mod gate;
pub mod reader;
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
        ("POST", "/read") => read_route(host, &request.body),
        _ => refuse(404, "Route not found"),
    }
}

/// Reads the addresses in the body. Like the tool, a page that cannot be read comes back as a
/// skipped entry with a fixed reason. A body with no address at all is a plain 400.
fn read_route<H: Host + ?Sized>(host: &H, body: &Value) -> Response {
    let any = body["urls"]
        .as_array()
        .is_some_and(|rows| rows.iter().any(Value::is_string));
    if !any {
        return refuse(400, "Give at least one address to read");
    }
    match reader::run(host, body) {
        Ok(data) => Response::new(200, data),
        Err(_) => refuse(500, "Web Research could not read"),
    }
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
            Ok(serde_json::to_string(&route_from(host, request))?)
        }
        "tool" => {
            let request = serde_json::from_str(payload)?;
            let result = tools::handle(host, request)
                .map_err(|_| moss_module_sdk::Error::new("Web Research tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new(
            "Unsupported Web Research invocation",
        )),
    }
}

/// The calls other packages make. News asks `webSearchStatus` for its gate and `webSearch` for
/// stories' sources. `webRead` reads pages like the tool. A failed search says so in fixed words.
fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "webSearch")]
        Search(Value),
        #[serde(rename = "webRead")]
        Read(Value),
        #[serde(rename = "webSearchStatus")]
        Status(#[allow(dead_code)] Value),
    }
    Ok(match serde_json::from_str(payload)? {
        Api::Status(_) => json!({"data": gate::current(host).status()}),
        Api::Read(input) => json!({"data": reader::run(host, &input)?}),
        Api::Search(input) => match search::run(host, &input) {
            Ok(data) => json!({"data": data}),
            Err(message) => json!({"error": message}),
        },
    }
    .to_string())
}
