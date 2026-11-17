//! Request parsing, allowed pairs and metadata cleaning for usefulness feedback.

use crate::{js_len, js_slice, Reject};
use serde_json::{Map, Value};

const INVALID: &str = "Usefulness feedback request is invalid";
pub const REASON_MAX: usize = 500;

pub const TARGET_KINDS: [&str; 6] = [
    "chat_message",
    "briefing_run",
    "briefing_item",
    "proactive_card",
    "news_story",
    "sports_story",
];
pub const SURFACES: [&str; 6] = ["chat", "briefing", "today", "proactive", "news", "sports"];
pub const KINDS: [&str; 7] = [
    "more_like_this",
    "less_like_this",
    "too_much",
    "wrong_priority",
    "not_useful",
    "remember_this",
    "dismiss",
];
pub const STATUSES: [&str; 3] = ["active", "undone", "superseded"];

/// A parsed create request. `reason` is present only for `less_like_this`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Create {
    pub target_kind: String,
    pub target_ref: String,
    pub surface: String,
    pub kind: String,
    pub reason: Option<String>,
}

fn kinds_for(target: &str) -> &'static [&'static str] {
    match target {
        "chat_message" => &["more_like_this", "not_useful", "remember_this"],
        "briefing_run" => &["more_like_this", "too_much", "not_useful", "dismiss"],
        "briefing_item" | "proactive_card" => &[
            "more_like_this",
            "too_much",
            "wrong_priority",
            "not_useful",
            "dismiss",
            "remember_this",
        ],
        "news_story" | "sports_story" => &["more_like_this", "less_like_this"],
        _ => &[],
    }
}

fn surfaces_for(target: &str) -> &'static [&'static str] {
    match target {
        "chat_message" => &["chat"],
        "briefing_run" => &["briefing"],
        "briefing_item" => &["briefing", "today"],
        "proactive_card" => &["proactive", "today"],
        "news_story" => &["news", "today"],
        "sports_story" => &["sports", "today"],
        _ => &[],
    }
}

pub fn pair_allowed(target: &str, surface: &str, kind: &str) -> bool {
    kinds_for(target).contains(&kind) && surfaces_for(target).contains(&surface)
}

/// The pairs that record a signal without any effect of their own.
pub fn record_only(target: &str, surface: &str, kind: &str) -> bool {
    let (surfaces, kinds): (&[&str], &[&str]) = match target {
        "chat_message" => (&["chat"], &["more_like_this", "not_useful"]),
        "briefing_run" => (
            &["briefing"],
            &["more_like_this", "too_much", "not_useful", "dismiss"],
        ),
        "briefing_item" => (
            &["briefing", "today"],
            &["more_like_this", "too_much", "wrong_priority", "dismiss"],
        ),
        "proactive_card" => (
            &["proactive", "today"],
            &["more_like_this", "too_much", "wrong_priority", "not_useful"],
        ),
        _ => return false,
    };
    surfaces.contains(&surface) && kinds.contains(&kind)
}

pub fn is_story_target(target: &str) -> bool {
    matches!(target, "news_story" | "sports_story")
}

pub fn story_module(target: &str) -> Option<&'static str> {
    match target {
        "news_story" => Some("news"),
        "sports_story" => Some("sports"),
        _ => None,
    }
}

pub fn story_target_for_module(module: &str) -> Option<&'static str> {
    match module {
        "news" => Some("news_story"),
        "sports" => Some("sports_story"),
        _ => None,
    }
}

/// Which way a saved action points, or nothing for kinds that never shape story relevance.
pub fn direction_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "less_like_this" => Some("less"),
        "more_like_this" => Some("more"),
        _ => None,
    }
}

fn invalid() -> Reject {
    Reject::new(400, INVALID)
}

fn object(value: &Value) -> Result<&Map<String, Value>, Reject> {
    value.as_object().ok_or_else(invalid)
}

fn one_of(value: Option<&Value>, allowed: &[&str]) -> Result<String, Reject> {
    match value.and_then(Value::as_str) {
        Some(text) if allowed.contains(&text) => Ok(text.to_owned()),
        _ => Err(invalid()),
    }
}

/// Trims the ends and nothing else, so the person sees their own words back.
fn normalize_reason(raw: &Value) -> Result<String, Reject> {
    let text = raw.as_str().ok_or_else(invalid)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(Reject::new(400, "A reason cannot be empty"));
    }
    if js_len(trimmed) > REASON_MAX {
        return Err(Reject::new(
            400,
            format!("A reason cannot be longer than {REASON_MAX} characters"),
        ));
    }
    Ok(trimmed.to_owned())
}

