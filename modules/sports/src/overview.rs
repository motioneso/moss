//! `GET /overview` and `GET /standings`: the followed cards, scoreboards and standings for the
//! signed-in person. Every ESPN read goes through the install-wide cache, and nothing here writes
//! a person's data anywhere but the response.
//!
//! Headline ranking, the gameday hero slides, the featured story and the tonight band belong to a
//! later part. Until then the overview carries no stories and a story hero with no headline.
use crate::espn::TeamRef;
use crate::followed::{self, Bundle, Follow};
use crate::identity::{self, Saved, Team};
use crate::{catalog, datasets, eastern, follows, public_cache as cache, roster};
use moss_module_sdk::{query::{Filter, Order, Query}, Client, Host, Response, Result, RouteRequest};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Shown when the person follows nothing, so the page is never empty.
const DEFAULT_SLATE: [&str; 5] = ["nfl", "nba", "nhl", "mlb", "eng.1"];
const FIXTURE_DAYS_BEFORE: i64 = -3;
const FIXTURE_DAYS_AFTER: i64 = 4;

fn follow_of(row: &Value) -> Result<Follow> {
    let dto = follows::dto(row)?;
    let text = |k: &str| dto[k].as_str().map(str::to_owned);
    Ok(Follow {
        id: text("id").unwrap_or_default(),
        competition_key: text("competitionKey").unwrap_or_default(),
        team_key: text("teamKey"),
        source_team_id: text("sourceTeamId"),
        created_at: text("createdAt").unwrap_or_default(),
    })
}

/// The person's follows, newest first, as row level security hands them over.
fn load_follows<H: Host + ?Sized>(host: &H) -> Result<Vec<Follow>> {
    let mut query = Query::select(Filter::All);
    query.order = vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    Client(host).query(follows::TABLE, &query)?.iter().map(follow_of).collect()
}

fn label_of(key: &str) -> String {
    catalog::entry(key).map(|e| e.label.to_owned()).unwrap_or_else(|| key.to_owned())
}

/// Games for every Eastern day in `from..=to`, one cached read per day, deduped by event id.
fn scoreboard_for_days<H: Host + ?Sized>(host: &H, key: &str, from: &str, to: &str, degraded: &mut bool) -> Result<Vec<Value>> {
    let mut seen: Vec<String> = vec![];
    let mut games = vec![];
    for day in eastern::days_inclusive(from, to) {
        let answer = datasets::scoreboard(host, key, &day)?;
        *degraded |= answer.degraded;
        for game in answer.data.as_array().cloned().unwrap_or_default() {
            let id = game["id"].as_str().unwrap_or_default().to_owned();
            if !id.is_empty() {
                if seen.contains(&id) {
                    continue;
                }
                seen.push(id);
            }
            games.push(game);
        }
    }
    Ok(games)
}

struct PerCompetition {
    scoreboard: Vec<Value>,
    standings: Value,
    teams: Vec<TeamRef>,
}

fn unique(keys: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for k in keys {
        if !out.contains(&k) {
            out.push(k);
        }
    }
    out
}

fn season_is_active(season: &Value, now_ms: i64) -> bool {
    let bound = |k: &str| season[k].as_str().and_then(followed::instant_ms);
    matches!((bound("start"), bound("end")), (Some(s), Some(e)) if now_ms >= s && now_ms <= e)
}

fn ambiguous(follow: &Follow, teams: &[TeamRef]) -> Value {
    let list: Vec<Team> = teams
        .iter()
        .map(|t| Team {
            team_key: t.team_key.clone(),
            abbreviation: t.abbreviation.clone(),
            name: t.name.clone(),
            source_team_id: t.source_team_id.clone(),
        })
        .collect();
    let resolved = identity::resolve(&Saved { team_key: follow.team_key.as_deref(), source_team_id: None }, &list);
    let candidates: Vec<Value> = resolved
        .candidates
        .iter()
        .filter_map(|c| {
            let id = c.source_team_id.as_deref()?;
            let crest = teams.iter().find(|t| t.source_team_id.as_deref() == Some(id)).and_then(|t| t.crest_url.clone());
            Some(json!({"sourceTeamId": id, "name": c.name, "crestUrl": crest}))
        })
        .collect();
    json!({
        "followId": follow.id, "competitionKey": follow.competition_key, "savedTeamKey": follow.team_key,
        "candidates": candidates, "teamListLoaded": resolved.team_list_loaded,
    })
}

