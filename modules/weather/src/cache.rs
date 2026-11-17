//! Forecasts shared by everyone on the install, keyed by place rounded to about a kilometre
//! and by unit. An entry holds no person and no place name.
use chrono::{DateTime, Utc};
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};

const NAMESPACE: &str = "forecasts";
pub const FRESH_SECONDS: i64 = 30 * 60;
const MAX_ENTRIES: usize = 64;

pub fn key(kind: &str, lat: f64, lon: f64, unit: &str) -> String {
    format!("{kind}:{lat:.2}:{lon:.2}:{unit}")
}

fn load<H: Host + ?Sized>(host: &H) -> Map<String, Value> {
    match host.call("kv", "get", NAMESPACE, json!({})) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// A forecast fetched under 30 minutes ago.
pub fn read<H: Host + ?Sized>(host: &H, key: &str, now: DateTime<Utc>) -> Option<Value> {
    let entry = load(host).remove(key)?;
    let age = now.timestamp() - entry["at"].as_i64()?;
    ((0..FRESH_SECONDS).contains(&age)).then(|| entry["value"].clone())
}

/// A failed write only costs a later refetch.
pub fn write<H: Host + ?Sized>(host: &H, key: &str, value: Value, now: DateTime<Utc>) {
    let mut map = load(host);
    let at = now.timestamp();
    map.retain(|_, e| e["at"].as_i64().is_some_and(|t| (0..FRESH_SECONDS).contains(&(at - t))));
    while map.len() >= MAX_ENTRIES {
        let Some(oldest) = map.iter().min_by_key(|(_, e)| e["at"].as_i64()).map(|(k, _)| k.clone()) else { break };
        map.remove(&oldest);
    }
    map.insert(key.to_owned(), json!({"at": at, "value": value}));
    let _ = host.call("kv", "set", NAMESPACE, Value::Object(map));
}
