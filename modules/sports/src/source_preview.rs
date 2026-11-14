//! Holds a checked source between its preview and its confirm. A package keeps no memory between
//! calls, so previews live in one per-person key-value namespace. An entry lasts ten minutes, a
//! person keeps at most ten, and confirming takes the entry out.
use crate::public_cache::now_ms;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Map, Value};

pub const NAMESPACE: &str = "source-previews";
pub const TTL_MS: i64 = 10 * 60 * 1000;
pub const MAX_PER_PERSON: usize = 10;

fn load<H: Host + ?Sized>(host: &H) -> Result<Map<String, Value>> {
    Ok(match host.call("kv", "get", NAMESPACE, Value::Null)? {
        Value::Object(map) => map,
        _ => Map::new(),
    })
}

fn save<H: Host + ?Sized>(host: &H, entries: Map<String, Value>) -> Result<()> {
    host.call("kv", "set", NAMESPACE, Value::Object(entries)).map(|_| ())
}

fn live(entry: &Value, now: i64) -> bool {
    entry["e"].as_i64().is_some_and(|expires| expires > now)
}

/// Stores one preview and returns the confirmation id.
pub fn put<H: Host + ?Sized>(host: &H, preview: Value) -> Result<String> {
    let now = now_ms(host)?;
    let id = host.call("context", "uuid", "new", json!({}))?["id"]
        .as_str()
        .ok_or_else(|| Error::new("The host sent no id"))?
        .to_owned();
    let mut entries = load(host)?;
    entries.retain(|_, entry| live(entry, now));
    while entries.len() >= MAX_PER_PERSON {
        let oldest = entries.iter().min_by_key(|(_, e)| e["e"].as_i64().unwrap_or(0)).map(|(k, _)| k.clone());
        match oldest {
            Some(key) => entries.remove(&key),
            None => break,
        };
    }
    entries.insert(id.clone(), json!({"e": now + TTL_MS, "v": preview}));
    save(host, entries)?;
    Ok(id)
}

/// The stored preview, removed so a confirm can only be used once.
pub fn take<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let now = now_ms(host)?;
    let mut entries = load(host)?;
    let found = entries.remove(id);
    if found.is_some() {
        save(host, entries)?;
    }
    Ok(found.filter(|entry| live(entry, now)).map(|entry| entry["v"].clone()))
}