pub fn parse_create(body: &Value) -> Result<Create, Reject> {
    let map = object(body)?;
    for key in ["kind", "surface", "targetKind", "targetRef"] {
        if !map.contains_key(key) {
            return Err(invalid());
        }
    }
    if map
        .keys()
        .any(|k| !matches!(k.as_str(), "kind" | "surface" | "targetKind" | "targetRef" | "reason"))
    {
        return Err(invalid());
    }
    let target_ref = match map.get("targetRef").and_then(Value::as_str) {
        Some(text) if (1..=1024).contains(&js_len(text)) => text.to_owned(),
        _ => return Err(invalid()),
    };
    let target_kind = one_of(map.get("targetKind"), &TARGET_KINDS)?;
    let surface = one_of(map.get("surface"), &SURFACES)?;
    let kind = one_of(map.get("kind"), &KINDS)?;
    let reason = if kind == "less_like_this" {
        match map.get("reason") {
            None => return Err(Reject::new(400, "Less like this needs a reason")),
            Some(raw) => Some(normalize_reason(raw)?),
        }
    } else if map.contains_key("reason") {
        return Err(Reject::new(400, "This feedback action does not take a reason"));
    } else {
        None
    };
    Ok(Create { target_kind, target_ref, surface, kind, reason })
}

pub fn parse_signal(body: &Value) -> Result<Create, Reject> {
    let input = parse_create(body)?;
    if !record_only(&input.target_kind, &input.surface, &input.kind) {
        return Err(Reject::new(400, "Feedback target/action pair is not record-only"));
    }
    Ok(input)
}

/// The reason body of the edit route. Only a reason may be sent.
pub fn parse_reason_body(body: &Value) -> Result<String, Reject> {
    let map = object(body)?;
    match (map.len(), map.get("reason")) {
        (1, Some(raw)) => normalize_reason(raw),
        _ => Err(invalid()),
    }
}

/// The list filters: story target kinds to include, and a status.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListFilter {
    pub target_kind: Option<String>,
    pub status: Option<String>,
}

pub fn parse_list_query(pairs: &[(String, String)]) -> Result<ListFilter, Reject> {
    let mut filter = ListFilter::default();
    for (key, value) in pairs {
        match key.as_str() {
            "module" => {
                let kind = story_target_for_module(value).ok_or_else(invalid)?;
                filter.target_kind = Some(kind.to_owned());
            }
            "status" => {
                if !STATUSES.contains(&value.as_str()) {
                    return Err(invalid());
                }
                filter.status = Some(value.clone());
            }
            _ => return Err(invalid()),
        }
    }
    Ok(filter)
}

const MAX_METADATA_BYTES: usize = 2048;
const MAX_STRING: usize = 200;
const UNSAFE_KEY_PARTS: [&str; 11] = [
    "body", "excerpt", "external_id", "externalid", "prompt", "raw", "reason", "secret",
    "source_id", "sourceid", "summary",
];

fn unsafe_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    lower.contains("token") || UNSAFE_KEY_PARTS.iter().any(|part| lower.contains(part))
}

fn clean_object(map: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in map {
        let key = js_slice(key, MAX_STRING);
        if unsafe_key(&key) {
            continue;
        }
        out.insert(key, clean_value(value));
    }
    out
}

fn clean_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(js_slice(text, MAX_STRING)),
        Value::Array(items) => Value::Array(items.iter().take(20).map(clean_value).collect()),
        Value::Object(map) => Value::Object(clean_object(map)),
        other => other.clone(),
    }
}

/// The block-list cleaner for generic feedback metadata, bounded to 2 KB.
pub fn sanitize_metadata(input: &Value) -> Value {
    let cleaned = input.as_object().map(clean_object).unwrap_or_default();
    if Value::Object(cleaned.clone()).to_string().len() <= MAX_METADATA_BYTES {
        return Value::Object(cleaned);
    }
    let mut trimmed = Map::new();
    for (key, value) in cleaned {
        trimmed.insert(key.clone(), value);
        if Value::Object(trimmed.clone()).to_string().len() > MAX_METADATA_BYTES {
            trimmed.remove(&key);
            break;
        }
    }
    Value::Object(trimmed)
}

const STORY_KEYS: [&str; 9] = [
    "module",
    "headline",
    "sourceLabel",
    "publishedAt",
    "topicRef",
    "teamRef",
    "competitionRef",
    "hasEditorialEvidence",
    "isOpinion",
];

/// The allow-list cleaner for story target metadata. Unknown keys are dropped.
pub fn sanitize_story_metadata(input: &Value) -> Value {
    let mut out = Map::new();
    for (key, value) in input.as_object().into_iter().flatten() {
        if !STORY_KEYS.contains(&key.as_str()) {
            continue;
        }
        match value {
            Value::Bool(_) => {
                out.insert(key.clone(), value.clone());
            }
            Value::String(text) => {
                let spaced = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !spaced.is_empty() {
                    out.insert(key.clone(), Value::String(js_slice(&spaced, MAX_STRING)));
                }
            }
            _ => {}
        }
    }
    Value::Object(out)
}
