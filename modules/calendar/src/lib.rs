//! Calendar's guest data layer. Actor identity and storage handles belong to the host.
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

#[cfg(target_arch = "wasm32")]
mod abi;
pub mod apply;
pub mod auto_plan;
pub mod cache;
mod display;
mod draft_tool;
pub mod events;
pub mod heartbeat;
mod jobs;
pub mod mirror;
pub mod model;
mod operations;
pub mod plans;
mod preview;
pub mod provider_tools;
mod saved_read;
pub mod settings;
pub mod settings_http;
pub mod visible_events;

#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub message: String,
    pub code: Option<&'static str>,
}
impl Error {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: None,
        }
    }
    pub fn coded(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: Some(code),
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
            "calendar.listVisibleEvents" => visible_events::read(host, &input.parameters),
            "calendar.createEvent" => provider_tools::create(host, &input.parameters),
            "calendar.deleteEvent" => provider_tools::delete(host, &input.parameters),
            "calendar.rescheduleEvent" => provider_tools::reschedule(host, &input.parameters),
            "calendar.dayPlanDraft" => draft_tool::save(host, &input.parameters),
            _ => Err(Error::new(404, "Calendar tool is unavailable")),
        }
        .map_err(|e| e.message)?;
        return serde_json::to_string(&result).map_err(|_| "Invalid calendar tool response".into());
    }
    if kind == "job" {
        let result = jobs::handle(host, payload).map_err(|e| e.message)?;
        return serde_json::to_string(&result).map_err(|_| "Invalid calendar job result".into());
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
            Err(error) => {
                let mut body = json!({"error":error.message});
                if let Some(code) = error.code {
                    body["code"] = json!(code);
                }
                Response::new(error.status, body)
            }
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
        "reserveAutoPlan" => Ok(json!({"reservation":auto_plan::reserve(host, serde_json::from_value(input)?)?})),
        "findUnfinishedBatch" => auto_plan::find_unfinished(host, serde_json::from_value(input)?),
        "getSourceSwitches" => source_switches(host, &input),
        "upsertCachedEvent" => cache::upsert(host, &input),
        "pruneCachedEvents" => cache::prune(host, &input),
        "importCalendarMirror" => mirror::import(host, &input),
        "evictCachedEvent" => jobs::evict(host, input["id"].as_str().unwrap_or("")),
        _ => Err(Error::new(404, "Calendar data operation not found")),
    }
}
/// The account's two source switches, each true unless the person turned it off. Briefings
/// reads this to honor the calendar choices. It takes no parameters and writes nothing.
fn source_switches(host: &impl Host, input: &Value) -> Result<Value> {
    if !input.as_object().is_some_and(|o| o.is_empty()) {
        return Err(Error::new(400, "Invalid calendar request"));
    }
    let stored = host.call("kv", "get", "calendar.source-behaviors", json!({}))?;
    let on = |key: &str| stored[key].as_bool().unwrap_or(true);
    Ok(json!({"briefings": on("briefings"), "planning": on("planning")}))
}
/// The original HTTP routes name the day `date` and resolve a missing
/// timezone from the account. Installed callers already send `localDay`.
/// Accept both spellings at the route boundary only.
fn original_day(host: &impl Host, mut value: Value, timezone_required: bool) -> Result<Value> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| Error::new(400, "Invalid calendar request"))?;
    let original = object.contains_key("date");
    if original && object.contains_key("localDay") {
        return Err(Error::new(400, "Use only one day field"));
    }
    if original
        && !timezone_required
        && object
            .keys()
            .any(|key| !matches!(key.as_str(), "date" | "timeZone" | "sourceRunId"))
    {
        return Err(Error::new(400, "Invalid calendar request"));
    }
    // Full source-run provenance needs a concrete public Briefings adapter.
    // Keep the original create envelope closed for linked runs until then.
    if original && !timezone_required {
        if let Some(source) = object.get("sourceRunId").filter(|id| !id.is_null()) {
            if source.as_str().is_none_or(|id| id.trim().is_empty()) {
                return Err(Error::new(400, "sourceRunId must be an id or null"));
            }
            return Err(Error::new(
                503,
                "Calendar source-run creation is unavailable",
            ));
        }
    }
    if !object.contains_key("localDay") {
        if let Some(date) = object.remove("date") {
            object.insert("localDay".into(), date);
        }
    } else {
        object.remove("date");
    }
    if object.get("timeZone").is_some_and(Value::is_null) {
        return Err(Error::new(400, "timeZone must be a valid IANA name"));
    }
    if !object.contains_key("timeZone") {
        if timezone_required {
            return Err(Error::new(400, "timeZone must be a valid IANA name"));
        }
        let locale = host.call("kv", "get", "calendar.chat-context", json!({}))?;
        let zone = locale["timezone"]
            .as_str()
            .filter(|zone| zone.len() <= 100 && zone.parse::<chrono_tz::Tz>().is_ok())
            .unwrap_or("America/Los_Angeles");
        object.insert("timeZone".into(), json!(zone));
    }
    Ok(value)
}

fn operation_param(request: &RouteRequest) -> String {
    request.params.get("operation_id").cloned().unwrap_or_default()
}

fn route(host: &impl Host, request: RouteRequest) -> Result<Value> {
    let id = request.params.get("id").cloned().unwrap_or_default();
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/events") => api(host, "listEvents", Value::Null),
        ("GET", "/events/:id") => api(host, "getEvent", json!({"id":id})),
        ("GET", "/day-plan") => {
            let query = original_day(host, json!(request.query), false)?;
            saved_read::read(host, serde_json::from_value(query)?)
        }
        ("POST", "/day-plans") => {
            let body = original_day(host, request.body, false)?;
            plans::create(host, serde_json::from_value(body)?)
        }
        ("PATCH", "/day-plans/:id/draft") => {
            let body = original_day(host, request.body, true)?;
            let mut input: plans::Save = serde_json::from_value(body)?;
            input.plan_id = id;
            plans::save(host, input)
        }
        ("POST", "/day-plans/:id/preview") => preview::preview(host, &id, request.body),
        ("POST", "/day-plans/:id/apply") => apply::route(host, &id, request.body),
        ("GET", "/day-plans/:id/operations/:operation_id") => operations::read(
            host,
            &id,
            request
                .params
                .get("operation_id")
                .map(String::as_str)
                .unwrap_or(""),
        ),
        ("POST", "/day-plans/:id/operations/:operation_id/retry") => {
            apply::retry_route(&id, &operation_param(&request), request.body)
        }
        ("POST", "/day-plans/:id/operations/:operation_id/recover") => {
            apply::recover_route(&id, &operation_param(&request), request.body)
        }
        ("POST", "/day-plans/:id/operations/:operation_id/confirm") => {
            apply::confirm_route(&id, &operation_param(&request), request.body)
        }
        ("GET", "/briefing-settings") => settings::read(host),
        ("PATCH", "/briefing-settings") => {
            settings::save(host, settings_http::normalize(request.body)?)
        }
        ("GET", "/source-behaviors") => Ok(host.call(
            "kv",
            "get",
            "calendar.source-behaviors",
            json!({}),
        )?),
        ("PATCH", "/source-behaviors") => {
            let object = request.body.as_object().filter(|o| {
                !o.is_empty()
                    && o.iter()
                        .all(|(k, v)| matches!(k.as_str(), "briefings" | "planning") && v.is_boolean())
            });
            if object.is_none() {
                return Err(Error::new(400, "Invalid calendar source switches"));
            }
            Ok(host.call("kv", "set", "calendar.source-behaviors", request.body)?)
        }
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
