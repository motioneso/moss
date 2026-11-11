//! Memory guest. It validates requests, scores recall results and shapes responses. SQL, the
//! acting person, row-level security and the embedding service belong to the host, so no
//! vector or credential reaches this code. Candidates, lifecycle and screens are later parts.
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

#[cfg(target_arch = "wasm32")]
mod abi;
pub mod graph;
pub mod schema;
pub mod score;

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
        "route" => {
            let response = match serde_json::from_str::<RouteRequest>(payload) {
                Ok(request) => match route(host, request) {
                    Ok(body) => Response::new(200, body),
                    Err(error) => Response::new(error.status, json!({"error": error.message})),
                },
                Err(_) => Response::new(400, json!({"error": "Invalid memory request"})),
            };
            serde_json::to_string(&response).map_err(|_| "Invalid memory response".into())
        }
        "tool" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Tool {
                tool: String,
                parameters: Value,
            }
            let input: Tool = serde_json::from_str(payload).map_err(|_| "Invalid memory tool request")?;
            let result = match input.tool.as_str() {
                "memory.recall" => graph::recall_tool(host, &input.parameters),
                "memory.remember" => graph::remember_tool(host, &input.parameters),
                _ => Err(Error::new(404, "Memory tool not found")),
            };
            let value = result.map_err(|e| e.message)?;
            serde_json::to_string(&value).map_err(|_| "Invalid memory response".into())
        }
        _ => Err("Memory handler is unavailable".into()),
    }
}

fn route(host: &impl Host, request: RouteRequest) -> Result<Value> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/graph/recall") => graph::recall_route(host, &request),
        ("GET", "/graph/core") => graph::core_route(host),
        ("POST", "/graph/entities") => graph::entity_route(host, &request.body),
        ("POST", "/graph/facts") => graph::fact_route(host, &request.body),
        _ => Err(Error::new(404, "Memory route not found")),
    }
}
