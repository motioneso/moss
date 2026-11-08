//! Settings routes keep shared preferences in the host; no direct app.preferences access.
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::json;

pub fn route(host: &impl Host, request: &RouteRequest) -> Result<Option<Response>> {
    let (operation, resource, parameters) = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/people/notes-settings") => ("preference.read", "people-folder", json!({})),
        ("PUT", "/people/notes-settings") => {
            let Some(folder) = request
                .body
                .get("folder")
                .filter(|v| v.is_null() || v.is_string())
            else {
                return Ok(Some(Response::new(
                    400,
                    json!({"error":"Invalid folder setting"}),
                )));
            };
            (
                "preference.write",
                "people-folder",
                json!({"folder":folder}),
            )
        }
        ("GET", "/people/note-folders") => {
            let path = request
                .query
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            ("preference.folders", "people-folder", json!({"path":path}))
        }
        ("GET", "/people/note-suggestions") => ("preference.read", "people-suggestions", json!({})),
        ("PUT", "/people/note-suggestions") => {
            let Some(enabled) = request.body.get("enabled").and_then(|v| v.as_bool()) else {
                return Ok(Some(Response::new(
                    400,
                    json!({"error":"Invalid note suggestion setting"}),
                )));
            };
            (
                "preference.write",
                "people-suggestions",
                json!({"enabled":enabled}),
            )
        }
        _ => return Ok(None),
    };
    // Folder-selection failures are safe, actionable errors. Reads/backend failures
    // use the ordinary central error path; never expose filesystem/database detail.
    let result = host.call("kv", operation, resource, parameters);
    if request.method == "PUT" && resource == "people-folder" && result.is_err() {
        return Ok(Some(Response::new(
            400,
            json!({"error":"People notes folder is unavailable"}),
        )));
    }
    Ok(Some(Response::new(200, result?)))
}
