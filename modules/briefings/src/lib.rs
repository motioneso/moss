//! Briefings package: definitions and runs routes, the run job, schedule alignment and account export.
//! All effects cross the guest-safe SDK Host interface.
pub mod action_rows;
pub mod auto_plan;
pub mod evening;
pub mod evening_prompt;
pub mod body;
pub mod chat_card;
pub mod compose;
pub mod definitions;
pub mod email_evidence;
pub mod external;
pub mod feedback;
pub mod gather;
pub mod gather_types;
pub mod jobs;
pub mod lenses;
pub mod lifecycle;
pub mod morning;
pub mod morning_order;
pub mod morning_prompt;
pub mod plan_context;
pub mod plan_prose;
pub mod plan_reconcile;
pub mod priority;
pub mod queue;
pub mod run_job;
pub mod runs;
pub mod schedule;
pub mod signals;
pub mod sources;
pub mod status;
pub mod text;
pub mod tools;
pub mod trust;
pub mod util;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

/// Routes use the module-relative path template. An unknown route and a host failure keep the
/// shapes the TypeScript app returned. Host errors can carry request text, so only a fixed
/// message leaves the guest.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/definitions") => definitions::list(host),
        ("POST", "/definitions") => definitions::create(host, &request),
        ("PATCH", "/definitions/:id") => definitions::update(host, &request),
        ("POST", "/definitions/:id/run") => runs::start(host, &request),
        ("GET", "/definitions/:id/runs") => runs::list(host, &request),
        ("GET", "/definitions/:id/runs/:run_id") => runs::get(host, &request),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
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
        "tool" => {
            let request = serde_json::from_str(payload)?;
            let result = tools::handle(host, request)
                .map_err(|_| moss_module_sdk::Error::new("Briefings tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        "job" => jobs::handle(host, payload),
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported Briefings invocation")),
    }
}

fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "collectBriefingsExportSection")]
        Export(#[allow(dead_code)] Value),
        #[serde(rename = "prepareBriefingAction")]
        Prepare(Prepare),
        #[serde(rename = "verifyBriefingFeedbackTarget")]
        Verify(feedback::Verify),
    }
    // A JSON string keeps the field order the card shows.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Prepare {
        tool: String,
        input_json: String,
    }
    Ok(match serde_json::from_str(payload)? {
        Api::Export(_) => json!({"ok":lifecycle::collect(host)?}),
        Api::Prepare(p) => chat_card::prepare(host, &p.tool, &p.input_json),
        Api::Verify(v) => feedback::verify(host, &v),
    }
    .to_string())
}
