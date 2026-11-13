//! Cleaning outside text before it joins a briefing section. Every value that came from another
//! person, mail, a calendar or a module passes through `sanitize_external`, so it can never
//! forge the block boundaries the writing step uses.
use crate::text::js_trim;
use serde_json::Value;

/// A string value with its whitespace collapsed. Anything that is not a string reads as empty.
pub fn collapse(value: &Value) -> String {
    match value.as_str() {
        Some(text) => js_trim(text).split_whitespace().collect::<Vec<_>>().join(" "),
        None => String::new(),
    }
}

/// Escapes the three markup characters. `&` goes first so entities are never escaped twice.
pub fn escape_markup(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

const SENTINELS: [&str; 4] =
    ["</trusted_instructions>", "<trusted_instructions", "</external_source>", "<external_source"];

/// Removes the four block boundary tokens, matching without regard to case. After escaping none
/// can remain, so this only guards against the escape step being weakened.
fn strip_sentinels(value: &str) -> String {
    let mut text = value.to_owned();
    for token in SENTINELS {
        while let Some(at) = text.to_ascii_lowercase().find(token) {
            text.replace_range(at..at + token.len(), "");
        }
    }
    text
}

pub fn sanitize_external(value: &Value) -> String {
    strip_sentinels(&escape_markup(&collapse(value)))
}

/// The same cleaning for a plain string.
pub fn sanitize_text(value: &str) -> String {
    sanitize_external(&Value::String(value.to_owned()))
}
