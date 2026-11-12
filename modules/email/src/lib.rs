//! Email guest. It validates requests, shapes responses and applies the preference
//! defaults. SQL, the acting person and row-level security belong to the host. The
//! package never reaches the network.
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

#[cfg(target_arch = "wasm32")]
mod abi;
pub mod cache;
pub mod fastify;
pub mod messages;
pub mod settings;
pub mod understand;
#[cfg(not(target_arch = "wasm32"))]
pub mod testing;

#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub message: String,
}
impl Error {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}
impl From<moss_module_sdk::Error> for Error {
    fn from(_: moss_module_sdk::Error) -> Self {
        Self::new(500, "Internal server error")
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn kv(host: &impl Host, operation: &str, resource: &str, params: Value) -> Result<Value> {
    Ok(host.call("kv", operation, resource, params)?)
}

pub fn handle(host: &impl Host, kind: &str, payload: &str) -> std::result::Result<String, String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "api" => {
            let input: Value =
                serde_json::from_str(payload).map_err(|_| "Invalid email request")?;
            let data = api(host, input["name"].as_str().unwrap_or(""), &input["parameters"])
                .map_err(|e| e.message)?;
            serde_json::to_string(&data).map_err(|_| "Invalid email response".into())
        }
        "route" => {
            let response = match serde_json::from_str::<RouteRequest>(payload) {
                Ok(request) => match route(host, request) {
                    Ok((status, body)) => Response::new(status, body),
                    Err(error) => Response::new(error.status, json!({"error":error.message})),
                },
                Err(_) => Response::new(400, json!({"error":"Invalid email request"})),
            };
            serde_json::to_string(&response).map_err(|_| "Invalid email response".into())
        }
        _ => Err("Email handler is unavailable".into()),
    }
}

/// The public API other packages call through the host.
fn api(host: &impl Host, name: &str, input: &Value) -> Result<Value> {
    match name {
        "insertCachedMessage" => cache::insert(host, input),
        "updateCachedMessage" => cache::update(host, input),
        "listCachedMessageKeys" => cache::keys(host, input),
        "pruneCachedMessages" => cache::prune(host, input),
        _ => Err(Error::new(404, "Email operation not found")),
    }
}

fn route(host: &impl Host, request: RouteRequest) -> Result<(u16, Value)> {
    let id = request.params.get("id").cloned().unwrap_or_default();
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/messages") => messages::list(host).map(|b| (200, b)),
        ("GET", "/messages/:id") => messages::detail(host, &id).map(|b| (200, b)),
        ("GET", "/briefing-settings") => settings::briefing(host).map(|b| (200, b)),
        ("PATCH", "/briefing-settings") => {
            settings::update_briefing(host, &request.body).map(|b| (200, b))
        }
        ("GET", "/task-creation-mode") => settings::task_mode(host).map(|b| (200, b)),
        ("PUT", "/task-creation-mode") => {
            settings::put_task_mode(host, &request.body).map(|b| (200, b))
        }
        ("GET", "/briefing-source") => settings::source(host).map(|b| (200, b)),
        ("PUT", "/briefing-source") => settings::put_source(host, &request.body).map(|b| (200, b)),
        ("GET", "/draft-policy") => settings::draft_policy(host).map(|b| (200, b)),
        ("PUT", "/draft-policy") => settings::put_draft_policy(host, &request.body).map(|b| (200, b)),
        _ => Err(Error::new(404, "Email route not found")),
    }
}