pub fn overview<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let now_ms = cache::now_ms(host)?;
    let now_iso = chrono::DateTime::from_timestamp_millis(now_ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let mut degraded = false;
    let follows: Vec<Follow> = load_follows(host)?.into_iter().filter(|f| catalog::entry(&f.competition_key).is_some()).collect();
    let today = eastern::day_of(now_ms);
    let day_before = eastern::add_days(&today, -1);
    let keys = if follows.is_empty() {
        DEFAULT_SLATE.iter().map(|k| (*k).to_owned()).collect()
    } else {
        unique(follows.iter().map(|f| f.competition_key.clone()))
    };
    let followed_leagues: Vec<&Follow> = follows.iter().filter(|f| f.team_key.is_none()).collect();

    let mut per: HashMap<String, PerCompetition> = HashMap::new();
    for key in &keys {
        if catalog::entry(key).is_some_and(|e| e.news_feed_url.is_some()) {
            per.insert(key.clone(), PerCompetition { scoreboard: vec![], standings: json!({"sections": [], "season": null}), teams: vec![] });
            continue;
        }
        let scoreboard = scoreboard_for_days(host, key, &day_before, &today, &mut degraded)?;
        let standings = datasets::standings(host, key)?;
        degraded |= standings.degraded;
        let teams = roster::league_teams(host, key)?;
        degraded |= teams.degraded;
        per.insert(key.clone(), PerCompetition { scoreboard, standings: standings.data, teams: teams.teams });
    }
    let sections_of = |key: &str| per.get(key).and_then(|p| p.standings["sections"].as_array().cloned()).unwrap_or_default();

    // A follow with no permanent id is kept out of every match and reported instead.
    let mut active: Vec<&Follow> = vec![];
    let mut ambiguous_follows = vec![];
    for follow in follows.iter().filter(|f| f.team_key.is_some()) {
        if follow.source_team_id.is_some() {
            active.push(follow);
        } else {
            ambiguous_follows.push(ambiguous(follow, per.get(&follow.competition_key).map(|p| p.teams.as_slice()).unwrap_or(&[])));
        }
    }

    let mut bundles: HashMap<String, Bundle> = HashMap::new();
    for follow in &active {
        let id = follow.source_team_id.clone().unwrap_or_default();
        let comp = per.get(&follow.competition_key);
        let schedule = datasets::schedule(host, &follow.competition_key, &id)?;
        degraded |= schedule.degraded;
        bundles.insert(
            follow.id.clone(),
            Bundle {
                follow: (*follow).clone(),
                team: comp.and_then(|c| c.teams.iter().find(|t| t.source_team_id.as_deref() == Some(id.as_str())).cloned()),
                match_id: id,
                scoreboard: comp.map(|c| c.scoreboard.clone()).unwrap_or_default(),
                standings: sections_of(&follow.competition_key),
                schedule: schedule.data.as_array().cloned().unwrap_or_default(),
            },
        );
    }
    let active_owned: Vec<Follow> = active.iter().map(|f| (*f).clone()).collect();
    let cards: Vec<Value> = followed::group_follows(&active_owned).iter().map(|g| followed::build_card(g, &bundles, now_ms, &now_iso)).collect();

    let scoreboard: Vec<Value> = keys
        .iter()
        .filter_map(|k| {
            let games = &per[k].scoreboard;
            (!games.is_empty()).then(|| json!({"competitionKey": k, "competitionLabel": label_of(k), "games": games}))
        })
        .collect();
    let standings: Vec<Value> = keys
        .iter()
        .filter_map(|k| {
            let sections = sections_of(k);
            let has_rows = sections.iter().any(|s| s["rows"].as_array().is_some_and(|r| !r.is_empty()));
            has_rows.then(|| json!({
                "competitionKey": k, "competitionLabel": label_of(k),
                "standingsShape": catalog::entry(k).map(|e| e.standings_shape).unwrap_or("table"), "sections": sections,
            }))
        })
        .collect();
    let active_keys: Vec<&String> = keys.iter().filter(|k| season_is_active(&per[*k].standings["season"], now_ms)).collect();

    let followed_teams: Vec<Value> = active
        .iter()
        .filter_map(|f| {
            let b = bundles.get(&f.id)?;
            let team = b.team.as_ref()?;
            Some(json!({"competitionKey": f.competition_key, "teamKey": team.team_key, "sourceTeamId": b.match_id}))
        })
        .collect();
    let league_refs: Vec<Value> = followed_leagues.iter().map(|f| json!({"competitionKey": f.competition_key, "competitionLabel": label_of(&f.competition_key)})).collect();
    let league_cards: Vec<Value> = followed_leagues
        .iter()
        .filter_map(|f| {
            let entry = catalog::entry(&f.competition_key);
            let games = &per.get(&f.competition_key)?.scoreboard;
            let results = followed::league_results(games);
            (!results.is_empty()).then(|| json!({
                "competitionKey": f.competition_key, "competitionLabel": label_of(&f.competition_key),
                "kind": entry.map(|e| e.kind).unwrap_or("league"),
                "status": if games.iter().any(|g| g["state"] == "live") { "live" } else { "news" },
                "logoUrl": entry.and_then(|e| e.logo_url), "stories": [], "results": results,
            }))
        })
        .collect();

    Ok(Response::new(
        200,
        json!({
            "hero": {"mode": "story", "headline": null},
            "followed": cards, "scoreboard": scoreboard, "topStories": [], "leagueNews": [],
            "standings": standings, "followedTeams": followed_teams, "followedLeagues": league_refs,
            "followedLeagueCards": league_cards, "ambiguousFollows": ambiguous_follows,
            "activeCompetitionKeys": active_keys, "degraded": degraded,
        }),
    ))
}

