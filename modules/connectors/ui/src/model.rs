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

/// The Google Cloud steps shown above the credential fields.
pub const GOOGLE_STEPS: [&str; 4] = [
    "Create a project in the Google Cloud Console.",
    "Enable the Gmail and Google Calendar APIs for it.",
    "Set up the consent screen as External and add yourself as a test user.",
    "Create an OAuth client of type Desktop app, then copy its client ID and secret here.",
];

/// True when both pasted credentials are long enough to be real.
pub fn google_credentials_ok(client_id: &str, client_secret: &str) -> bool {
    client_id.trim().len() > 8 && client_secret.trim().len() > 6
}

/// True when the pasted address is the localhost page Google sent the browser to, with a code.
pub fn google_redirect_ok(pasted: &str) -> bool {
    let pasted = pasted.trim();
    let rest = match pasted.strip_prefix("http://").or_else(|| pasted.strip_prefix("https://")) {
        Some(rest) => rest,
        None => return false,
    };
    let host = rest.split(['/', '?', '#', ':']).next().unwrap_or("");
    host == "localhost" && pasted.contains("code=")
}

/// Client ID and secret from a downloaded client JSON file, when it has both.
pub fn google_client_from_json(text: &str) -> Option<(String, String)> {
    let value: Value = serde_json::from_str(text).ok()?;
    let inner = value.get("installed").or_else(|| value.get("web")).unwrap_or(&value);
    Some((inner["client_id"].as_str()?.to_string(), inner["client_secret"].as_str()?.to_string()))
}

/// Plain words for a failed Google step, from the server's status and message.
pub fn google_error_text(status: u16, message: &str) -> String {
    match status {
        429 => "Too many tries. Wait a minute and try again.".to_string(),
        500 => "Google did not accept that. Check the client ID, the secret and the pasted address, then try again.".to_string(),
        _ if message.is_empty() => "That did not work. Start again from the consent screen.".to_string(),
        _ => message.to_string(),
    }
}
