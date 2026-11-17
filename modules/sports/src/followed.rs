//! Followed teams as cards. Follows of the same club in several competitions merge into one
//! group, and each group becomes one card built from every member competition's data.
//!
//! Every game, schedule and standings row is claimed by the club's permanent provider id and by
//! nothing else, so a shared short name can never attach a score to the wrong team.
use crate::catalog;
use crate::espn::TeamRef;
use crate::identity::side_matches;
use chrono::{DateTime, NaiveDateTime};
use serde_json::{json, Value};
use std::collections::HashMap;

/// A game counts as "now" when it starts within this long of the current time.
const NEAR_GAME_WINDOW_MS: i64 = 12 * 60 * 60 * 1000;
const FORM_LENGTH: usize = 5;
const LEAGUE_RESULT_LIMIT: usize = 3;

#[derive(Clone, Debug)]
pub struct Follow {
    pub id: String,
    pub competition_key: String,
    pub team_key: Option<String>,
    pub source_team_id: Option<String>,
    pub created_at: String,
}

/// Everything fetched for one followed club in one competition.
pub struct Bundle {
    pub follow: Follow,
    /// The club's permanent id. Every match below uses this and nothing else.
    pub match_id: String,
    /// The club as today's team list names it, when the list holds its id.
    pub team: Option<TeamRef>,
    pub scoreboard: Vec<Value>,
    pub standings: Vec<Value>,
    pub schedule: Vec<Value>,
}

pub struct Group {
    pub follows: Vec<Follow>,
    pub primary: Follow,
}

fn kind_of(key: &str) -> &'static str {
    catalog::entry(key).map(|e| e.kind).unwrap_or("")
}

/// A league beats a tournament outright. Among the rest the newest follow wins, and the
/// ascending id breaks a tie so every ordering agrees on one winner.
pub fn select_primary(follows: &[Follow]) -> Follow {
    let leagues: Vec<&Follow> = follows.iter().filter(|f| kind_of(&f.competition_key) == "league").collect();
    let mut pool: Vec<&Follow> = if leagues.is_empty() { follows.iter().collect() } else { leagues };
    pool.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.id.cmp(&b.id)));
    pool[0].clone()
}

/// Groups follows by `espnSport:sourceTeamId`. An unresolved follow stays alone, keyed by its own id.
pub fn group_follows(follows: &[Follow]) -> Vec<Group> {
    let mut order: Vec<String> = vec![];
    let mut buckets: HashMap<String, Vec<Follow>> = HashMap::new();
    for follow in follows {
        let sport = catalog::entry(&follow.competition_key).map(|e| e.espn_sport);
        let key = match (sport, follow.source_team_id.as_deref()) {
            (Some(sport), Some(id)) => format!("{sport}:{id}"),
            _ => format!("unresolved:{}", follow.id),
        };
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(follow.clone());
    }
    order
        .into_iter()
        .map(|k| {
            let follows = buckets.remove(&k).unwrap_or_default();
            Group { primary: select_primary(&follows), follows }
        })
        .collect()
}

// --- Small readers over game JSON -----------------------------------------------------------

/// An ESPN time such as "2026-11-12T00:30Z" has no seconds, which strict RFC 3339 rejects.
pub fn instant_ms(text: &str) -> Option<i64> {
    if let Ok(d) = DateTime::parse_from_rfc3339(text) {
        return Some(d.timestamp_millis());
    }
    NaiveDateTime::parse_from_str(text.trim_end_matches('Z'), "%Y-%m-%dT%H:%M").ok().map(|d| d.and_utc().timestamp_millis())
}

fn starts(game: &Value) -> &str {
    game["startsAt"].as_str().unwrap_or("")
}

fn state(game: &Value) -> &str {
    game["state"].as_str().unwrap_or("")
}

fn claimed(side: &Value, id: &str) -> bool {
    side_matches(side["sourceTeamId"].as_str(), id)
}

pub fn side_for<'a>(game: &'a Value, id: &str) -> Option<&'a Value> {
    if claimed(&game["home"], id) {
        Some(&game["home"])
    } else if claimed(&game["away"], id) {
        Some(&game["away"])
    } else {
        None
    }
}

fn opponent_for<'a>(game: &'a Value, id: &str) -> Option<&'a Value> {
    if claimed(&game["home"], id) {
        Some(&game["away"])
    } else if claimed(&game["away"], id) {
        Some(&game["home"])
    } else {
        None
    }
}

