use crate::{Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

/// The wrapper uses existing account preferences, not a second settings store.
pub fn read(host: &impl Host) -> Result<Value> {
    let p = host.call("kv", "get", "calendar.briefing-settings", json!({}))?;
    Ok(json!({"settings":derive(&p)}))
}
pub fn save(host: &impl Host, body: Value) -> Result<Value> {
    patch(&body)?;
    let saved = host.call("kv", "set", "calendar.briefing-settings", body)?;
    Ok(json!({"settings":derive(&saved)}))
}

/// Validate again at the trusted boundary; the guest cannot choose arbitrary keys or owners.
pub fn patch(body: &Value) -> Result<Vec<(&'static str, Value)>> {
    let invalid = || Error::new(400, "Invalid calendar briefing settings");
    let object = body.as_object().ok_or_else(invalid)?;
    let mut writes = Vec::new();
    for (key, value) in object {
        let stored = match key.as_str() {
            "lookaheadDays" if matches!(value.as_f64(), Some(0.0 | 1.0 | 2.0)) => {
                "calendar.briefing_lookahead_days"
            }
            "prepTaskMode" if matches!(value.as_str(), Some("off" | "suggest" | "auto")) => {
                "calendar.prep_task_mode"
            }
            "timeBlockMode" if matches!(value.as_str(), Some("off" | "suggest" | "auto")) => {
                "calendar.time_block_mode"
            }
            "suggestTasks" if value.is_boolean() => "calendar.signal_suggest_tasks",
            "createTasks" if value.is_boolean() => "calendar.signal_create_tasks",
            "suggestTimeBlocks" if value.is_boolean() => "calendar.signal_suggest_time_blocks",
            "blockTime" if value.is_boolean() => "calendar.signal_block_time",
            _ => return Err(invalid()),
        };
        writes.push((stored, value.clone()));
    }
    Ok(writes)
}
pub fn derive(p: &Value) -> Value {
    let mode = |key: &str, auto: &str, suggest: &str| match p[key].as_str() {
        Some(value @ ("off" | "suggest" | "auto")) => value,
        _ if p[auto] == true => "auto",
        _ if p[suggest] == false => "off",
        _ => "suggest",
    };
    let prep = mode(
        "calendar.prep_task_mode",
        "calendar.signal_create_tasks",
        "calendar.signal_suggest_tasks",
    );
    let block = mode(
        "calendar.time_block_mode",
        "calendar.signal_block_time",
        "calendar.signal_suggest_time_blocks",
    );
    let days = p["calendar.briefing_lookahead_days"]
        .as_f64()
        .filter(|n| matches!(*n, 0.0 | 1.0 | 2.0))
        .unwrap_or(2.0) as i64;
    json!({"lookaheadDays":days,"prepTaskMode":prep,"timeBlockMode":block,"suggestTasks":prep!="off","createTasks":prep=="auto","suggestTimeBlocks":block!="off","blockTime":block=="auto"})
}
