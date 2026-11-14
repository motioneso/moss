//! The install-wide cache for public ESPN data. Each dataset lives under one fixed key-value
//! resource shared by every person. Entries are keyed by dataset, competition and day only, so
//! the cache never holds a person's id, a search query or a follow.
use chrono::{DateTime, Utc};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Map, Value};

pub const TEAMS: &str = "espn-teams";
pub const SCOREBOARD: &str = "espn-scoreboard";
pub const STANDINGS: &str = "espn-standings";
pub const HEADLINES: &str = "espn-headlines";
pub const SCHEDULE: &str = "espn-schedule";
pub const RESULTS: &str = "espn-results";
/// Every namespace the manifest lists as install-wide.
pub const NAMESPACES: [&str; 6] = [TEAMS, SCOREBOARD, STANDINGS, HEADLINES, SCHEDULE, RESULTS];

pub const TEAMS_TTL_MS: i64 = 24 * 60 * 60 * 1000;
pub const SCOREBOARD_TTL_MS: i64 = 3 * 60 * 1000;
pub const TEN_MINUTES_MS: i64 = 10 * 60 * 1000;

/// Most entries one namespace keeps. A full catalog of rosters fits, and day-keyed data prunes itself.
const MAX_ENTRIES: usize = 200;

/// The host's clock in milliseconds. Only the time is read from the context, never the actor.
pub fn now_ms<H: Host + ?Sized>(host: &H) -> Result<i64> {
    let context = host.call("context", "read", "call", json!({}))?;
    let at = context["now"].as_str().ok_or_else(|| Error::new("The host sent no time"))?;
    let at = DateTime::parse_from_rfc3339(at).map_err(|_| Error::new("The host sent a bad time"))?;
    Ok(at.with_timezone(&Utc).timestamp_millis())
}

/// One namespace, read once and written once per request.
pub struct Store {
    namespace: &'static str,
    entries: Map<String, Value>,
    dirty: bool,
}

impl Store {
    pub fn load<H: Host + ?Sized>(host: &H, namespace: &'static str) -> Result<Self> {
        let stored = host.call("kv", "get", namespace, Value::Null)?;
        let entries = match stored {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        Ok(Self { namespace, entries, dirty: false })
    }

    /// A live entry, or `None` when it is missing or expired.
    pub fn get(&self, key: &str, now: i64) -> Option<&Value> {
        let entry = self.entries.get(key)?;
        (entry["e"].as_i64()? > now).then(|| &entry["v"])
    }

    pub fn put(&mut self, key: &str, value: Value, ttl_ms: i64, now: i64) {
        self.entries.insert(key.to_owned(), json!({"e": now + ttl_ms, "v": value}));
        if self.entries.len() > MAX_ENTRIES {
            self.entries.retain(|_, e| e["e"].as_i64().is_some_and(|x| x > now));
        }
        while self.entries.len() > MAX_ENTRIES {
            let soonest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e["e"].as_i64().unwrap_or(0))
                .map(|(k, _)| k.clone());
            match soonest {
                Some(k) => self.entries.remove(&k),
                None => break,
            };
        }
        self.dirty = true;
    }

    /// Writes back only when something changed. A failed write loses cache, never the answer.
    pub fn save<H: Host + ?Sized>(&mut self, host: &H) {
        if self.dirty && host.call("kv", "set", self.namespace, Value::Object(self.entries.clone())).is_ok() {
            self.dirty = false;
        }
    }
}
