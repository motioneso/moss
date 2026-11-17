//! `sports.heartbeatNextFixtures`. Reads only what the install-wide cache already holds and never
//! calls the sports provider, so a day nobody has loaded reads as unknown or stale.
use crate::briefing::{self, Input};
use crate::followed::{self, Follow};
use crate::public_cache::{self as cache, Store};
use crate::{catalog, eastern, overview};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ITEMS_MAX: i64 = 20;
const HOURS_MAX: i64 = 48;
const HOUR_MS: i64 = 3_600_000;

/// The read contract: only `horizonHours` (1 to 48) and `limit` (1 to 20), whole numbers.
/// Anything else, including a person's id, is refused.
pub fn read_input(input: &Value) -> Option<(i64, usize)> {
    let empty = serde_json::Map::new();
    let map = if input.is_null() { &empty } else { input.as_object()? };
    if map.keys().any(|key| key != "horizonHours" && key != "limit") {
        return None;
    }
    let whole = |key: &str, default: i64, max: i64| -> Option<i64> {
        let Some(value) = map.get(key) else { return Some(default) };
        let number = value.as_i64().or_else(|| value.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))?;
        (1..=max).contains(&number).then_some(number)
    };
    Some((whole("horizonHours", 24, HOURS_MAX)?, whole("limit", ITEMS_MAX, ITEMS_MAX)? as usize))
}

/// A cheap fingerprint of the fixture list that does not depend on the time. 32-bit FNV-1a over
/// UTF-16 units, so it matches what the old heartbeat produced.
fn revision(parts: &[String]) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for part in parts {
        for unit in part.encode_utf16() {
            hash ^= u32::from(unit);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        hash ^= 0x1f;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{}-{:08x}", parts.len(), hash)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

pub fn run<H: Host + ?Sized>(host: &H, horizon_hours: i64, limit: usize) -> Result<Value> {
    let now_ms = cache::now_ms(host)?;
    let follows: Vec<Follow> =
        overview::load_follows(host)?.into_iter().filter(|f| catalog::entry(&f.competition_key).is_some()).collect();
    let (mut games, mut freshness) = (vec![], "fresh");
    if !follows.is_empty() {
        let today = eastern::day_of(now_ms);
        let days = eastern::days_inclusive(&today, &eastern::add_days(&today, (horizon_hours + 23) / 24));
        let store = Store::load(host, cache::SCOREBOARD)?;
        let (mut reads, mut missing, mut stale) = (0, 0, 0);
        let mut boards: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for key in briefing::competitions(&follows) {
            if catalog::entry(&key).is_some_and(|e| e.news_feed_url.is_some()) {
                continue;
            }
            let mut board: Vec<Value> = vec![];
            for day in &days {
                reads += 1;
                match store.peek(&format!("{key}|{day}"), now_ms) {
                    None => missing += 1,
                    Some((value, live)) => {
                        stale += usize::from(!live);
                        for game in value.as_array().into_iter().flatten() {
                            let id = text(game, "id");
                            if id.is_empty() || !board.iter().any(|seen| text(seen, "id") == id) {
                                board.push(game.clone());
                            }
                        }
                    }
                }
            }
            boards.insert(key, board);
        }
        freshness = if reads == 0 || missing == reads {
            "unknown"
        } else if missing > 0 || stale > 0 {
            "stale"
        } else {
            "fresh"
        };
        let captured = iso(now_ms);
        let composed = briefing::compose(&Input {
            follows: &follows,
            boards: &boards,
            now_ms,
            zone: chrono_tz::UTC,
            degraded: missing > 0 || stale > 0,
            captured_at: &captured,
        });
        let until = now_ms + horizon_hours * HOUR_MS;
        games = composed["evidence"]["games"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|game| {
                let start = followed::instant_ms(text(game, "startsAt")).unwrap_or(i64::MAX);
                let phase = text(game, "phase");
                matches!(phase, "live" | "tonight" | "upcoming") && start <= until && (phase == "live" || start >= now_ms)
            })
            .collect();
    }
    let kept: Vec<&Value> = games.iter().take(limit).collect();
    let items: Vec<Value> = kept
        .iter()
        .map(|game| {
            let key = format!("fixture:{}:{}", text(game, "competitionKey"), text(game, "id"));
            json!({
                "entityKey": key, "episodeKey": format!("{key}:{}", text(game, "startsAt")),
                "title": game["headline"], "at": game["startsAt"], "kind": "fixture",
                "facts": {
                    "competitionKey": game["competitionKey"], "phase": game["phase"], "statusDetail": game["statusDetail"],
                    "homeScore": game["homeScore"], "awayScore": game["awayScore"],
                },
            })
        })
        .collect();
    let next = kept
        .iter()
        .filter_map(|g| followed::instant_ms(text(g, "startsAt")))
        .filter(|start| *start > now_ms)
        .min();
    let parts: Vec<String> = games
        .iter()
        .map(|g| {
            ["competitionKey", "id", "startsAt", "phase", "statusDetail"].iter().map(|k| text(g, k)).collect::<Vec<_>>().join("|")
        })
        .collect();
    Ok(json!({
        "source": "sports", "revision": revision(&parts), "nextBoundaryAt": next.map(iso),
        "freshness": freshness, "truncated": games.len() > limit, "items": items,
    }))
}
