//! Manual refresh uses one fresh command per reference. The legacy standard
//! queue does not coalesce repeated singleton keys; retries of internal commands
//! still use the immutable reference path in jobs.rs.
use crate::jobs::{enqueue_index, IndexCommand};
use moss_module_sdk::{Error, Host, Response, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Refresh {
    source_refs: Vec<Source>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    source: String,
    source_ref_hash: String,
    source_version: Option<String>,
    reason: String,
}

pub(crate) fn refresh(host: &impl Host, body: &Value) -> Result<Response> {
    // Route validation has already applied the legacy schema and coercion to
    // the complete batch, so malformed later entries cannot publish earlier ones.
    let request: Refresh = serde_json::from_value(body.clone())?;
    for source in &request.source_refs {
        let id = host.call("context", "uuid", "new", json!({}))?["id"]
            .as_str()
            .ok_or_else(|| Error::new("Missing People command ID"))?
            .to_owned();
        enqueue_index(
            host,
            &IndexCommand {
                command_id: id,
                source: source.source.clone(),
                source_ref_hash: source.source_ref_hash.clone(),
                source_version: source.source_version.clone(),
                reason: source.reason.clone(),
            },
        )?;
    }
    Ok(Response::new(
        202,
        json!({"enqueued":request.source_refs.len()}),
    ))
}
