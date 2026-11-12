//! Explicit private copies of a summary version. Each copy goes through the Notes public API,
//! is created once and never overwritten. A receipt records what happened. Nothing here runs
//! unless the person asks for it.
use crate::export_render::render;
use crate::outputs;
use crate::schema::{id_params, strict_object, Failure, Kind};
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const EXPORTS: &str = "meetings.exports";
const DESTINATION: &str = "private-vault";

fn call<H: Host + ?Sized>(host: &H, operation: &str, meeting: &str, extra: Value) -> Result<Value> {
    let mut params = extra;
    params["meetingId"] = json!(meeting);
    host.call("kv", operation, EXPORTS, params)
}

fn refuse(status: u16, code: &str) -> Response {
    Response::new(status, json!({"code": code}))
}
fn invalid(failure: Failure) -> Response {
    Response::new(400, json!({"error": failure}))
}

fn hash(content: &str) -> String {
    Sha256::digest(content.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn now<H: Host + ?Sized>(host: &H) -> Result<String> {
    let context = host.call("context", "read", "call", json!({}))?;
    Ok(context["now"].as_str().unwrap_or_default().to_owned())
}

fn parse(text: &str) -> Result<Value> {
    Ok(serde_json::from_str(text)?)
}

/// Lists the receipts of one meeting, newest version first.
pub fn list<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_params(request) {
        Ok(id) => id.to_lowercase(),
        Err(f) => return Ok(invalid(f)),
    };
    if outputs::call(host, "get", &id, json!({}))?["found"] != true {
        return Ok(refuse(404, "meeting_not_found"));
    }
    let rows = call(host, "list", &id, json!({}))?;
    let receipts = rows["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(parse)
        .collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"receipts": receipts})))
}

/// Makes or finishes the copy of one version.
pub fn save<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_params(request) {
        Ok(id) => id.to_lowercase(),
        Err(f) => return Ok(invalid(f)),
    };
    let mut body = request.body.clone();
    if let Err(f) = strict_object(
        "body",
        &mut body,
        &["requestKey", "artifactVersion"],
        &[("requestKey", Kind::Uuid), ("artifactVersion", Kind::Int { min: 1, max: 1000 })],
        0,
    ) {
        return Ok(invalid(f));
    }
    let key = body["requestKey"].as_str().unwrap_or_default().to_lowercase();
    let version = body["artifactVersion"].as_i64().unwrap_or(0);
    if outputs::call(host, "lock", &id, json!({}))?["found"] != true {
        return Ok(refuse(404, "meeting_not_found"));
    }
    let previous = call(host, "request", &id, json!({"requestKey": key}))?;
    if previous["found"] == true {
        if previous["artifactVersion"].as_i64() != Some(version) {
            return Ok(refuse(409, "meeting_export_request_conflict"));
        }
        if let Some(done) = previous["resultJson"].as_str() {
            return Ok(answer(parse(done)?));
        }
    }
    let Some(artifact) = outputs::artifact(host, &id, version)? else {
        return Ok(refuse(404, "meeting_output_unavailable"));
    };
    let content = render(&artifact);
    let digest = hash(&content);
    let stored = call(host, "receipt", &id, json!({"version": version}))?;
    if stored["found"] == true && stored["contentHash"].as_str() != Some(digest.as_str()) {
        return Ok(refuse(409, "meeting_export_content_conflict"));
    }
    let receipt = if stored["found"] == true {
        parse(stored["receiptJson"].as_str().unwrap_or("{}"))?
    } else {
        let at = now(host)?;
        let fresh = json!({
            "meetingId": id, "artifactVersion": version, "destination": DESTINATION, "audience": "owner",
            "idempotencyKey": format!("meeting:{id}:artifact:{version}:{DESTINATION}"),
            "contentHash": digest, "noteReference": null, "writeStatus": "pending",
            "indexStatus": "not-requested", "indexJobId": null, "errorCode": null,
            "createdAt": at, "updatedAt": at});
        call(host, "intend", &id, json!({"version": version, "contentHash": digest,
            "receiptJson": fresh.to_string(), "writeStatus": "pending",
            "indexStatus": "not-requested", "updatedAt": at}))?;
        fresh
    };
    if previous["found"] != true {
        call(host, "reserve", &id, json!({"requestKey": key, "version": version}))?;
    }
    let result = stages(host, &id, version, receipt, &content)?;
    call(host, "finish", &id, json!({"version": version, "requestKey": key,
        "receiptJson": result.to_string(), "writeStatus": result["writeStatus"],
        "indexStatus": result["indexStatus"], "updatedAt": result["updatedAt"]}))?;
    Ok(answer(result))
}

