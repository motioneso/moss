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
                json!({"folder":folder.as_str().filter(|s| !s.is_empty())}),
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
        ("GET", "/people/notes-directories") => return directories(host, request).map(Some),
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

// Legacy browsing is relative to the selected People folder. The additive
// note-folders picker instead browses the account's allowed absolute roots.
fn directories(host: &impl Host, request: &RouteRequest) -> Result<Response> {
    let path = match request.query.get("path") {
        None => "",
        Some(serde_json::Value::String(path)) => path.trim_matches(crate::js_space),
        _ => return Err(moss_module_sdk::Error::new("Invalid directory query")),
    };
    let unavailable = || Response::new(400, json!({"error":"People notes folder is unavailable"}));
    if !host.call("vault", "notes.status", "people-notes", json!({}))?["available"]
        .as_bool()
        .unwrap_or(false)
    {
        return Ok(unavailable());
    }
    if path.starts_with(['/', '\\']) || path.split(['/', '\\']).any(|s| s == "..") {
        return Ok(unavailable());
    }
    let relative = path
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect::<Vec<_>>()
        .join("/");
    let Ok(value) = host.call(
        "vault",
        "notes.list",
        "people-notes",
        json!({"path":relative}),
    ) else {
        return Ok(unavailable());
    };
    let mut directories: Vec<_> = value["entries"].as_array().into_iter().flatten()
        .filter(|e| e["kind"] == "directory")
        .filter_map(|entry| entry["name"].as_str())
        .map(|name| json!({"name":name,"path":if relative.is_empty(){name.to_owned()}else{format!("{relative}/{name}")}}))
        .collect();
    directories.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(Response::new(
        200,
        json!({"path":if path.is_empty(){None}else{Some(path)},"directories":directories}),
    ))
}
