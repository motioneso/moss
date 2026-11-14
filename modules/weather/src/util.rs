//! Small shared helpers: outside fetches, URL text, rounding and the clock.
use chrono::{DateTime, Utc};
use moss_module_sdk::Host;
use serde_json::{json, Value};

/// The outside service did not answer usably. It carries no text, because host errors can
/// repeat the request, and the request holds a person's place.
#[derive(Debug)]
pub struct Down;

pub const OPEN_METEO: &str = "api.open-meteo.com";
pub const GEOCODING: &str = "geocoding-api.open-meteo.com";
pub const NOMINATIM: &str = "nominatim.openstreetmap.org";
pub const IPWHO: &str = "ipwho.is";

/// One GET to an approved host. Any failure, non-200 status or non-JSON body is `Down`.
pub fn get_json<H: Host + ?Sized>(host: &H, domain: &str, url: &str) -> Result<Value, Down> {
    let reply = host.call("fetch", "get", domain, json!({"url": url})).map_err(|_| Down)?;
    if reply["status"].as_u64() != Some(200) {
        return Err(Down);
    }
    serde_json::from_str(reply["body"].as_str().ok_or(Down)?).map_err(|_| Down)
}

/// Percent-encodes everything except unreserved characters, like `encodeURIComponent`.
pub fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Rounds half up, the way the old app's `Math.round` did.
pub fn round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// The host's clock for this call.
pub fn now<H: Host + ?Sized>(host: &H) -> moss_module_sdk::Result<DateTime<Utc>> {
    let call = host.call("context", "read", "call", json!({}))?;
    let text = call["now"].as_str().ok_or_else(|| moss_module_sdk::Error::new("No clock"))?;
    DateTime::parse_from_rfc3339(text)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| moss_module_sdk::Error::new("No clock"))
}

pub fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn finite(value: &Value, min: f64, max: f64) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= min && *n <= max)
}
