//! The four Scratchpad routes. Validation and error shapes live here; the host store does the SQL.
use crate::{shortcut, store::call};
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Map, Value};

pub const MAX_CHARS: usize = 64000;

/// Whitespace as the old web code counted it (JavaScript trim).
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// Length as the old web code counted it (UTF-16 units).
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn error(status: u16, message: &str) -> Response {
    Response::new(status, json!({"error": message}))
}

fn too_large() -> Response {
    Response::new(413, json!({"code": "scratchpad_too_large", "maxChars": MAX_CHARS}))
}

fn object(request: &RouteRequest) -> std::result::Result<&Map<String, Value>, Response> {
    request.body.as_object().ok_or_else(|| error(400, "Request body must be an object"))
}

/// Routes use the module-relative path template. Host failures never carry request text.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/note") => read(host),
        ("PUT", "/note") => replace(host, &request),
        ("POST", "/append") => append(host, &request),
        ("PATCH", "/settings") => settings(host, &request),
        _ => return Response::new(404, json!({"message": "Route not found"})),
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"message": "Internal server error"})))
}

fn read<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let mut note = call(host, "get", json!({}))?;
    if let Some(map) = note.as_object_mut() {
        map.insert("maxChars".into(), MAX_CHARS.into());
    }
    Ok(Response::new(200, note))
}

fn replace<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let map = match object(request) {
        Ok(map) => map,
        Err(response) => return Ok(response),
    };
    let Some(body) = map.get("body").and_then(Value::as_str) else {
        return Ok(error(400, "body must be a string"));
    };
    let Some(revision) = map.get("revision").and_then(non_negative_integer) else {
        return Ok(error(400, "revision must be a non-negative integer"));
    };
    if js_len(body) > MAX_CHARS {
        return Ok(too_large());
    }
    let saved = call(host, "put", json!({"body": body, "revision": revision}))?;
    if saved["ok"] == json!(true) {
        return Ok(Response::new(200, json!({"revision": saved["revision"], "updatedAt": saved["updatedAt"]})));
    }
    let current = &saved["current"];
    Ok(Response::new(
        409,
        json!({
            "error": "scratchpad_conflict",
            "body": current["body"],
            "revision": current["revision"],
            "updatedAt": current["updatedAt"].as_str().unwrap_or(""),
        }),
    ))
}

fn non_negative_integer(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().filter(|n| *n >= 0.0 && n.fract() == 0.0 && *n < 9e15).map(|n| n as u64))
}

fn append<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let map = match object(request) {
        Ok(map) => map,
        Err(response) => return Ok(response),
    };
    let Some(text) = map.get("text").and_then(Value::as_str) else {
        return Ok(error(400, "text must be a string"));
    };
    let text = text.trim_matches(is_js_space);
    if text.is_empty() {
        return Ok(error(400, "text must not be empty"));
    }
    if js_len(text) > MAX_CHARS {
        return Ok(too_large());
    }
    let added = call(host, "append", json!({"text": text}))?;
    if added["tooLarge"] == json!(true) {
        return Ok(too_large());
    }
    Ok(Response::new(
        200,
        json!({"revision": added["revision"], "updatedAt": added["updatedAt"], "appended": added["appended"]}),
    ))
}

fn settings<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let map = match object(request) {
        Ok(map) => map,
        Err(response) => return Ok(response),
    };
    let sync = match map.get("syncToNotes") {
        None => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => return Ok(error(400, "syncToNotes must be a boolean")),
    };
    let shortcut_text = match map.get("shortcut") {
        None => None,
        Some(Value::String(text)) if shortcut::is_valid(text) => Some(text.as_str()),
        Some(_) => return Ok(Response::new(400, json!({"code": "scratchpad_shortcut_invalid"}))),
    };
    let saved = call(host, "settings", json!({"syncToNotes": sync, "shortcut": shortcut_text}))?;
    if saved["notesFolderMissing"] == json!(true) {
        return Ok(Response::new(409, json!({"code": "scratchpad_notes_folder_missing"})));
    }
    Ok(Response::new(200, json!({"syncToNotes": saved["syncToNotes"], "shortcut": saved["shortcut"]})))
}