fn answer(receipt: Value) -> Response {
    let status = if receipt["errorCode"] == "meeting_vault_conflict" { 409 } else { 200 };
    Response::new(status, json!({"receipt": receipt}))
}

/// One call into the Notes public API. A refusal or an unavailable Notes service is an error.
fn notes<H: Host + ?Sized>(host: &H, name: &str, id: &str, version: i64, content: &str) -> Result<Value> {
    host.call(
        "api",
        "call",
        "notes",
        json!({"name": name, "parameters": {"sourceId": id, "version": version, "content": content}}),
    )
}

/// Checks, then creates, then queues the index. Each stage keeps what an earlier attempt saved.
fn stages<H: Host + ?Sized>(host: &H, id: &str, version: i64, receipt: Value, content: &str) -> Result<Value> {
    let mut result = receipt;
    result["updatedAt"] = json!(now(host)?);
    let saved = result["writeStatus"] == "saved";
    let conflict = |mut r: Value| {
        r["writeStatus"] = json!(if r["writeStatus"] == "saved" { "saved" } else { "conflict" });
        r["indexStatus"] = json!(if r["indexStatus"] == "queued" { "queued" } else { "conflict" });
        r["errorCode"] = json!("meeting_vault_conflict");
        r
    };
    let failed = |mut r: Value| {
        r["writeStatus"] = json!(if r["writeStatus"] == "saved" { "saved" } else { "failed" });
        r["errorCode"] = json!("meeting_vault_write_failed");
        r
    };
    let Ok(seen) = notes(host, "inspectPrivateNote", id, version, content) else { return Ok(failed(result)) };
    let state = seen["status"].as_str().unwrap_or("");
    // A confirmed copy that disappeared is not recreated behind an editor's back.
    if state == "conflict" || (state == "missing" && saved) {
        return Ok(conflict(result));
    }
    let mut reference = seen["noteReference"].clone();
    if state == "missing" {
        let written = notes(host, "exportPrivateNote", id, version, content);
        let outcome = match written {
            Ok(done) if done["status"] != "conflict" && done["noteReference"].is_string() => Some(done),
            Ok(done) if done["status"] == "conflict" => return Ok(conflict(result)),
            // The write may have succeeded before its answer was lost, so look again and never rewrite.
            _ => match notes(host, "inspectPrivateNote", id, version, content) {
                Ok(again) if again["status"] == "conflict" => return Ok(conflict(result)),
                Ok(again) if again["status"] == "unchanged" => Some(again),
                _ => None,
            },
        };
        let Some(done) = outcome else { return Ok(failed(result)) };
        reference = done["noteReference"].clone();
    }
    result["writeStatus"] = json!("saved");
    result["noteReference"] = reference;
    result["errorCode"] = Value::Null;
    if result["indexStatus"] == "queued" {
        return Ok(result);
    }
    // Notes does not index private copies yet, so the index stays delayed and a later attempt retries.
    result["indexStatus"] = json!("delayed");
    result["indexJobId"] = Value::Null;
    result["errorCode"] = json!("meeting_index_delayed");
    Ok(result)
}
