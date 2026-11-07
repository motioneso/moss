//! The shared server state and the one log writer.
//!
//! Every log line goes through [`log`], which redacts the whole value before it is written, so
//! a handler cannot put a token, password or credential into the log by accident.

use chrono::Utc;
use serde_json::Value;

use crate::auth::SessionCookies;
use crate::db::Database;
use crate::redact::redact_json;

/// What every platform route needs: one pool per runtime role and the cookie signer.
pub struct Platform {
    /// `jarvis_app_runtime`. Every signed-in read and write runs here in a data context.
    pub app: Database,
    /// `jarvis_auth_runtime`. Users, credential accounts and sessions only.
    pub auth: Database,
    pub sessions: SessionCookies,
}

/// Writes one redacted JSON line to stderr, with the time added.
pub fn log(mut line: Value) {
    if let Value::Object(fields) = &mut line {
        fields.insert("time".into(), Value::from(Utc::now().timestamp_millis()));
    }
    eprintln!("{}", redact_json(&line));
}
