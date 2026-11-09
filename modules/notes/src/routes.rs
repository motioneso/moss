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
            if request.query.keys().any(|k| k != "path")
                || request.query.get("path").is_some_and(|v| !v.is_string())
            {
                return Ok(Response::new(400, json!({"error":"Invalid folder query"})));
            }
            ("folder.list", json!({"path":request.query.get("path")}))
        }
        ("PUT", "/notes-source") => {
            if !request.body.is_null() && !request.body.is_object() {
                return Ok(Response::new(
                    400,
                    json!({"error":"Invalid folder selection"}),
                ));
            }
            let path = request.body.get("path").unwrap_or(&Value::Null);
            if !path.is_null() && !path.is_string() {
                return Ok(Response::new(
                    400,
                    json!({"error":"Invalid folder selection"}),
                ));
            }
            ("folder.set", json!({"path":path}))
        }
        _ => return Ok(Response::new(404, json!({"error":"Not Found"}))),
    };
    let value = host.call("vault", operation, "source", parameters)?;
    let mut response: Response = serde_json::from_value(value)?;
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
    let source: Response =
        serde_json::from_value(host.call("vault", "folder.get", "source", json!({}))?)?;
    if source.status != 200 {
        return Err(moss_module_sdk::Error::new("Notes source lookup failed"));
    }
    if source.body.as_str().is_none_or(str::is_empty) {
        return Ok(Response::new(
            409,
            json!({
                "error":"No notes source configured. Set a path via PUT /api/me/notes-source first."
            }),
        ));
    }
    let saved = crate::sync_worker::request_source(host, source.body.as_str().unwrap())?;
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
