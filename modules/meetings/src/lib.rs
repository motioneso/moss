//! Meetings package core (part 1): owner-only records, personal notes and capture preferences.
//! All effects cross the guest-safe SDK Host interface.
pub mod approval;
pub mod context_pack;
pub mod export_render;
pub mod export_service;
pub mod history;
pub mod js;
pub mod jobs;
pub mod lifecycle;
pub mod manual;
pub mod output_chunks;
pub mod output_prompt;
pub mod output_routes;
pub mod output_run;
pub mod output_service;
pub mod output_validation;
pub mod outputs;
pub mod preferences;
pub mod recording;
pub mod recording_filing;
pub mod recording_jobs;
pub mod recording_reading;
pub mod records;
pub mod capture_devices;
pub mod capture_errors;
pub mod capture_limit;
pub mod capture_selection;
pub mod ring_errors;
pub mod ring_import;
pub mod ring_source;
pub mod ring_upload;
pub mod ring_voice;
pub mod ring_voice_routes;
pub mod schema;
pub mod stop_summary;
pub mod store;
pub mod text;
pub mod transcript;
pub mod transcript_batch;
pub mod transcript_routes;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

/// Routes use the module-relative path template. The first two failures are the shapes the
/// TypeScript app returned for an unknown route and for a host failure.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let records = records::Records::new(host);
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/records") => records.list(&request),
        ("POST", "/records") => records.create(request.body.clone()),
        ("GET", "/records/:id") => records.get(&request),
        ("DELETE", "/records/:id") => records.delete(&request),
        ("PUT", "/records/:id/title") => records.put_title(&request),
        ("PUT", "/records/:id/notes") => records.put_notes(&request),
        ("POST", "/records/:id/transcript") => transcript_routes::post(host, &request),
        ("GET", "/records/:id/transcript") => transcript_routes::get(host, &request),
        ("GET", "/records/:id/transcript/evidence") => transcript_routes::evidence(host, &request),
        ("POST", "/history/search") => history::search(host, &request),
        ("GET", "/history/:id") => history::get(host, &request),
        ("GET", "/recording-types") => return recording_route(|| recording::Recording::new(host).get_types()),
        ("PUT", "/recording-types") => {
            return recording_route(|| recording::Recording::new(host).put_types(&request.body))
        }
        ("GET", "/records/:id/recording") => return recording_route(|| recording::Recording::new(host).get(&request)),
        ("PUT", "/records/:id/recording/type") => {
            return recording_route(|| recording::Recording::new(host).put_type(&request))
        }
        ("POST", "/manual-transcripts") => return recording_route(|| manual::post(host, &request)),
        ("GET", "/output-availability") => output_routes::availability(host),
        ("GET", "/records/:id/outputs") => output_routes::list(host, &request),
        ("GET", "/records/:id/outputs/:version") => output_routes::get(host, &request),
        ("POST", "/records/:id/outputs") => output_routes::post(host, &request),
        ("PUT", "/records/:id/outputs") => output_routes::put(host, &request),
        ("POST", "/records/:id/actions/:candidate_id/review") => output_routes::review(host, &request),
        ("GET", "/records/:id/exports") => export_service::list(host, &request),
        ("POST", "/records/:id/exports") => export_service::save(host, &request),
        ("POST", "/recording-uploads") => return ring(|| ring_upload::reserve(host, &request)),
        ("GET", "/recording-uploads/:id") => return ring(|| ring_upload::status(host, &request)),
        ("PUT", "/recording-uploads/:id/:kind/:index") => return ring(|| ring_upload::put_chunk(host, &request)),
        ("POST", "/recording-uploads/:id/finalize") => return ring(|| ring_upload::finalize(host, &request)),
        ("GET", "/recording-imports/:id") => return ring(|| ring_voice_routes::import_status(host, &request)),
        ("POST", "/voice-enablement") => return ring(|| ring_voice_routes::enable(host, &request)),
        ("POST", "/voice-enablement/:id/disable") => return ring(|| ring_voice_routes::disable(host, &request)),
        ("GET", "/voice-recordings") => return ring(|| ring_voice_routes::list(host, &request)),
        ("GET", "/voice-recordings/:id") => return ring(|| ring_voice_routes::get(host, &request)),
        ("POST", "/voice-recordings/:id/retry") => return ring(|| ring_voice_routes::retry(host, &request)),
        ("GET", "/preferences") => preferences::get(host),
        ("PUT", "/preferences") => preferences::put(host, &request.body),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    // Host errors can carry request text, so only a fixed message leaves the guest.
    result.unwrap_or_else(|_| Response::new(500, json!({"message":"Internal server error"})))
}

/// Recording routes answer a host failure with the old 503 body.
fn recording_route(run: impl FnOnce() -> moss_module_sdk::Result<Response>) -> Response {
    run().unwrap_or_else(|_| Response::new(503, json!({"code":"recording_unavailable"})))
}

/// Ring receiver routes answer a host failure with the legacy unavailable code.
fn ring(run: impl FnOnce() -> moss_module_sdk::Result<Response>) -> Response {
    run().unwrap_or_else(|_| Response::new(503, json!({"code": ring_errors::RingCode::ImportUnavailable.as_str()})))
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
        "job" => jobs::handle(host, payload),
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported Meetings invocation")),
    }
}

fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "prepareMeetingRoute")]
        PrepareRoute(PrepareRoute),
        #[serde(rename = "collectMeetingsExportSection")]
        Export(#[allow(dead_code)] Value),
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PrepareRoute {
        route: String,
        params_json: Option<String>,
        query_json: Option<String>,
        body_json: Option<String>,
    }
    Ok(match serde_json::from_str(payload)? {
        Api::PrepareRoute(r) => approval::handle(
            host,
            &r.route,
            r.params_json.as_deref(),
            r.query_json.as_deref(),
            r.body_json.as_deref(),
        ),
        Api::Export(_) => json!({"ok":lifecycle::collect(host)?}),
    }
    .to_string())
}
