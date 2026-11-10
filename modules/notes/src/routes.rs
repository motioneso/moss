//! Settings contracts, accessed only through the account-bound host folder service.
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let request: RouteRequest = serde_json::from_str(payload)?;
    let response = execute(host, &request)
        .unwrap_or_else(|_| Response::new(500, json!({"error":"Internal Server Error"})));
    Ok(serde_json::to_string(&response)?)
}
fn execute(host: &impl Host, request: &RouteRequest) -> Result<Response> {
    #[cfg(feature = "write-tools")]
    if request.method == "POST" && request.path == "/notes/sync" {
        // Keep the legacy stored-preference check. Resolving or walking files is
        // worker work; caller-supplied source/account fields are never forwarded.
        return Ok(manual_sync(host)
            .unwrap_or_else(|_| Response::new(500, json!({"error":"Internal server error"}))));
    }
    let (operation, parameters) = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/notes-source") => ("folder.get", json!({})),
        ("GET", "/notes-last-sync") => ("folder.status", json!({})),
        ("GET", "/notes-source/directories") => {
            let path = match crate::settings_input::query_path(request.query.get("path")) {
                Ok(path) => path,
                Err(message) => return Ok(crate::settings_input::validation(message)),
            };
            ("folder.list", json!({"path":path}))
        }
        ("PUT", "/notes-source") => {
            let path = match crate::settings_input::folder_path(&request.body) {
                Ok(path) => path,
                Err(message) => return Ok(crate::settings_input::validation(message)),
            };
            ("folder.set", json!({"path":path}))
        }
        _ => return Ok(Response::new(404, json!({"error":"Not Found"}))),
    };
    #[cfg(feature = "write-tools")]
    let parameters_path_is_null = parameters["path"].is_null();
    let value = host.call("vault", operation, "source", parameters)?;
    let mut response: Response = serde_json::from_value(value)?;
    #[cfg(feature = "write-tools")]
    if operation == "folder.set" && response.status == 200 {
        if parameters_path_is_null {
            crate::sync_worker::cancel_schedule(host);
        } else {
            crate::sync_worker::reconcile_schedule(host);
        }
    }
    if response.status == 200 {
        if operation == "folder.get" {
            response.body = json!({"path":response.body.as_str()});
        } else if operation == "folder.status" {
            let raw = response.body;
            response.body = json!({"lastSync":if raw.get("at").is_some_and(Value::is_string) {
                let mut status = json!({"at":raw["at"],"ingested":number(&raw,"ingested"),"skipped":number(&raw,"skipped"),"errors":number(&raw,"errors")});
                if let Some(error) = raw.get("lastError").filter(|v|v.is_string()) { status["lastError"] = error.clone(); }
                status
            } else { Value::Null }});
        }
    }
    Ok(response)
}

#[cfg(feature = "write-tools")]
fn manual_sync(host: &impl Host) -> Result<Response> {
    let Some(source) = crate::sync_worker::selected_source(host)? else {
        return Ok(Response::new(
            409,
            json!({
                "error":"No notes source configured. Set a path via PUT /api/me/notes-source first."
            }),
        ));
    };
    let saved = crate::sync_worker::request_source_coalesced(host, &source)?;
    crate::sync_worker::reconcile_schedule(host);
    // This is the durable request identity, not a claim of completed indexing.
    // Outer finalization must commit and publish before returning HTTP success.
    Ok(Response::new(202, json!({"jobId":saved["checkpointId"]})))
}
fn number(raw: &Value, key: &str) -> Value {
    raw.get(key)
        .filter(|v| v.is_number())
        .cloned()
        .unwrap_or(json!(0))
}
