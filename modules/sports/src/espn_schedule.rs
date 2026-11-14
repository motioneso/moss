//! One club's schedule and completed results from ESPN. The parsers take the response body as
//! data, so they run the same way on recorded fixtures and on live answers.
use crate::catalog;
use crate::espn::{self, encode_component, id_text, IMAGE_HOSTS};
use crate::espn_games;
use chrono::DateTime;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

const SITE_BASE: &str = "https://site.api.espn.com/apis/site/v2/sports";
const NINETY_DAYS_MS: i64 = 90 * 86_400_000;

fn schedule_base(competition_key: &str, team_id: &str) -> Result<(String, bool)> {
    let e = catalog::entry(competition_key).ok_or_else(|| Error::new("Unknown competition"))?;
    let url = format!("{SITE_BASE}/{}/{}/teams/{}/schedule", e.espn_sport, e.espn_league, encode_component(team_id));
    Ok((url, e.espn_sport == "soccer"))
}

/// The club's season schedule. Soccer answers in two disjoint slices, recent results with no
/// parameters and upcoming fixtures with `fixture=true`, so both are read and merged by event
/// id. One failed slice is tolerated and two failed slices fail the read.
pub fn fetch_schedule<H: Host + ?Sized>(host: &H, competition_key: &str, team_id: &str) -> Result<Vec<Value>> {
    let (url, soccer) = schedule_base(competition_key, team_id)?;
    if !soccer {
        return events_to_games(&espn::fetch_json(host, &url)?, competition_key);
    }
    let first = espn::fetch_json(host, &url);
    let second = espn::fetch_json(host, &format!("{url}?fixture=true"));
    if let (Err(e), Err(_)) = (&first, &second) {
        return Err(Error::new(e.to_string()));
    }
    let mut seen: Vec<String> = vec![];
    let mut games = vec![];
    for data in [first, second].into_iter().flatten() {
        for event in data["events"].as_array().into_iter().flatten() {
            if let Some(id) = id_text(&event["id"]) {
                if seen.contains(&id) {
                    continue;
                }
                seen.push(id);
            }
            games.push(espn_games::game(event, competition_key)?);
        }
    }
    Ok(games)
}

fn events_to_games(data: &Value, competition_key: &str) -> Result<Vec<Value>> {
    data["events"].as_array().into_iter().flatten().map(|e| espn_games::game(e, competition_key)).collect()
}

/// A crest link is kept only when it is plain https on a reviewed image host.
pub fn result_crest(value: &Value) -> Value {
    let Some(link) = value.as_str().filter(|l| l.len() <= 500) else { return Value::Null };
    let Some(rest) = link.strip_prefix("https://") else { return Value::Null };
    let host = rest.split(['/', '?']).next().unwrap_or_default();
    let clean = !link.contains('#')
        && !link.bytes().any(|b| b <= b' ' || b >= 0x7f)
        && !host.contains(['@', ':'])
        && IMAGE_HOSTS.contains(&host);
    if clean { json!(link) } else { Value::Null }
}

fn short_text(value: &Value) -> Option<String> {
    let t = value.as_str()?;
    (!t.trim().is_empty() && t.chars().count() <= 200).then(|| t.trim().to_owned())
}

fn digits(value: Option<String>) -> Option<String> {
    value.filter(|v| (1..=20).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()))
}

