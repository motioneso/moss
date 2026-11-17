//! Per-account Email and Calendar grants. A missing preference means granted.
use serde_json::{json, Value};

pub const EMAIL_SCOPES: [&str; 6] = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://mail.google.com/",
    "gmail",
    "gmail.readonly",
    "email.read",
];
pub const CALENDAR_SCOPES: [&str; 4] = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.readonly",
    "calendar",
    "calendar.readonly",
];

pub fn key(account_id: &str) -> String {
    format!("connector.{account_id}.feature_grants")
}

/// A stored value that is missing or not an object grants every feature.
pub fn is_granted(stored: &Value, feature: &str) -> bool {
    match stored.as_object() {
        None => true,
        Some(object) => object.get(feature) == Some(&Value::Bool(true)),
    }
}

fn has_any(scopes: &[String], wanted: &[&str]) -> bool {
    scopes.iter().any(|scope| wanted.contains(&scope.as_str()))
}

/// A feature is effective only when the account holds the scope and the grant is on.
pub fn effective(scopes: &[String], stored: &Value) -> Value {
    json!({
        "email": has_any(scopes, &EMAIL_SCOPES) && is_granted(stored, "email"),
        "calendar": has_any(scopes, &CALENDAR_SCOPES) && is_granted(stored, "calendar"),
    })
}

/// The value written back after a PUT: stored grants merged with the request.
pub fn merged(stored: &Value, email: Option<bool>, calendar: Option<bool>) -> Value {
    json!({
        "email": email.unwrap_or_else(|| is_granted(stored, "email")),
        "calendar": calendar.unwrap_or_else(|| is_granted(stored, "calendar")),
    })
}