fn is_home(game: &Value, id: &str) -> bool {
    claimed(&game["home"], id)
}

fn score_text(score: &Value) -> String {
    match score.as_f64() {
        Some(n) if n.fract() == 0.0 => (n as i64).to_string(),
        Some(n) => n.to_string(),
        None => "0".into(),
    }
}

fn name_of(side: &Value, key: &str) -> String {
    side[key].as_str().unwrap_or_default().to_owned()
}

/// A live game wins. Otherwise the game starting nearest to now wins, if it is within twelve hours.
pub fn current_team_game<'a>(games: &'a [Value], id: &str, now_ms: i64) -> Option<&'a Value> {
    let mine: Vec<&Value> = games.iter().filter(|g| side_for(g, id).is_some()).collect();
    if let Some(live) = mine.iter().find(|g| state(g) == "live") {
        return Some(live);
    }
    let distance = |g: &Value| instant_ms(starts(g)).map(|t| (t - now_ms).abs()).unwrap_or(i64::MAX);
    let nearest = mine.iter().min_by_key(|g| distance(g))?;
    (distance(nearest) <= NEAR_GAME_WINDOW_MS).then_some(*nearest)
}

/// The group's game for today. A live game anywhere wins, otherwise the first club in primary-first order keeps its own.
fn current_game_across<'a>(bundles: &[&'a Bundle], now_ms: i64) -> Option<(&'a Value, &'a str)> {
    let mut result: Option<(&Value, &str)> = None;
    for bundle in bundles {
        let Some(game) = current_team_game(&bundle.scoreboard, &bundle.match_id, now_ms) else { continue };
        let better = match result {
            None => true,
            Some((held, _)) => state(game) == "live" && state(held) != "live",
        };
        if better {
            result = Some((game, bundle.match_id.as_str()));
        }
    }
    result
}

pub fn score_line(game: &Value) -> String {
    format!(
        "{} {} \u{2013} {} {}",
        name_of(&game["away"], "shortName"),
        score_text(&game["away"]["score"]),
        score_text(&game["home"]["score"]),
        name_of(&game["home"], "shortName")
    )
}

pub fn matchup_line(game: &Value) -> String {
    format!(
        "{} @ {} \u{b7} {}",
        name_of(&game["away"], "shortName"),
        name_of(&game["home"], "shortName"),
        game["statusDetail"].as_str().unwrap_or_default()
    )
}

fn result_of(side: &Value, opponent: &Value) -> &'static str {
    match (side["score"].as_f64(), opponent["score"].as_f64()) {
        (Some(a), Some(b)) if a == b => "D",
        _ if side["winner"] == true => "W",
        _ => "L",
    }
}

fn result_line(game: &Value, id: &str) -> String {
    let (Some(side), Some(opponent)) = (side_for(game, id), opponent_for(game, id)) else { return matchup_line(game) };
    format!(
        "{} {}\u{2013}{} {} {}",
        result_of(side, opponent),
        score_text(&side["score"]),
        score_text(&opponent["score"]),
        if is_home(game, id) { "vs" } else { "at" },
        name_of(opponent, "shortName")
    )
}

