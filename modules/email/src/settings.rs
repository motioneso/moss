//! Email preferences. A missing stored value means the default.
use crate::{fastify, kv, Result};
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};

pub const CREATE_TASKS: &str = "email.signal_create_tasks";
pub const SUGGEST_REPLIES: &str = "email.signal_suggest_replies";
pub const DRAFT_REPLIES: &str = "email.signal_draft_replies";
pub const AUTO_SEND: &str = "email.signal_auto_send";
pub const TASK_MODE: &str = "email.task_creation_mode";
pub const TASK_MODES: [&str; 4] = ["off", "suggest", "auto_safe", "auto"];
pub const DRAFT_TIERS: [&str; 2] = ["trusted_auto", "ask_each_time"];

const SIGNALS: [(&str, &str); 4] = [
    ("createTasks", CREATE_TASKS),
    ("suggestReplies", SUGGEST_REPLIES),
    ("draftReplies", DRAFT_REPLIES),
    ("autoSend", AUTO_SEND),
];

/// Three signals default on and only a stored `false` turns them off. Auto-send
/// defaults off and only a stored `true` turns it on.
pub fn shape(stored: &Value) -> Value {
    json!({
        "createTasks": stored[CREATE_TASKS] != json!(false),
        "suggestReplies": stored[SUGGEST_REPLIES] != json!(false),
        "draftReplies": stored[DRAFT_REPLIES] != json!(false),
        "autoSend": stored[AUTO_SEND] == json!(true),
    })
}

pub fn parse_mode(stored: &Value) -> &'static str {
    TASK_MODES
        .iter()
        .find(|mode| stored.as_str() == Some(mode))
        .copied()
        .unwrap_or("suggest")
}

fn read(host: &impl Host, keys: &[&str]) -> Result<Value> {
    kv(host, "get", "email.preferences", json!({"keys":keys}))
}

pub fn briefing(host: &impl Host) -> Result<Value> {
    let keys: Vec<&str> = SIGNALS.iter().map(|(_, key)| *key).collect();
    Ok(json!({"settings":shape(&read(host, &keys)?)}))
}

pub fn update_briefing(host: &impl Host, body: &Value) -> Result<Value> {
    let body = fastify::object(body)?;
    let mut values = Map::new();
    for (field, key) in SIGNALS {
        if let Some(value) = body.get(field) {
            values.insert(key.into(), json!(fastify::boolean(value, field)?));
        }
    }
    let stored = if values.is_empty() {
        let keys: Vec<&str> = SIGNALS.iter().map(|(_, key)| *key).collect();
        read(host, &keys)?
    } else {
        // The host returns every signal after the write, from the same transaction.
        kv(host, "set", "email.preferences", json!({"values":values}))?
    };
    Ok(json!({"settings":shape(&stored)}))
}

pub fn task_mode(host: &impl Host) -> Result<Value> {
    Ok(json!({"mode":parse_mode(&read(host, &[TASK_MODE])?[TASK_MODE])}))
}

pub fn put_task_mode(host: &impl Host, body: &Value) -> Result<Value> {
    let body = fastify::object(body)?;
    fastify::required(body, &["mode"])?;
    let mode = fastify::one_of(&body["mode"], "mode", &TASK_MODES)?;
    kv(host, "set", "email.preferences", json!({"values":{TASK_MODE:mode}}))?;
    Ok(json!({"mode":mode}))
}

/// The briefing switch is the `email.briefings` entry of the shared source-behavior
/// preference. It defaults on.
pub fn source(host: &impl Host) -> Result<Value> {
    let stored = kv(host, "get", "email.source-behaviors", json!({}))?;
    Ok(json!({"enabled":stored["enabled"] != json!(false)}))
}

pub fn put_source(host: &impl Host, body: &Value) -> Result<Value> {
    let body = fastify::object(body)?;
    fastify::required(body, &["enabled"])?;
    let enabled = fastify::boolean(&body["enabled"], "enabled")?;
    kv(host, "set", "email.source-behaviors", json!({"enabled":enabled}))?;
    Ok(json!({"enabled":enabled}))
}

/// Replies drafted without asking is the `email_drafts` action policy tier.
pub fn draft_policy(host: &impl Host) -> Result<Value> {
    let stored = kv(host, "get", "email.draft-policy", json!({}))?;
    let tier = DRAFT_TIERS
        .iter()
        .find(|tier| stored["tier"].as_str() == Some(tier))
        .copied()
        .unwrap_or("ask_each_time");
    Ok(json!({"tier":tier}))
}

pub fn put_draft_policy(host: &impl Host, body: &Value) -> Result<Value> {
    let body = fastify::object(body)?;
    fastify::required(body, &["tier"])?;
    let tier = fastify::one_of(&body["tier"], "tier", &DRAFT_TIERS)?;
    kv(host, "set", "email.draft-policy", json!({"tier":tier}))?;
    Ok(json!({"tier":tier}))
}

