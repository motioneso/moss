//! Queue deliveries. A delivery is accepted only when it is metadata only, and the parameters
//! match the queue they came on.
use crate::compose::Composer;
use crate::morning::MorningComposer;
use crate::queue::{MANUAL, SCHEDULED};
use crate::run_job::{self, Fire};
use crate::text::is_uuid;
use moss_module_sdk::{Error, Host, Result};
use serde_json::Value;

const KEYS: [&str; 2] = ["queue", "parameters"];
const TYPES: [&str; 3] = ["morning", "evening", "weekly_review"];

pub fn is_metadata_only(payload: &Value) -> bool {
    payload.as_object().is_some_and(|map| map.keys().all(|key| KEYS.contains(&key.as_str())))
}

fn refused() -> Error {
    Error::new("Invalid job")
}

/// The parameters of one delivery, checked against the queue's declared shape.
fn fire(queue: &str, parameters: &Value) -> Result<Fire> {
    let map = parameters.as_object().ok_or_else(refused)?;
    let text = |key: &str| map.get(key).and_then(Value::as_str).ok_or_else(refused);
    let definition_id = text("definition-id")?;
    if !is_uuid(definition_id) || !TYPES.contains(&text("briefing-type")?) || map.len() != 3 {
        return Err(refused());
    }
    match queue {
        SCHEDULED if text("run-kind")? == "scheduled" => {
            Ok(Fire { scheduled: true, definition_id: definition_id.to_lowercase(), run_id: None })
        }
        MANUAL if is_uuid(text("briefing-run-id")?) => Ok(Fire {
            scheduled: false,
            definition_id: definition_id.to_lowercase(),
            run_id: Some(text("briefing-run-id")?.to_lowercase()),
        }),
        _ => Err(refused()),
    }
}

pub fn handle<H: Host + ?Sized>(host: &H, payload: &str) -> Result<String> {
    handle_with(host, &MorningComposer, payload)
}

pub fn handle_with<H: Host + ?Sized, C: Composer>(
    host: &H,
    composer: &C,
    payload: &str,
) -> Result<String> {
    let value: Value = serde_json::from_str(payload).map_err(|_| refused())?;
    if !is_metadata_only(&value) {
        return Err(Error::new("Job payload is not metadata only"));
    }
    let queue = value["queue"].as_str().unwrap_or_default();
    let fire = fire(queue, &value["parameters"])?;
    Ok(run_job::run(host, composer, &fire)?.to_json())
}
