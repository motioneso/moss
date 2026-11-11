//! Account display rules shared by the screen and its tests.
use serde_json::Value;

/// The mail health word for one account, from its saved status and last sync.
pub fn health(account: &Value) -> &'static str {
    if !account["revokedAt"].is_null() || account["status"] == "revoked" {
        return "revoked";
    }
    if account["status"] == "error" {
        return "error";
    }
    match account["lastSyncStatus"].as_str() {
        None => "never-synced",
        Some("success") => "healthy",
        Some("partial") => "sync-partial",
        Some(_) => "sync-failed",
    }
}

/// Plain label and badge tone for a health word.
pub fn health_label(word: &str) -> (&'static str, &'static str) {
    match word {
        "healthy" => ("Healthy", "forest"),
        "sync-partial" => ("Partly synced", "amber"),
        "sync-failed" => ("Last sync failed", "red"),
        "error" => ("Needs attention", "red"),
        "revoked" => ("Revoked", "neutral"),
        _ => ("Not synced yet", "neutral"),
    }
}

pub const EMAIL_SCOPES: [&str; 6] = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "email.read",
    "email.modify",
    "email.send",
];
pub const CALENDAR_SCOPES: [&str; 4] = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.readonly",
    "calendar.read",
    "calendar.write",
];

/// Whether the account holds any scope for the feature at all.
pub fn offers(account: &Value, feature: &str) -> bool {
    let wanted: &[&str] = if feature == "email" { &EMAIL_SCOPES } else { &CALENDAR_SCOPES };
    account["scopes"]
        .as_array()
        .is_some_and(|scopes| scopes.iter().any(|s| s.as_str().is_some_and(|s| wanted.contains(&s))))
}

/// A missing choice means on.
pub fn granted(stored: &Value, feature: &str) -> bool {
    stored[feature].as_bool().unwrap_or(true)
}

/// The admin audit line for a Connections event, and its category.
pub fn audit_phrase(action: &str, metadata: &Value) -> Option<String> {
    match action {
        "connector.feature_grant.set" => {
            let feature = match metadata["feature"].as_str() {
                Some("email") => "Email",
                Some("calendar") => "Calendar",
                _ => "a feature",
            };
            let state = if metadata["enabled"].as_bool().unwrap_or(false) { "on" } else { "off" };
            Some(format!("turned {feature} {state} for a connection"))
        }
        _ => None,
    }
}

/// The audit category the action belongs to.
pub fn audit_category(action: &str) -> &'static str {
    match action.split('.').next() {
        Some("connector") | Some("connection") => "Connections",
        _ => "Other",
    }
}
