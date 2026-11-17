//! Compiles a saved story preference into a small versioned rule. Pure, so saving never waits
//! on a model and never fails because of one.

use serde_json::{json, Value};

pub const RULE_VERSION: i64 = 1;
pub const MAX_TERMS: usize = 8;
const MIN_TERM: usize = 2;
const MAX_TERM: usize = 40;

const FILLER: &[&str] = &[
    "about", "all", "and", "any", "are", "but", "dont", "for", "from", "get", "has", "have", "his",
    "her", "its", "just", "like", "more", "much", "not", "now", "of", "on", "one", "only", "or",
    "other", "our", "out", "over", "please", "really", "see", "should", "showing", "so", "some",
    "stop", "such", "than", "that", "the", "their", "them", "then", "there", "these", "they",
    "this", "those", "too", "very", "want", "was", "were", "what", "when", "which", "who", "why",
    "with", "would", "you", "your",
];

fn filler(word: &str) -> bool {
    FILLER.contains(&word)
}

fn add_term(terms: &mut Vec<String>, value: Option<&Value>) {
    let Some(text) = value.and_then(Value::as_str) else {
        return;
    };
    let term = text.trim().to_lowercase();
    let len = crate::js_len(&term);
    if len < MIN_TERM || len > MAX_TERM || terms.contains(&term) {
        return;
    }
    terms.push(term);
}

fn reason_terms(reason: Option<&str>) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for raw in reason
        .unwrap_or("")
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
    {
        let len = crate::js_len(raw);
        if len < MIN_TERM || len > MAX_TERM || filler(raw) || words.iter().any(|w| w == raw) {
            continue;
        }
        words.push(raw.to_owned());
    }
    words
}

/// The rule for one story preference. `context` is the verified, allow-listed story context.
pub fn compile(
    module: &str,
    direction: &str,
    story_ref: &str,
    context: &Value,
    reason: Option<&str>,
) -> Value {
    let mut terms: Vec<String> = Vec::new();
    let stable: &[&str] = if module == "sports" {
        &["teamRef", "competitionRef"]
    } else {
        &["topicRef"]
    };
    for key in stable {
        add_term(&mut terms, context.get(*key));
    }
    for word in reason_terms(reason) {
        if terms.len() >= MAX_TERMS {
            break;
        }
        add_term(&mut terms, Some(&Value::String(word)));
    }
    terms.truncate(MAX_TERMS);
    json!({
        "version": RULE_VERSION,
        "module": module,
        "direction": direction,
        "storyRef": story_ref,
        "terms": terms,
    })
}

/// True when a stored rule can no longer be trusted: missing, empty, malformed or older.
pub fn needs_recompile(rule: &Value, version: Option<i64>) -> bool {
    match version {
        None => return true,
        Some(v) if v < RULE_VERSION => return true,
        _ => {}
    }
    let Some(map) = rule.as_object() else {
        return true;
    };
    let valid = map.get("version").and_then(Value::as_f64).is_some()
        && matches!(
            map.get("module").and_then(Value::as_str),
            Some("news" | "sports")
        )
        && matches!(
            map.get("direction").and_then(Value::as_str),
            Some("less" | "more")
        )
        && map
            .get("storyRef")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        && map
            .get("terms")
            .and_then(Value::as_array)
            .is_some_and(|t| t.iter().all(Value::is_string));
    !valid || map.get("version").and_then(Value::as_f64).unwrap_or(0.0) < RULE_VERSION as f64
}
