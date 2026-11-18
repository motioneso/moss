//! Scoreboard parsing. Soccer scorers come from the play-by-play details and hockey scorers from
//! the goal leaders, because those are the lists ESPN fills for each sport.
use crate::catalog;
use crate::espn::{at, id_text, number, text};
use moss_module_sdk::{Error, Result};
use serde_json::{json, Value};

fn state(raw: Option<&str>) -> &'static str {
    match raw {
        Some("in") => "live",
        Some("post") => "final",
        _ => "pre",
    }
}

/// "11'" becomes "11" and added time "90'+1'" becomes "90+1". A label with no leading digit has no minute.
fn goal_minute(display: Option<&str>) -> Option<String> {
    let t = display.unwrap_or("").replace('\'', "");
    let t = t.trim();
    t.chars().next().is_some_and(|c| c.is_ascii_digit()).then(|| t.to_owned())
}

/// One line per scorer, such as "Isak 6, 8". A goal with no minute falls back to a count.
fn tally(goals: &[(String, Option<String>)]) -> Vec<String> {
    let mut order: Vec<&str> = vec![];
    for (name, _) in goals {
        if !order.contains(&name.as_str()) {
            order.push(name);
        }
    }
    order
        .into_iter()
        .map(|name| {
            let mine = goals.iter().filter(|(n, _)| n == name);
            let minutes: Vec<&str> = mine.clone().filter_map(|(_, m)| m.as_deref()).collect();
            if !minutes.is_empty() {
                return format!("{name} {}", minutes.join(", "));
            }
            let missing = mine.count();
            if missing > 1 { format!("{name} ({missing})") } else { name.to_owned() }
        })
        .collect()
}

/// ESPN's own scoring-play flag decides, because goal labels vary ("Goal - Header" and more).
fn is_soccer_goal(detail: &Value) -> bool {
    match detail["scoringPlay"].as_bool() {
        Some(flag) => flag,
        None => at(detail, &["type", "text"]).as_str().unwrap_or("").starts_with("Goal"),
    }
}

fn soccer_scorers(details: &Value, team_id: Option<&str>) -> Option<Vec<String>> {
    let goals: Vec<(String, Option<String>)> = details
        .as_array()?
        .iter()
        .filter(|d| is_soccer_goal(d) && id_text(&at(d, &["team", "id"]).clone()).as_deref() == team_id && team_id.is_some())
        .flat_map(|d| {
            let minute = goal_minute(at(d, &["clock", "displayValue"]).as_str());
            d["athletesInvolved"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |a| {
                    let name = text(a, &["shortName"]).or_else(|| text(a, &["displayName"]))?;
                    Some((name, minute.clone()))
                })
        })
        .collect();
    (!goals.is_empty()).then(|| tally(&goals))
}

fn hockey_scorers(leaders: &Value) -> Option<Vec<String>> {
    let one = [leaders.clone()];
    let categories: &[Value] = match leaders {
        Value::Array(list) => list,
        Value::Null => &[],
        _ => &one,
    };
    let goals = categories.iter().find(|c| c["name"] == "goals")?;
    let names: Vec<String> = goals["leaders"]
        .as_array()?
        .iter()
        .filter_map(|l| {
            let name = text(&l["athlete"], &["shortName"]).or_else(|| text(&l["athlete"], &["displayName"]))?;
            let count = match &l["displayValue"] {
                Value::String(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
                Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                _ => f64::NAN,
            };
            Some(if count > 1.0 { format!("{name} ({})", count as i64) } else { name })
        })
        .collect();
    (!names.is_empty()).then_some(names)
}

/// A score may arrive as a string, a number, or an object holding `value`.
fn score(raw: &Value) -> Value {
    let value = if raw.is_object() { &raw["value"] } else { raw };
    let n = match value {
        Value::Null if raw.is_object() => 0.0,
        Value::String(s) if s.is_empty() => return Value::Null,
        Value::String(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        _ => return Value::Null,
    };
    if n.is_nan() { Value::Null } else { number(n) }
}

fn side(competitor: &Value, scorers: Option<Vec<String>>) -> Value {
    let team = &competitor["team"];
    let id = id_text(&team["id"]);
    let key = text(team, &["abbreviation"]).or_else(|| id.clone()).unwrap_or_default().to_lowercase();
    let display = text(team, &["displayName"]);
    json!({
        "teamKey": key,
        "sourceTeamId": id,
        "name": display.clone().unwrap_or_else(|| key.clone()),
        "shortName": text(team, &["shortDisplayName"]).or(display).unwrap_or_else(|| key.clone()),
        "crestUrl": text(team, &["logo"]).or_else(|| text(&team["logos"][0], &["href"])),
        "score": score(&competitor["score"]),
        "record": text(&competitor["records"][0], &["summary"]),
        "winner": competitor["winner"] == true,
        "scorers": scorers,
    })
}

pub fn game(event: &Value, competition_key: &str) -> Result<Value> {
    let sport = catalog::entry(competition_key).ok_or_else(|| Error::new("Unknown competition"))?.espn_sport;
    let competition = &event["competitions"][0];
    let competitors = competition["competitors"].as_array().cloned().unwrap_or_default();
    let by = |side: &str, fallback: usize| {
        competitors
            .iter()
            .find(|c| c["homeAway"] == side)
            .or_else(|| competitors.get(fallback))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let (home, away) = (by("home", 0), by("away", 1));
    let scorers = |c: &Value| match sport {
        "soccer" => soccer_scorers(&competition["details"], id_text(&c["team"]["id"]).as_deref()),
        "hockey" => hockey_scorers(&c["leaders"]),
        _ => None,
    };
    let status = &competition["status"]["type"];
    Ok(json!({
        "id": id_text(&event["id"]).unwrap_or_default(),
        "competitionKey": competition_key,
        "startsAt": event["date"].as_str().unwrap_or(""),
        "state": state(status["state"].as_str()),
        "statusDetail": status["detail"].as_str().unwrap_or(""),
        "recap": text(&competition["headlines"][0], &["shortLinkText"])
            .or_else(|| text(&competition["notes"][0], &["headline"])),
        "home": side(&home, scorers(&home)),
        "away": side(&away, scorers(&away)),
    }))
}

pub fn parse_scoreboard(data: &Value, competition_key: &str) -> Result<Vec<Value>> {
    data["events"].as_array().into_iter().flatten().map(|e| game(e, competition_key)).collect()
}