fn small_score(value: &Value) -> Value {
    let raw = if value.is_object() { &value["value"] } else { value };
    let n = match raw {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match n {
        Some(n) if n.fract() == 0.0 && (0.0..=1000.0).contains(&n) => json!(n as i64),
        _ => Value::Null,
    }
}

fn result_side(competitor: &Value) -> Option<Value> {
    let team = &competitor["team"];
    let id = digits(short_text(&team["id"]))?;
    let name = short_text(&team["displayName"]).or_else(|| short_text(&team["shortDisplayName"]))?;
    let logo = if team["logo"].is_null() { &team["logos"][0]["href"] } else { &team["logo"] };
    Some(json!({
        "id": id, "name": name, "crestUrl": result_crest(logo),
        "score": small_score(&competitor["score"]),
        "shootout": small_score(&competitor["shootoutScore"]),
        "aggregate": small_score(&competitor["aggregateScore"]),
    }))
}

fn is_full_time(name: &str) -> bool {
    ["STATUS_FINAL", "STATUS_FULL_TIME"].iter().any(|p| name.strip_prefix(p).is_some_and(|r| r.is_empty() || r.starts_with('_')))
}

/// Finished matches of one club inside `from_ms..=to_ms`, newest first. Completion must be
/// official, so an abandoned or cancelled match is never a result.
pub fn parse_completed_results(data: &Value, competition_key: &str, team_id: &str, from_ms: i64, to_ms: i64) -> Result<Vec<Value>> {
    let entry = catalog::entry(competition_key).ok_or_else(|| Error::new("Unknown result competition"))?;
    let mut by_key: Vec<(String, i64, Value)> = vec![];
    for event in data["events"].as_array().into_iter().flatten() {
        let (Some(id), Some(starts)) = (digits(short_text(&event["id"])), short_text(&event["date"])) else {
            continue;
        };
        let Some(instant) = crate::followed::instant_ms(&starts) else { continue };
        let competition = &event["competitions"][0];
        let status = if competition["status"].is_null() { &event["status"]["type"] } else { &competition["status"]["type"] };
        let status_name = short_text(&status["name"]).unwrap_or_default();
        if instant < from_ms || instant > to_ms || status["completed"] != true || status["state"] != "post" || !is_full_time(&status_name) {
            continue;
        }
        let competitors = competition["competitors"].as_array().cloned().unwrap_or_default();
        let pick = |side: &str| -> Vec<Value> { competitors.iter().filter(|c| c["homeAway"] == side).cloned().collect() };
        let (homes, aways) = (pick("home"), pick("away"));
        if homes.len() != 1 || aways.len() != 1 {
            continue;
        }
        let (Some(home), Some(away)) = (result_side(&homes[0]), result_side(&aways[0])) else { continue };
        if home["id"] == away["id"] || (home["id"] != team_id && away["id"] != team_id) {
            continue;
        }
        let league = &event["leagues"][0];
        let actual_key = short_text(&league["slug"]).unwrap_or_else(|| competition_key.to_owned());
        let actual = catalog::entry(&actual_key);
        let starts_iso = DateTime::from_timestamp_millis(instant).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or(starts);
        let result = json!({
            "id": id, "sport": entry.espn_sport, "competitionKey": actual_key,
            "competition": short_text(&league["name"]).or_else(|| actual.map(|a| a.label.to_owned())).unwrap_or_else(|| entry.label.to_owned()),
            "startsAt": starts_iso, "status": short_text(&status["detail"]).unwrap_or_else(|| "Final".into()),
            "home": home, "away": away,
        });
        let key = format!("{}:{id}", entry.espn_sport);
        match by_key.iter_mut().find(|(k, _, _)| *k == key) {
            Some(slot) => *slot = (key, instant, result),
            None => by_key.push((key, instant, result)),
        }
    }
    by_key.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(by_key.into_iter().map(|(_, _, r)| r).collect())
}

/// The results read for one club over a window of at most ninety days.
pub fn fetch_completed_results<H: Host + ?Sized>(host: &H, competition_key: &str, team_id: &str, from_ms: i64, to_ms: i64) -> Result<Vec<Value>> {
    let entry = catalog::entry(competition_key).filter(|e| e.news_feed_url.is_none());
    let valid = digits(Some(team_id.to_owned())).is_some() && to_ms >= from_ms && to_ms - from_ms <= NINETY_DAYS_MS;
    let entry = entry.filter(|_| valid).ok_or_else(|| Error::new("Invalid bounded results read"))?;
    let day = |ms: i64| DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y%m%d").to_string()).unwrap_or_default();
    let url = format!(
        "{SITE_BASE}/{}/{}/teams/{team_id}/schedule?dates={}-{}&limit=100",
        entry.espn_sport, entry.espn_league, day(from_ms), day(to_ms)
    );
    parse_completed_results(&espn::fetch_json(host, &url)?, competition_key, team_id, from_ms, to_ms)
}
