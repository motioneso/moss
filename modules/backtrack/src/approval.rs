//! The approval card for deleting history, and the chat class of every route. A card never
//! grants approval and never changes data.
use crate::range::{parse_range, Range};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// How chat treats each route. Status is a read, the pause switch is blocked because it changes
/// what Moss may collect, and the delete needs its own approval.
pub const CHAT_CLASSES: [(&str, &str, &str); 4] = [
    ("GET", "/status", "read"),
    ("PUT", "/preferences", "blocked"),
    ("DELETE", "/segments", "destructive"),
    ("POST", "/ingest", "blocked"),
];

const EFFECT_ALL: &str = "Permanently delete this screen history and its searchable copies. This cannot be undone.";
const EFFECT_RANGE: &str = "Permanently delete this screen history and its searchable copies, up to the earlier of the selected end or the time this action runs. This cannot be undone.";

fn field(label: &str, value: &str) -> Value {
    json!({"label": label, "value": value})
}

fn version(value: &Value) -> String {
    Sha256::digest(value.to_string().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn object(text: Option<&str>) -> Option<Map<String, Value>> {
    match text {
        None => Some(Map::new()),
        Some(t) => serde_json::from_str::<Value>(t).ok()?.as_object().cloned(),
    }
}

/// The card for `route`, or `None` when the request is not one chat may offer for approval.
pub fn prepare(route: &str, params: Option<&str>, query: Option<&str>, body: Option<&str>) -> Option<Value> {
    if route != "deleteSegments" {
        return None;
    }
    let (params, query) = (object(params)?, object(query)?);
    if !params.is_empty() || !query.is_empty() {
        return None;
    }
    let body = match body {
        None => Value::Null,
        Some(text) => serde_json::from_str::<Value>(text).ok()?,
    };
    match parse_range(&body) {
        Range::Invalid(_) => None,
        Range::Everything => Some(json!({
            "title": "Delete all your Backtrack history", "content": "user_authored",
            "target": "All your stored Backtrack history",
            "fields": [field("Time range", "Everything stored up to the time this action runs"), field("Effect", EFFECT_ALL)],
            "version": version(&body),
        })),
        Range::Between(..) => Some(json!({
            "title": "Delete Backtrack history in a time range", "content": "user_authored",
            "target": "Your Backtrack history in this time range",
            "fields": [
                field("From", body["from"].as_str()?),
                field("To", body["to"].as_str()?),
                field("Effect", EFFECT_RANGE),
            ],
            "version": version(&body),
        })),
    }
}
