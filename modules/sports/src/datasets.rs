//! Cached scoreboard, standings and news reads. A provider failure returns the empty answer
//! marked degraded, and nothing is cached for it.
use crate::public_cache::{self as cache, Store};
use crate::{espn, espn_games, espn_standings};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

pub struct Answer {
    pub data: Value,
    pub degraded: bool,
}

fn cached<H: Host + ?Sized>(
    host: &H,
    namespace: &'static str,
    key: &str,
    ttl_ms: i64,
    empty: Value,
    load: impl FnOnce() -> Result<Value>,
) -> Result<Answer> {
    let now = cache::now_ms(host)?;
    let mut store = Store::load(host, namespace)?;
    if let Some(hit) = store.get(key, now) {
        return Ok(Answer { data: hit.clone(), degraded: false });
    }
    match load() {
        Ok(data) => {
            store.put(key, data.clone(), ttl_ms, now);
            store.save(host);
            Ok(Answer { data, degraded: false })
        }
        Err(_) => Ok(Answer { data: empty, degraded: true }),
    }
}

/// One Eastern day of games, `day` as YYYY-MM-DD.
pub fn scoreboard<H: Host + ?Sized>(host: &H, competition_key: &str, day: &str) -> Result<Answer> {
    cached(host, cache::SCOREBOARD, &format!("{competition_key}|{day}"), cache::SCOREBOARD_TTL_MS, json!([]), || {
        let data = espn::fetch_json(host, &espn::scoreboard_url(competition_key, day)?)?;
        Ok(Value::Array(espn_games::parse_scoreboard(&data, competition_key)?))
    })
}

pub fn standings<H: Host + ?Sized>(host: &H, competition_key: &str) -> Result<Answer> {
    cached(
        host,
        cache::STANDINGS,
        competition_key,
        cache::TEN_MINUTES_MS,
        json!({"sections": [], "season": null}),
        || Ok(espn_standings::parse_standings(&espn::fetch_json(host, &espn::standings_url(competition_key)?)?)),
    )
}

/// The news list, optionally for one club by its numeric id or short name.
pub fn headlines<H: Host + ?Sized>(host: &H, competition_key: &str, team: Option<&str>) -> Result<Answer> {
    let key = format!("{competition_key}|{}", team.unwrap_or(""));
    cached(host, cache::HEADLINES, &key, cache::TEN_MINUTES_MS, json!([]), || {
        let data = espn::fetch_json(host, &espn::headlines_url(competition_key, team)?)?;
        Ok(Value::Array(espn::parse_headlines(&data, competition_key)?))
    })
}
