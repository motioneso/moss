//! Settings rules shared by the screen and its tests.
use serde_json::{json, Value};

/// Task creation choices as (value, label, description).
pub const MODES: [(&str, &str, &str); 4] = [
    ("off", "Off", "Never create tasks from email."),
    ("suggest", "Suggest", "Stage suggestions for your review (default)."),
    ("auto_safe", "Auto for safe items", "Auto-add bills and hard deadlines; stage the rest."),
    ("auto", "Auto", "Auto-add anything your assistant is confident about."),
];

/// The request that saves one changed choice, as (method, path, body).
pub fn save_request(key: &str, value: &Value) -> Option<(&'static str, &'static str, Value)> {
    Some(match key {
        "enabled" => ("PUT", "/briefing-source", json!({"enabled": value})),
        "mode" => ("PUT", "/task-creation-mode", json!({"mode": value})),
        "tier" => ("PUT", "/draft-policy", json!({"tier": value})),
        "createTasks" | "suggestReplies" | "draftReplies" | "autoSend" => {
            ("PATCH", "/briefing-settings", json!({ key: value }))
        }
        _ => return None,
    })
}

/// The draft policy tier a switch position stands for.
pub fn tier_for(on: bool) -> &'static str {
    if on { "trusted_auto" } else { "ask_each_time" }
}

/// Flattens the four settings replies into one object the screen reads.
pub fn combine(source: &Value, briefing: &Value, mode: &Value, policy: &Value) -> Value {
    let mut all = briefing["settings"].clone();
    all["enabled"] = source["enabled"].clone();
    all["mode"] = mode["mode"].clone();
    all["tier"] = policy["tier"].clone();
    all
}
