//! Previews waiting for a person to confirm. They live in this person's own key-value store, so
//! another person's confirmation id can never find them. Entries last ten minutes, a person keeps
//! at most ten, and confirming takes the entry out.
use crate::util::now_ms;
use moss_module_sdk::{Host, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const STORE: &str = "news.source-previews";
const TTL_MS: i64 = 10 * 60 * 1000;
const MAX_ENTRIES: usize = 10;

/// A verified source waiting to be saved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub candidate_id: String,
    pub label: String,
    pub canonical_domain: String,
    pub homepage_url: String,
    pub feed_url: Option<String>,
    pub retrieval_method: String,
    pub sample_count: usize,
    pub validation_fingerprint: String,
    pub redirect_note: Option<String>,
    pub confirmed_fetch_hosts: Vec<String>,
    pub icon_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub candidates: Vec<Candidate>,
    pub replace_source_id: Option<String>,
    pub created_at: i64,
}

type Entries = BTreeMap<String, Pending>;

fn load<H: Host + ?Sized>(host: &H) -> Result<Entries> {
    let value = host.call("kv", "get", STORE, json!({}))?;
    if value.is_null() {
        return Ok(Entries::new());
    }
    // Unreadable content counts as empty, so one bad write cannot lock a person out of adding.
    Ok(serde_json::from_value(value).unwrap_or_default())
}

fn save<H: Host + ?Sized>(host: &H, entries: &Entries) -> Result<()> {
    host.call("kv", "set", STORE, serde_json::to_value(entries)?)?;
    Ok(())
}

/// Stores a pending preview under `id`, dropping expired entries and the oldest beyond ten.
pub fn put<H: Host + ?Sized>(host: &H, id: &str, pending: Pending) -> Result<()> {
    let now = now_ms(host)?;
    let mut entries = load(host)?;
    entries.retain(|_, entry| now - entry.created_at <= TTL_MS);
    while entries.len() >= MAX_ENTRIES {
        let oldest = entries.iter().min_by_key(|(_, entry)| entry.created_at).map(|(id, _)| id.clone());
        match oldest {
            Some(oldest) => entries.remove(&oldest),
            None => break,
        };
    }
    entries.insert(id.to_owned(), pending);
    save(host, &entries)
}

/// Removes and returns the preview, or `None` when it is missing or past its ten minutes.
pub fn take<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Pending>> {
    let now = now_ms(host)?;
    let mut entries = load(host)?;
    let Some(found) = entries.remove(id) else { return Ok(None) };
    save(host, &entries)?;
    Ok((now - found.created_at <= TTL_MS).then_some(found))
}

/// The stored value as JSON, for tests that check what is kept.
pub fn raw<H: Host + ?Sized>(host: &H) -> Result<Value> {
    host.call("kv", "get", STORE, json!({}))
}
