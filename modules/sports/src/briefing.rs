//! Today's facts for followed teams and competitions, for the daily briefing and the heartbeat.
//! The composer is pure. `today` reads the person's follows and the cached Eastern-day
//! scoreboards the overview reads, so a fact and an overview card cannot disagree on a fixture.
use crate::followed::{self, Follow};
use crate::{catalog, eastern, overview, public_cache as cache};
use chrono::TimeZone;
use chrono_tz::Tz;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const GAMES_MAX: usize = 8;

/// The briefing's time zone, or UTC when the name is not a known zone.
pub fn zone_of(name: &str) -> Tz {
    name.trim().parse().unwrap_or(chrono_tz::UTC)
}

fn local_day(ms: i64, zone: Tz) -> Option<chrono::NaiveDate> {
    zone.timestamp_millis_opt(ms).single().map(|t| t.date_naive())
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

/// One game's phase for the person's local day.
pub fn phase(game: &Value, now_ms: i64, zone: Tz) -> &'static str {
    let detail = text(game, "statusDetail").to_lowercase();
    if ["postpon", "ppd", "cancel"].iter().any(|word| detail.contains(word)) {
        return "postponed";
    }
    match text(game, "state") {
        "live" => return "live",
        "final" => return "final",
        _ => {}
    }
    let Some(start) = followed::instant_ms(text(game, "startsAt")) else { return "upcoming" };
    if start > now_ms && local_day(start, zone) == local_day(now_ms, zone) {
        "tonight"
    } else {
        "upcoming"
    }
}

/// Section state. Live wins, then tonight, then finals. Quiet needs a complete empty answer.
pub fn state(phases: &[&str], degraded: bool) -> &'static str {
    let has = |p: &str| phases.contains(&p);
    if has("live") {
        "live"
    } else if has("tonight") {
        "tonight"
    } else if has("final") {
        "finals"
    } else if degraded {
        "unknown"
    } else {
        "quiet"
    }
}

/// A live game wins, then the earliest game still to play today, then the nearest game.
fn team_game<'a>(board: &'a [Value], id: &str, now_ms: i64, zone: Tz) -> Option<&'a Value> {
    let mine: Vec<&Value> = board.iter().filter(|g| followed::side_for(g, id).is_some()).collect();
    if let Some(live) = mine.iter().find(|g| text(g, "state") == "live") {
        return Some(live);
    }
    let start = |g: &Value| followed::instant_ms(text(g, "startsAt")).unwrap_or(i64::MAX);
    let tonight = mine.iter().filter(|g| phase(g, now_ms, zone) == "tonight").min_by_key(|g| start(g));
    tonight.copied().or_else(|| followed::current_team_game(board, id, now_ms))
}

fn team_fact(game: &Value, id: &str) -> String {
    let (Some(side), Some(other)) = (followed::side_for(game, id), followed::opponent_for(game, id)) else {
        return "Your team plays today.".into();
    };
    let name = text(side, "name");
    match text(game, "state") {
        "final" => {
            let verb = match followed::result_of(side, other) {
                "W" => "won",
                "L" => "lost",
                _ => "tied",
            };
            format!(
                "{name} {verb} {}\u{2013}{} vs {}.",
                followed::score_text(&side["score"]),
                followed::score_text(&other["score"]),
                text(other, "shortName")
            )
        }
        "live" => format!("{name} play now: {}.", followed::score_line(game)),
        _ => format!("{name} play today at {}.", text(game, "statusDetail")),
    }
}

fn cut(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn number(score: &Value) -> Value {
    score.as_f64().map_or(Value::Null, |n| json!(n))
}

fn game_evidence(game: &Value, phase: &str) -> Value {
    let headline = if text(game, "state") == "final" { followed::score_line(game) } else { followed::matchup_line(game) };
    json!({
        "id": cut(text(game, "id"), 200), "competitionKey": cut(text(game, "competitionKey"), 100),
        "startsAt": text(game, "startsAt"), "phase": phase, "statusDetail": cut(text(game, "statusDetail"), 200),
        "headline": cut(&headline, 300), "homeShort": cut(text(&game["home"], "shortName"), 60),
        "awayShort": cut(text(&game["away"], "shortName"), 60),
        "homeScore": number(&game["home"]["score"]), "awayScore": number(&game["away"]["score"]),
    })
}

fn label_of(key: &str) -> String {
    catalog::entry(key).map_or_else(|| key.to_owned(), |e| e.label.to_owned())
}

fn games_line(count: usize, key: &str, tail: &str) -> String {
    format!("{count} {} game{} {tail}", label_of(key), if count == 1 { "" } else { "s" })
}

pub struct Input<'a> {
    pub follows: &'a [Follow],
    pub boards: &'a BTreeMap<String, Vec<Value>>,
    pub now_ms: i64,
    pub zone: Tz,
    pub degraded: bool,
    pub captured_at: &'a str,
}

