use crate::Result;
use moss_module_sdk::Host;
use serde_json::{json, Value};

/// The wrapper reads existing account preferences; KV is a declared host service here,
/// never a second settings store. This slice deliberately exposes no authority-changing write.
pub fn read(host: &impl Host) -> Result<Value> {
    let p = host.call("kv", "get", "calendar.briefing-settings", json!({}))?;
    Ok(json!({"settings":derive(&p)}))
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
        .as_i64()
        .filter(|n| (0..=2).contains(n))
        .unwrap_or(2);
    json!({"lookaheadDays":days,"prepTaskMode":prep,"timeBlockMode":block,"suggestTasks":prep!="off","createTasks":prep=="auto","suggestTimeBlocks":block!="off","blockTime":block=="auto"})
}