/// Recent games of a whole competition. Live first, then newest, at most three, finals and live only.
pub fn league_results(games: &[Value]) -> Vec<Value> {
    let mut kept: Vec<&Value> = games.iter().filter(|g| matches!(state(g), "live" | "final")).collect();
    kept.sort_by(|a, b| {
        if state(a) != state(b) {
            return if state(a) == "live" { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        starts(b).cmp(starts(a))
    });
    kept.into_iter()
        .take(LEAGUE_RESULT_LIMIT)
        .map(|g| json!({"line": score_line(g), "startsAt": starts(g), "state": state(g), "detail": g["statusDetail"].as_str().unwrap_or_default()}))
        .collect()
}

/// The club's finished games, oldest first, last five, as the card's form pips.
fn form_detail(games: &[(&Value, &str)]) -> Vec<Value> {
    let mut finals: Vec<&(&Value, &str)> = games.iter().filter(|(g, id)| state(g) == "final" && side_for(g, id).is_some()).collect();
    finals.sort_by(|a, b| starts(a.0).cmp(starts(b.0)));
    let skip = finals.len().saturating_sub(FORM_LENGTH);
    finals
        .into_iter()
        .skip(skip)
        .map(|(game, id)| {
            let side = side_for(game, id);
            let opponent = opponent_for(game, id);
            let result = match (side, opponent) {
                (Some(s), Some(o)) => result_of(s, o),
                _ => "L",
            };
            json!({
                "result": result,
                "opponentName": opponent.map(|o| name_of(o, "name")).unwrap_or_else(|| "Opponent".into()),
                "homeAway": if is_home(game, id) { "home" } else { "away" },
                "score": format!("{}\u{2013}{}", side.map(|s| score_text(&s["score"])).unwrap_or_else(|| "0".into()), opponent.map(|o| score_text(&o["score"])).unwrap_or_else(|| "0".into())),
                "playedAt": starts(game),
            })
        })
        .collect()
}

fn ordinal(n: i64) -> String {
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

fn short_section_label(label: &str) -> String {
    let label = label.strip_prefix("American League ").map(|r| format!("AL {r}")).unwrap_or_else(|| label.to_owned());
    let label = label.strip_prefix("National League ").map(|r| format!("NL {r}")).unwrap_or(label);
    label.strip_suffix(" Division").map(str::to_owned).unwrap_or(label)
}

/// "2nd · NFC East" for sectioned tables, "#4 · 40 pts" or "#4 · 8-3" for flat ones. A club that
/// has played nothing has no line.
pub fn standing_line(sections: &[Value], id: &str) -> Option<String> {
    for section in sections {
        let rows = section["rows"].as_array().cloned().unwrap_or_default();
        let Some(index) = rows.iter().position(|r| claimed(r, id)) else { continue };
        let row = &rows[index];
        let n = |k: &str| row[k].as_f64().unwrap_or(0.0);
        if n("wins") + n("losses") + n("draws") == 0.0 {
            return None;
        }
        let place = if n("rank") > 0.0 { n("rank") as i64 } else { index as i64 + 1 };
        if let Some(label) = section["label"].as_str().filter(|l| !l.is_empty()) {
            return Some(format!("{} \u{b7} {}", ordinal(place), short_section_label(label)));
        }
        if let Some(points) = row["points"].as_f64() {
            return Some(format!("#{place} \u{b7} {} pts", score_text(&json!(points))));
        }
        return Some(format!("#{place} \u{b7} {}-{}", score_text(&row["wins"]), score_text(&row["losses"])));
    }
    None
}

fn next_match(games: &[(&Value, &str)], now_iso: &str) -> Value {
    let mut upcoming: Vec<&(&Value, &str)> =
        games.iter().filter(|(g, id)| state(g) != "final" && starts(g) > now_iso && side_for(g, id).is_some()).collect();
    upcoming.sort_by(|a, b| starts(a.0).cmp(starts(b.0)));
    let Some((game, id)) = upcoming.first() else { return Value::Null };
    let Some(opponent) = opponent_for(game, id) else { return Value::Null };
    json!({
        "opponentName": name_of(opponent, "name"),
        "homeAway": if is_home(game, id) { "home" } else { "away" },
        "startsAt": starts(game),
        "opponentCrestUrl": opponent["crestUrl"],
    })
}

fn result_match(game: &Value, id: &str) -> Value {
    let (Some(side), Some(opponent)) = (side_for(game, id), opponent_for(game, id)) else { return Value::Null };
    let home = game["home"]["teamKey"] == side["teamKey"];
    let (own, theirs) = (score_text(&side["score"]).parse::<i64>().unwrap_or(0), score_text(&opponent["score"]).parse::<i64>().unwrap_or(0));
    json!({
        "opponentName": name_of(opponent, "name"),
        "opponentCrestUrl": opponent["crestUrl"],
        "resultLabel": result_of(side, opponent),
        "homeScore": if home { own } else { theirs },
        "awayScore": if home { theirs } else { own },
        "homeAway": if home { "home" } else { "away" },
        "ownScorers": side["scorers"],
        "opponentScorers": opponent["scorers"],
    })
}

fn join_labels(labels: &[String]) -> String {
    match labels.len() {
        1 => labels[0].clone(),
        2 => format!("{} and {}", labels[0], labels[1]),
        n => format!("{}, and {}", labels[..n - 1].join(", "), labels[n - 1]),
    }
}

fn first_text(bundles: &[&Bundle], pick: impl Fn(&Bundle) -> Option<String>) -> Option<String> {
    bundles.iter().find_map(|b| pick(b))
}

fn schedule_side<'a>(bundle: &'a Bundle) -> Option<&'a Value> {
    bundle.schedule.iter().find_map(|g| side_for(g, &bundle.match_id))
}

/// The card for one group. The primary competition's data wins every tie.
pub fn build_card(group: &Group, bundles: &HashMap<String, Bundle>, now_ms: i64, now_iso: &str) -> Value {
    let mut ordered: Vec<&Follow> = vec![&group.primary];
    ordered.extend(group.follows.iter().filter(|f| f.id != group.primary.id));
    let ordered: Vec<&Bundle> = ordered.iter().filter_map(|f| bundles.get(&f.id)).collect();
    let primary = ordered[0];
    let comp = group.primary.competition_key.as_str();
    let label_of = |key: &str| catalog::entry(key).map(|e| e.label.to_owned()).unwrap_or_else(|| key.to_owned());

    let today = current_game_across(&ordered, now_ms);
    let today_side = today.and_then(|(g, id)| side_for(g, id));
    let name = today_side
        .and_then(|s| s["name"].as_str().map(str::to_owned))
        .or_else(|| first_text(&ordered, |b| b.team.as_ref().map(|t| t.name.clone())))
        .or_else(|| first_text(&ordered, |b| schedule_side(b).and_then(|s| s["name"].as_str().map(str::to_owned))))
        .unwrap_or_else(|| group.primary.team_key.clone().unwrap_or_default().to_uppercase());
    let crest = today_side
        .and_then(|s| s["crestUrl"].as_str().map(str::to_owned))
        .or_else(|| first_text(&ordered, |b| b.team.as_ref().and_then(|t| t.crest_url.clone())))
        .or_else(|| first_text(&ordered, |b| schedule_side(b).and_then(|s| s["crestUrl"].as_str().map(str::to_owned))));

    let mut card = serde_json::Map::new();
    let (status, line) = match today {
        Some((g, _)) if state(g) == "live" => {
            let detail = g["statusDetail"].as_str().unwrap_or_default().trim();
            if !detail.is_empty() {
                card.insert("liveStatusText".into(), json!(detail));
            }
            ("live", score_line(g))
        }
        Some((g, id)) => {
            card.insert("todayGameState".into(), json!(if state(g) == "final" { "final" } else { "pre" }));
            ("today", if state(g) == "final" { result_line(g, id) } else { matchup_line(g) })
        }
        None => ("news", String::new()),
    };

    let games: Vec<(&Value, &str)> =
        ordered.iter().flat_map(|b| b.schedule.iter().map(move |g| (g, b.match_id.as_str()))).collect();
    let labels: Vec<String> = ordered.iter().map(|b| label_of(&b.follow.competition_key)).collect();
    let last_match = games
        .iter()
        .filter(|(g, id)| state(g) == "final" && side_for(g, id).is_some())
        .map(|(g, _)| starts(g))
        .fold(None::<&str>, |best, s| if best.is_none_or(|b| s > b) { Some(s) } else { best });
    let form = form_detail(&games);

    card.insert("teamKey".into(), json!(primary.team.as_ref().map(|t| t.team_key.clone()).or_else(|| group.primary.team_key.clone()).unwrap_or_default()));
    card.insert("competitionKey".into(), json!(comp));
    card.insert("competitionLabel".into(), json!(label_of(comp)));
    card.insert("name".into(), json!(name));
    card.insert("crestUrl".into(), json!(crest));
    card.insert("status".into(), json!(status));
    card.insert("primary".into(), json!(line));
    card.insert("stories".into(), json!([]));
    card.insert("form".into(), json!(form.iter().map(|f| f["result"].clone()).collect::<Vec<_>>()));
    card.insert("formDetail".into(), Value::Array(form));
    card.insert("standing".into(), standing_line(&primary.standings, &primary.match_id).map(Value::String).unwrap_or(Value::Null));
    card.insert("nextMatch".into(), next_match(&games, now_iso));
    card.insert(
        "resultMatch".into(),
        today.filter(|(g, _)| state(g) == "final").map(|(g, id)| result_match(g, id)).unwrap_or(Value::Null),
    );
    card.insert("lastMatchAt".into(), last_match.map(|s| json!(s)).unwrap_or(Value::Null));
    card.insert(
        "rationale".into(),
        json!(if ordered.len() == 1 { format!("You follow {name}.") } else { format!("You follow {name} in {}.", join_labels(&labels)) }),
    );
    Value::Object(card)
}