/// The facts and the evidence block, in the shape the old briefing tool returned.
pub fn compose(input: &Input) -> Value {
    let mut facts: Vec<Value> = vec![];
    let mut games: Vec<(String, Value)> = vec![];
    let mut ambiguous = 0;
    let push = |games: &mut Vec<(String, Value)>, game: &Value| {
        let phase = phase(game, input.now_ms, input.zone);
        let id = text(game, "id").to_owned();
        if games.len() < GAMES_MAX && !games.iter().any(|(seen, _)| *seen == id) {
            games.push((id, game_evidence(game, phase)));
        }
    };
    let no_games = Vec::new();
    if input.follows.is_empty() {
        for (key, board) in input.boards {
            let mut soonest: Vec<&Value> = board.iter().collect();
            soonest.sort_by_key(|g| text(g, "startsAt").to_owned());
            soonest.into_iter().take(3).for_each(|g| push(&mut games, g));
            if !board.is_empty() && facts.len() < 8 {
                facts.push(json!({"competitionKey": key, "text": games_line(board.len(), key, "on the slate.")}));
            }
            if games.len() >= GAMES_MAX {
                break;
            }
        }
    } else {
        for follow in input.follows {
            let board = input.boards.get(&follow.competition_key).unwrap_or(&no_games);
            let Some(_) = &follow.team_key else {
                board.iter().take(3).for_each(|g| push(&mut games, g));
                if !board.is_empty() {
                    facts.push(json!({"competitionKey": follow.competition_key, "text": games_line(board.len(), &follow.competition_key, "play today.")}));
                }
                continue;
            };
            let Some(id) = follow.source_team_id.as_deref() else {
                ambiguous += 1;
                continue;
            };
            if let Some(game) = team_game(board, id, input.now_ms, input.zone) {
                push(&mut games, game);
                facts.push(json!({"competitionKey": follow.competition_key, "text": team_fact(game, id)}));
            }
        }
    }
    let mut ordered: Vec<Value> = games.into_iter().map(|(_, g)| g).collect();
    ordered.sort_by_key(|g| text(g, "startsAt").to_owned());
    let phases: Vec<&str> = ordered.iter().map(|g| text(g, "phase")).collect();
    let section = state(&phases, input.degraded);
    json!({
        "facts": facts,
        "evidence": {
            "version": 1, "capturedAt": input.captured_at, "degraded": input.degraded, "state": section,
            "ambiguousFollowCount": ambiguous, "games": ordered, "stories": [],
        },
    })
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn unavailable(captured_at: &str) -> Value {
    json!({"facts": [], "evidence": {
        "version": 1, "capturedAt": captured_at, "degraded": true, "state": "unknown",
        "ambiguousFollowCount": 0, "games": [], "stories": [],
    }})
}

/// The competitions to read. Follows name their own, and a person with none sees the default slate.
pub fn competitions(follows: &[Follow]) -> Vec<String> {
    let mut keys: Vec<String> = vec![];
    if follows.is_empty() {
        keys.extend(overview::DEFAULT_SLATE.iter().map(|k| (*k).to_owned()));
    }
    for follow in follows {
        if !keys.contains(&follow.competition_key) {
            keys.push(follow.competition_key.clone());
        }
    }
    keys
}

/// `sports.followedFactsToday`. It never fails. A read that cannot finish returns a degraded,
/// empty answer, so one broken source cannot stop a briefing.
pub fn today<H: Host + ?Sized>(host: &H, zone_name: &str) -> Value {
    let Ok(now_ms) = cache::now_ms(host) else { return unavailable("") };
    let captured_at = iso(now_ms);
    let run = || -> Result<Value> {
        let follows: Vec<Follow> =
            overview::load_follows(host)?.into_iter().filter(|f| catalog::entry(&f.competition_key).is_some()).collect();
        let day = eastern::day_of(now_ms);
        let before = eastern::add_days(&day, -1);
        let mut degraded = false;
        let mut boards = BTreeMap::new();
        for key in competitions(&follows) {
            // A news-only competition has no scoreboard, so asking ESPN would only fail.
            let board = if catalog::entry(&key).is_some_and(|e| e.news_feed_url.is_some()) {
                vec![]
            } else {
                overview::scoreboard_for_days(host, &key, &before, &day, &mut degraded)?
            };
            boards.insert(key, board);
        }
        Ok(compose(&Input { follows: &follows, boards: &boards, now_ms, zone: zone_of(zone_name), degraded, captured_at: &captured_at }))
    };
    run().unwrap_or_else(|_| unavailable(&captured_at))
}
