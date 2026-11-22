//! Cached scoreboard, standings and news reads. A provider failure returns the empty answer
//! marked degraded, and nothing is cached for it.
use crate::public_cache::{self as cache, Store};
use crate::{espn, espn_games, espn_schedule, espn_standings};
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
        let page = espn::fetch_scoreboard(host, &espn::scoreboard_url(competition_key, day)?)?;
        Ok(Value::Array(espn_games::parse_scoreboard_page(&page, competition_key)?))
    })
}

/// The scoreboard cache read once for a whole request and written back once, the way `Feeds`
/// reads the news cache: a multi-day read otherwise reloads and rewrites the whole namespace
/// once per day.
pub struct Boards {
    store: Store,
    now: i64,
}

impl Boards {
    pub fn open<H: Host + ?Sized>(host: &H) -> Result<Self> {
        Ok(Self { store: Store::load(host, cache::SCOREBOARD)?, now: cache::now_ms(host)? })
    }

    /// One Eastern day of games from the shared session, `day` as YYYY-MM-DD. A miss is fetched
    /// and kept in the session; a provider failure reads as the degraded empty answer, like
    /// `scoreboard`, and is not cached.
    pub fn day<H: Host + ?Sized>(&mut self, host: &H, competition_key: &str, day: &str) -> Result<Answer> {
        let key = format!("{competition_key}|{day}");
        if let Some(hit) = self.store.get(&key, self.now) {
            return Ok(Answer { data: hit.clone(), degraded: false });
        }
        let loaded = || -> Result<Value> {
            let page = espn::fetch_scoreboard(host, &espn::scoreboard_url(competition_key, day)?)?;
            Ok(Value::Array(espn_games::parse_scoreboard_page(&page, competition_key)?))
        };
        match loaded() {
            Ok(data) => {
                self.store.put(&key, data.clone(), cache::SCOREBOARD_TTL_MS, self.now);
                Ok(Answer { data, degraded: false })
            }
            Err(_) => Ok(Answer { data: json!([]), degraded: true }),
        }
    }

    /// Writes back only when something changed. A failed write loses cache, never the answer.
    pub fn save<H: Host + ?Sized>(&mut self, host: &H) {
        self.store.save(host);
    }
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

/// One club's season schedule, keyed by competition and the club's permanent id.
pub fn schedule<H: Host + ?Sized>(host: &H, competition_key: &str, team_id: &str) -> Result<Answer> {
    let key = format!("{competition_key}|{team_id}");
    cached(host, cache::SCHEDULE, &key, cache::TEN_MINUTES_MS, json!([]), || {
        Ok(Value::Array(espn_schedule::fetch_schedule(host, competition_key, team_id)?))
    })
}

/// One club's completed results over a window ending at `to_ms`, rounded down to thirty seconds
/// so repeated reads share one cache entry. `fetched_at` is when the data was read from ESPN.
pub struct ResultsAnswer {
    pub results: Vec<Value>,
    pub degraded: bool,
    pub fetched_at: i64,
}

pub fn results<H: Host + ?Sized>(
    host: &H,
    competition_key: &str,
    team_id: &str,
    from_ms: i64,
    to_ms: i64,
) -> Result<ResultsAnswer> {
    let key = format!("{competition_key}|{team_id}|{from_ms}|{to_ms}");
    let now = cache::now_ms(host)?;
    let answer = cached(host, cache::RESULTS, &key, cache::SCOREBOARD_TTL_MS, json!({"fetchedAt": now, "results": []}), || {
        let results = espn_schedule::fetch_completed_results(host, competition_key, team_id, from_ms, to_ms)?;
        Ok(json!({"fetchedAt": now, "results": results}))
    })?;
    Ok(ResultsAnswer {
        results: answer.data["results"].as_array().cloned().unwrap_or_default(),
        degraded: answer.degraded,
        fetched_at: answer.data["fetchedAt"].as_i64().unwrap_or(now),
    })
}

/// The news cache read once for a whole request and written back once. Many feeds in one
/// overview would otherwise each load and rewrite the entire namespace.
pub struct Feeds {
    store: Store,
    now: i64,
}

impl Feeds {
    pub fn open<H: Host + ?Sized>(host: &H) -> Result<Self> {
        Ok(Self { store: Store::load(host, cache::HEADLINES)?, now: cache::now_ms(host)? })
    }

    pub fn headlines<H: Host + ?Sized>(&mut self, host: &H, competition_key: &str, team: Option<&str>) -> Result<Answer> {
        let key = format!("{competition_key}|{}", team.unwrap_or(""));
        if let Some(hit) = self.store.get(&key, self.now) {
            return Ok(Answer { data: hit.clone(), degraded: false });
        }
        let loaded = espn::fetch_json(host, &espn::headlines_url(competition_key, team)?)
            .and_then(|data| espn::parse_headlines(&data, competition_key));
        match loaded {
            Ok(list) => {
                let data = Value::Array(list);
                self.store.put(&key, data.clone(), cache::TEN_MINUTES_MS, self.now);
                Ok(Answer { data, degraded: false })
            }
            Err(_) => Ok(Answer { data: json!([]), degraded: true }),
        }
    }

    pub fn save<H: Host + ?Sized>(&mut self, host: &H) {
        self.store.save(host);
    }
}
