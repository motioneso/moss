//! The person's private copies of story photos. The host keeps the bytes. This side keeps a small
//! record beside each copy and a bounded map from story to copy. Each copy has an image file and a
//! record file, and the record is written first so a half-written copy is still seen by a sweep.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Map, Value};

const FILES: &str = "source-photo-files";
const LINKS: &str = "source-photo-links";
const MAX_LINKS: usize = 2000;
pub const MAX_COPIES: usize = 200;
pub const MAX_BYTES: u64 = 41_943_040;
pub const RETENTION_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// A finished re-encode, ready to store.
pub struct Photo {
    pub body_base64: String,
    pub width: u64,
    pub height: u64,
    pub original_width: u64,
    pub original_height: u64,
    pub bytes: u64,
}

/// Asks the host to decode and re-encode a downloaded picture. `Err(reason)` says why it was
/// refused ("too-small" or "undecodable").
pub fn reencode<H: Host + ?Sized>(host: &H, body_base64: &str) -> Result<std::result::Result<Photo, String>> {
    let answer = host.call("kv", "reencode", FILES, json!({"bodyBase64": body_base64, "maxWidth": 1280, "maxHeight": 720}))?;
    if answer["ok"].as_bool() != Some(true) {
        return Ok(Err(answer["reason"].as_str().unwrap_or("undecodable").to_owned()));
    }
    let number = |key: &str| answer[key].as_u64().unwrap_or(0);
    Ok(Ok(Photo {
        body_base64: answer["bodyBase64"].as_str().unwrap_or_default().to_owned(),
        width: number("width"),
        height: number("height"),
        original_width: number("originalWidth"),
        original_height: number("originalHeight"),
        bytes: number("bytes"),
    }))
}

fn image_name(key: &str) -> String {
    format!("{key}.jpg")
}
fn record_name(key: &str) -> String {
    format!("{key}.json")
}

/// Stores a copy, record first.
pub fn put<H: Host + ?Sized>(host: &H, key: &str, source_id: &str, publisher_url: &str, photo: &Photo, now_ms: i64) -> Result<()> {
    let record = json!({
        "sourceId": source_id, "publisherUrl": publisher_url, "fetchedAt": now_ms, "lastServedAt": now_ms,
        "originalWidth": photo.original_width, "originalHeight": photo.original_height,
        "width": photo.width, "height": photo.height, "bytes": photo.bytes,
    });
    host.call("kv", "put", FILES, json!({"name": record_name(key), "text": record.to_string()}))?;
    host.call("kv", "put", FILES, json!({"name": image_name(key), "bodyBase64": photo.body_base64}))?;
    Ok(())
}

/// The stored image as base64, and a record of the serve.
pub fn serve<H: Host + ?Sized>(host: &H, key: &str, now_ms: i64) -> Result<Option<String>> {
    let answer = host.call("kv", "get", FILES, json!({"name": image_name(key)}))?;
    if answer["found"].as_bool() != Some(true) {
        return Ok(None);
    }
    if let Some(mut record) = record(host, key)? {
        record["lastServedAt"] = json!(now_ms);
        host.call("kv", "put", FILES, json!({"name": record_name(key), "text": record.to_string()}))?;
    }
    Ok(answer["bodyBase64"].as_str().map(str::to_owned))
}

/// Keys of the copies that have an image file.
pub fn existing<H: Host + ?Sized>(host: &H) -> Result<std::collections::HashSet<String>> {
    let names = host.call("kv", "list", FILES, json!({}))?;
    Ok(names["names"].as_array().map(|a| a.iter().filter_map(|n| n.as_str()?.strip_suffix(".jpg").map(str::to_owned)).collect()).unwrap_or_default())
}

fn record<H: Host + ?Sized>(host: &H, key: &str) -> Result<Option<Value>> {
    let answer = host.call("kv", "get", FILES, json!({"name": record_name(key)}))?;
    Ok(answer["text"].as_str().and_then(|t| serde_json::from_str(t).ok()))
}

