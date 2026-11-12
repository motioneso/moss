//! Owner-started re-embed. The routes start, watch and cancel a run, and one job per step asks
//! the host to embed a small batch. The host keeps old vectors until the run is complete and then
//! swaps them in at once. Jobs carry only the run id, never passage text or a vector.
use crate::vault_index::{enqueue_now, new_id};
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub const STEP: &str = "memory.reembed-step";

fn answer(value: Value) -> Result<Value> {
    if let Some(refused) = value.get("refused") {
        return Err(Error::new(
            refused["status"].as_u64().unwrap_or(503) as u16,
            refused["message"].as_str().unwrap_or("Memory search is unavailable"),
        ));
    }
    Ok(value)
}

fn uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// The search model, how many passages use another one, how many facts have no vector, and the
/// latest run.
pub fn status_route(host: &impl Host) -> Result<Value> {
    answer(kv(host, "get", "memory.reembed", json!({}))?)
}

pub fn start_route(host: &impl Host) -> Result<Value> {
    let run = answer(kv(host, "set", "memory.reembed", json!({"action": "start"}))?)?;
    let id = run["id"].as_str().filter(|id| uuid_like(id)).ok_or_else(|| Error::new(500, "Internal server error"))?;
    enqueue_now(host, STEP, json!({"run-id": id}), &new_id(host)?)?;
    Ok(run)
}

pub fn cancel_route(host: &impl Host) -> Result<Value> {
    answer(kv(host, "set", "memory.reembed", json!({"action": "cancel"}))?)
}

/// One step. A run that is still going queues the next step, so a restart resumes from the
/// staged rows already saved.
pub fn handle_job(host: &impl Host, parameters: &Value) -> std::result::Result<String, String> {
    let run = parameters["run-id"].as_str().filter(|id| uuid_like(id)).ok_or("Memory re-embed is unavailable")?;
    let result = kv(host, "set", "memory.reembed", json!({"action": "step", "runId": run}))
        .map_err(|e| e.message)
        .and_then(|v| answer(v).map_err(|e| e.message))?;
    if result["status"] == "running" {
        let key = new_id(host).map_err(|_| "Memory re-embed is unavailable")?;
        enqueue_now(host, STEP, json!({"run-id": run}), &key).map_err(|_| "Memory re-embed is unavailable")?;
    }
    Ok(json!({
        "status": result["status"],
        "staged": result["staged"],
        "total": result["total"],
    })
    .to_string())
}

/// Gives facts that were saved without a vector another try. Failures are not reported.
pub fn retry_missing(host: &impl Host) {
    let _ = kv(host, "set", "memory.reembed", json!({"action": "retry-missing"}));
}
