//! Connectors guest. It validates requests, shapes responses and applies the grant and
//! health rules. Sealing secrets, SQL and the acting person all belong to the host.
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

#[cfg(target_arch = "wasm32")]
mod abi;
pub mod accounts;
pub mod fastify;
pub mod google;
pub mod imap;
pub mod grants;
pub mod health;
pub mod mail_sync;
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
                serde_json::from_str(payload).map_err(|_| "Invalid connectors request")?;
            let data = api(host, input["name"].as_str().unwrap_or(""), &input["parameters"])
                .map_err(|e| e.message)?;
            serde_json::to_string(&data).map_err(|_| "Invalid connectors response".into())
        }
        "route" => {
            let response = match serde_json::from_str::<RouteRequest>(payload) {
                Ok(request) => match route(host, request) {
                    Ok((status, body)) => Response::new(status, body),
                    Err(error) => Response::new(error.status, json!({"error":error.message})),
                },
                Err(_) => Response::new(400, json!({"error":"Invalid connectors request"})),
            };
            serde_json::to_string(&response).map_err(|_| "Invalid connectors response".into())
        }
        "job" => mail_sync::handle(host, payload),
        "tool" => {
            let input: Value =
                serde_json::from_str(payload).map_err(|_| "Invalid connectors request")?;
            match input["tool"].as_str() {
                Some("connectors.startGoogleGuidance") | Some("startGoogleGuidance") => {
                    serde_json::to_string(&google::guidance())
                        .map_err(|_| "Invalid connectors response".into())
                }
                _ => Err("Connectors tool is unavailable".into()),
            }
        }
        _ => Err("Connectors handler is unavailable".into()),
    }
}

fn api(host: &impl Host, name: &str, input: &Value) -> Result<Value> {
    match name {
        "connectionDiagnostics" => accounts::diagnostics(host, input["limit"].as_i64().unwrap_or(10)),
        _ => Err(Error::new(404, "Connectors operation not found")),
    }
}

fn route(host: &impl Host, request: RouteRequest) -> Result<(u16, Value)> {
    let id = request.params.get("id").cloned().unwrap_or_default();
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/providers") => accounts::providers(host).map(|b| (200, b)),
        ("GET", "/accounts") => accounts::list(host).map(|b| (200, b)),
        ("POST", "/accounts") => accounts::create(host, &request.body).map(|b| (201, b)),
        ("PATCH", "/accounts/:id") => accounts::update(host, &id, &request.body).map(|b| (200, b)),
        ("POST", "/accounts/:id/revoke") => accounts::revoke(host, &id).map(|b| (200, b)),
        ("GET", "/accounts/:id/feature-grants") => accounts::grants(host, &id).map(|b| (200, b)),
        ("PUT", "/accounts/:id/feature-grants") => {
            accounts::put_grants(host, &id, &request.body).map(|b| (200, b))
        }
        ("POST", "/google/authorize") => google::authorize(host, &request.body).map(|b| (200, b)),
        ("POST", "/google/complete") => google::complete(host, &request.body),
        ("POST", "/imap/test-connection") => imap::test_connection(host, &request.body).map(|b| (200, b)),
        ("POST", "/imap/connect") => imap::connect(host, &request.body),
        ("GET", "/admin/accounts") => accounts::admin_list(host).map(|b| (200, b)),
        _ => Err(Error::new(404, "Connectors route not found")),
    }
}
