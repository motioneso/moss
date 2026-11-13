//! Timestamp reading and writing shared by ingest and delete.
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};

/// Reads an ISO timestamp, or a bare date (read as midnight UTC). Anything else is `None`.
pub fn parse(text: &str) -> Option<DateTime<Utc>> {
    if text.is_empty() || text.len() > 40 {
        return None;
    }
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Some(at.with_timezone(&Utc));
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?.and_hms_opt(0, 0, 0).map(|t| t.and_utc())
}

/// Writes a timestamp in the form Postgres reads exactly, to the microsecond.
pub fn write(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Micros, true)
}