/// A tournament whose group stage is finished: every group has rows and every club has played all its group games.
fn group_stage_complete(sections: &[Value]) -> bool {
    !sections.is_empty()
        && sections.iter().all(|s| {
            let rows = s["rows"].as_array().cloned().unwrap_or_default();
            !rows.is_empty()
                && rows.iter().all(|r| {
                    let n = |k: &str| r[k].as_f64().unwrap_or(0.0);
                    n("wins") + n("losses") + n("draws") >= rows.len() as f64 - 1.0
                })
        })
}

/// `GET /standings?competitionKey=`.
pub fn standings<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    use crate::util::bad_request;
    let key = match request.query.get("competitionKey") {
        None => return Ok(bad_request("querystring must have required property 'competitionKey'")),
        Some(Value::String(k)) => k,
        Some(_) => return Ok(bad_request("querystring/competitionKey must be string")),
    };
    match key.chars().count() {
        0 => return Ok(bad_request("querystring/competitionKey must NOT have fewer than 1 characters")),
        101.. => return Ok(bad_request("querystring/competitionKey must NOT have more than 100 characters")),
        _ => {}
    }
    let Some(entry) = catalog::entry(key) else { return Ok(bad_request(format!("Unknown competition: {key}"))) };
    let group = |sections: Value| json!({
        "competitionKey": key, "competitionLabel": entry.label, "standingsShape": entry.standings_shape, "sections": sections,
    });
    if entry.news_feed_url.is_some() {
        return Ok(Response::new(200, json!({"group": group(json!([])), "fixtures": [], "degraded": false})));
    }
    let table = datasets::standings(host, key)?;
    let mut degraded = table.degraded;
    let sections = table.data["sections"].as_array().cloned().unwrap_or_default();
    let mut fixtures: Vec<Value> = vec![];
    if entry.kind == "tournament" && group_stage_complete(&sections) {
        let today = eastern::day_of(cache::now_ms(host)?);
        fixtures = scoreboard_for_days(host, key, &eastern::add_days(&today, FIXTURE_DAYS_BEFORE), &eastern::add_days(&today, FIXTURE_DAYS_AFTER), &mut degraded)?;
        fixtures.sort_by(|a, b| a["startsAt"].as_str().unwrap_or("").cmp(b["startsAt"].as_str().unwrap_or("")));
    }
    Ok(Response::new(200, json!({"group": group(Value::Array(sections)), "fixtures": fixtures, "degraded": degraded})))
}
