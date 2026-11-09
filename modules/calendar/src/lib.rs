//! Calendar's guest data layer. Actor identity and storage handles belong to the host.
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

#[cfg(target_arch = "wasm32")]
mod abi;
mod display;
mod draft_tool;
pub mod events;
pub mod heartbeat;
pub mod model;
pub mod plans;
pub mod settings;

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
        Self::new(503, "Calendar data is unavailable")
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new(400, "Invalid calendar request")
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub fn handle(host: &impl Host, kind: &str, payload: &str) -> std::result::Result<String, String> {
    if matches!(kind, "health" | "install") {
        return Ok("{}".into());
    }
    if kind == "tool" {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Tool {
            tool: String,
            parameters: Value,
        }
        let input: Tool =
            serde_json::from_str(payload).map_err(|_| "Invalid calendar tool request")?;
        let result = match input.tool.as_str() {
            "calendar.heartbeatWindow" => heartbeat::read(host, &input.parameters),
            "calendar.dayPlanDraft" => draft_tool::save(host, &input.parameters),
            _ => Err(Error::new(404, "Calendar tool is unavailable")),
        }
        .map_err(|e| e.message)?;
        return serde_json::to_string(&result).map_err(|_| "Invalid calendar tool response".into());
    }
    if kind == "api" {
        let input: Value = serde_json::from_str(payload).map_err(|_| "Invalid calendar request")?;
        let data = api(
            host,
            input["name"].as_str().unwrap_or(""),
            input["parameters"].clone(),
        )
        .map_err(|e| e.message)?;
        return serde_json::to_string(&data).map_err(|_| "Invalid calendar response".into());
    }
    if kind != "route" {
        return Err("Calendar handler is unavailable".into());
    }
    let response = match serde_json::from_str::<RouteRequest>(payload) {
        Ok(request) => match route(host, request) {
            Ok(data) => Response::new(200, data),
            Err(error) => Response::new(error.status, json!({"error":error.message})),
        },
        Err(_) => Response::new(400, json!({"error":"Invalid calendar request"})),
    };
    serde_json::to_string(&response).map_err(|_| "Invalid calendar response".into())
}

fn api(host: &impl Host, name: &str, input: Value) -> Result<Value> {
    match name {
        "listEvents" => Ok(json!({"events":events::list(host)?})),
        "getEvent" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Input {
                id: String,
            }
            let input: Input = serde_json::from_value(input)?;
            Ok(
                json!({"event":events::get(host, &input.id)?.ok_or_else(|| Error::new(404,"Calendar event not found"))?}),
            )
        }
        "getPlan" => plans::get_for_day(host, serde_json::from_value(input)?),
        "createPlan" => plans::create(host, serde_json::from_value(input)?),
        "saveDraft" => plans::save(host, serde_json::from_value(input)?),
        _ => Err(Error::new(404, "Calendar data operation not found")),
    }
}
fn route(host: &impl Host, request: RouteRequest) -> Result<Value> {
    let id = request.params.get("id").cloned().unwrap_or_default();
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/events") => api(host, "listEvents", Value::Null),
        ("GET", "/events/:id") => api(host, "getEvent", json!({"id":id})),
        ("GET", "/day-plan") => {
            plans::get_for_day(host, serde_json::from_value(json!(request.query))?)
        }
        ("POST", "/day-plans") => plans::create(host, serde_json::from_value(request.body)?),
        ("PATCH", "/day-plans/:id/draft") => {
            let mut input: plans::Save = serde_json::from_value(request.body)?;
            input.plan_id = id;
            plans::save(host, input)
        }
        ("GET", "/briefing-settings") => settings::read(host),
        ("PATCH", "/briefing-settings") => settings::save(host, request.body),
        ("GET", "/display-settings") => display::read(host),
        ("PATCH", "/display-settings") => display::save(host, request.body),
        _ => Err(Error::new(404, "Calendar data operation not found")),
    }
}

pub(crate) fn context(host: &impl Host, operation: &str, resource: &str) -> Result<Value> {
    Ok(host.call("context", operation, resource, json!({}))?)
}
pub(crate) fn query(
    host: &impl Host,
    table: &str,
    query: &moss_module_sdk::query::Query,
) -> Result<Vec<Value>> {
    Ok(moss_module_sdk::Client(host).query(table, query)?)
}