fn remove<H: Host + ?Sized>(host: &H, key: &str) -> Result<()> {
    host.call("kv", "delete", FILES, json!({"name": image_name(key)}))?;
    host.call("kv", "delete", FILES, json!({"name": record_name(key)}))?;
    Ok(())
}

/// Every copy's key, taken from the record files and from image files that lost their record.
fn keys<H: Host + ?Sized>(host: &H) -> Result<Vec<String>> {
    let names = host.call("kv", "list", FILES, json!({}))?;
    let mut keys: Vec<String> = names["names"]
        .as_array()
        .map(|a| a.iter().filter_map(|n| n.as_str()).filter_map(|n| n.strip_suffix(".json").or_else(|| n.strip_suffix(".jpg"))).map(str::to_owned).collect())
        .unwrap_or_default();
    keys.sort();
    keys.dedup();
    Ok(keys)
}

/// Removes copies unused for 14 days, then the least recently served until the copy count and
/// the total size are inside their limits. A copy with no record is removed.
pub fn sweep<H: Host + ?Sized>(host: &H, now_ms: i64) -> Result<()> {
    let mut kept: Vec<(String, i64, u64)> = Vec::new();
    for key in keys(host)? {
        match record(host, &key)? {
            Some(r) if now_ms - r["lastServedAt"].as_i64().unwrap_or(0) <= RETENTION_MS => {
                kept.push((key, r["lastServedAt"].as_i64().unwrap_or(0), r["bytes"].as_u64().unwrap_or(0)));
            }
            _ => remove(host, &key)?,
        }
    }
    kept.sort_by_key(|(_, served, _)| *served);
    let mut total: u64 = kept.iter().map(|(_, _, bytes)| bytes).sum();
    let mut count = kept.len();
    for (key, _, bytes) in &kept {
        if count <= MAX_COPIES && total <= MAX_BYTES {
            break;
        }
        remove(host, key)?;
        count -= 1;
        total -= bytes;
    }
    Ok(())
}

/// Removes every copy a source owns and the story links that point at them.
pub fn remove_source<H: Host + ?Sized>(host: &H, source_id: &str) -> Result<()> {
    for key in keys(host)? {
        if record(host, &key)?.is_some_and(|r| r["sourceId"] == source_id) {
            remove(host, &key)?;
        }
    }
    let mut links = links(host)?;
    let prefix = format!("{source_id}:");
    links.retain(|headline, _| !headline.starts_with(&prefix));
    host.call("kv", "set", LINKS, Value::Object(links)).map(|_| ())
}

fn links<H: Host + ?Sized>(host: &H) -> Result<Map<String, Value>> {
    Ok(match host.call("kv", "get", LINKS, Value::Null)? {
        Value::Object(map) => map,
        _ => Map::new(),
    })
}

pub fn link<H: Host + ?Sized>(host: &H, headline_id: &str) -> Result<Option<String>> {
    Ok(links(host)?.get(headline_id).and_then(|v| v["k"].as_str()).map(str::to_owned))
}

/// Remembers which copy belongs to which story. Past the limit the oldest links go first.
pub fn set_links<H: Host + ?Sized>(host: &H, new: &[(String, String)], now_ms: i64) -> Result<()> {
    if new.is_empty() {
        return Ok(());
    }
    let mut map = links(host)?;
    for (headline, key) in new {
        map.insert(headline.clone(), json!({"k": key, "at": now_ms}));
    }
    while map.len() > MAX_LINKS {
        let Some(oldest) = map.iter().min_by_key(|(_, v)| v["at"].as_i64().unwrap_or(0)).map(|(k, _)| k.clone()) else { break };
        map.remove(&oldest);
    }
    host.call("kv", "set", LINKS, Value::Object(map)).map(|_| ())
}
