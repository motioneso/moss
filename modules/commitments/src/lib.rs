//! Commitments package: commitment suggestions and their evidence, private to each owner. All effects
//! cross the guest-safe SDK Host interface. Extraction, email judgement, chat tools and the screens are later parts.
pub mod candidates;
pub mod extract;
pub mod heartbeat;
pub mod input;
pub mod jobs;
pub mod judge;
pub mod prefilter;
pub mod signature;
pub mod store;
pub mod tools;
pub mod util;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::json;

/// Routes use the module-relative path template. A host failure leaves as a fixed message,
/// because host errors can carry request text.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/candidates") => candidates::list(host, &request),
        ("GET", "/candidates/:id") => candidates::get(host, &request),
        ("PATCH", "/candidates/:id/status") => candidates::change_status(host, &request),
        ("POST", "/candidates/:id/resolve") => candidates::resolve(host, &request),
        ("POST", "/candidates/:id/suppress") => candidates::suppress(host, &request),
        ("POST", "/extract") => extract_route(host, &request),
        ("GET", "/extraction-state") => state_route(host),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"error":"Internal Server Error"})))
}

/// `POST /extract` queues one extraction run. The body names the source and nothing else.
fn extract_route<H: Host + ?Sized>(
    host: &H,
    request: &RouteRequest,
) -> moss_module_sdk::Result<Response> {
    match input::extract_source(&request.body) {
        Ok(kind) => {
            jobs::enqueue_extraction(host, &kind)?;
            Ok(Response::new(202, json!({"queued":true})))
        }
        Err(message) => Ok(util::bad_request(message)),
    }
}

/// `GET /extraction-state`: when each source was last read.
fn state_route<H: Host + ?Sized>(host: &H) -> moss_module_sdk::Result<Response> {
    let mut rows = Vec::new();
    for kind in extract::SOURCE_KINDS {
        if let Some(row) = store::extraction_state(host, kind)? {
            rows.push(json!({
                "sourceKind": kind,
                "lastExtractedAt": util::iso_or_null(&row["last_extracted_at"])?,
                "lastRunAt": util::iso_or_null(&row["last_run_at"])?,
            }));
        }
    }
    Ok(Response::new(200, json!(rows)))
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
        "tool" => Ok(serde_json::to_string(&tools::handle(host, payload)?)?),
        "job" => jobs::handle(host, payload),
        "api" => {
            let call: serde_json::Value = serde_json::from_str(payload)?;
            let input = &call["parameters"];
            let data = match call["name"].as_str() {
                Some("requestThreadJudgement") => jobs::request_thread_judgement(host, input)?,
                Some("prepareCommitmentAction") => tools::prepare(host, input)?,
                Some("prepareChatAction") => tools::prepare_chat(host, input)?,
                _ => {
                    return Err(moss_module_sdk::Error::new(
                        "Commitments operation not found",
                    ));
                }
            };
            Ok(serde_json::to_string(&data)?)
        }
        _ => Err(moss_module_sdk::Error::new(
            "Unsupported Commitments invocation",
        )),
    }
}
