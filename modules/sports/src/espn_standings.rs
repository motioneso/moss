//! Standings parsing. Deeper levels of the payload group teams into conferences and divisions;
//! every node that holds entries becomes one section tagged with its conference.
use crate::espn::{at, id_text, number, text};
use serde_json::{json, Value};

fn stat(stats: &Value, name: &str) -> Option<f64> {
    stats.as_array()?.iter().find(|s| s["name"] == name)?["value"].as_f64()
}

/// Rewrites ESPN's malformed colors such as "##B5E7CE" to one "#", or null when unusable.
fn note_color(color: Option<&str>) -> Option<String> {
    let raw = color.filter(|c| !c.is_empty())?;
    let hex = format!("#{}", raw.trim_start_matches('#'));
    let digits = &hex[1..];
    let ok = matches!(digits.len(), 3 | 4 | 6 | 8) && digits.bytes().all(|b| b.is_ascii_hexdigit());
    ok.then_some(hex)
}

/// College football carries only an "overall" record string such as "10-2" or "10-2-1".
fn overall(stats: &Value) -> Option<(f64, f64, Option<f64>)> {
    let record = stats.as_array()?.iter().find(|s| s["name"] == "overall")?["displayValue"].as_str()?;
    let parts: Vec<&str> = record.trim().split('-').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let n = |i: usize| parts.get(i).and_then(|p| p.parse::<f64>().ok());
    Some((n(0)?, n(1)?, n(2)))
}

fn row(entry: &Value, index: usize) -> Value {
    let team = &entry["team"];
    let id = id_text(&team["id"]);
    let key = text(team, &["abbreviation"]).or_else(|| id.clone()).unwrap_or_default().to_lowercase();
    let stats = &entry["stats"];
    let record = overall(stats);
    let wins = stat(stats, "wins").or(record.map(|r| r.0)).unwrap_or(0.0);
    let losses = stat(stats, "losses").or(record.map(|r| r.1)).unwrap_or(0.0);
    let draws = stat(stats, "ties").or(record.and_then(|r| r.2));
    let played = wins + losses + draws.unwrap_or(0.0);
    let win_percent = stat(stats, "winPercent").or_else(|| {
        (record.is_some() && played > 0.0).then(|| (wins + draws.unwrap_or(0.0) / 2.0) / played)
    });
    let opt = |v: Option<f64>| v.map(number).unwrap_or(Value::Null);
    json!({
        "teamKey": key,
        "sourceTeamId": id,
        "name": text(team, &["displayName"]).unwrap_or_else(|| key.clone()),
        "rank": number(stat(stats, "rank").unwrap_or(index as f64 + 1.0)),
        "points": opt(stat(stats, "points")),
        "wins": number(wins),
        "losses": number(losses),
        "draws": opt(draws),
        "winPercent": opt(win_percent),
        "qualifies": !entry["note"].is_null(),
        "qualificationNote": text(&entry["note"], &["description"]),
        "qualificationColor": note_color(at(&entry["note"], &["color"]).as_str()),
    })
}

fn collect(node: &Value, conference: Option<&str>, depth: usize, out: &mut Vec<Value>) {
    let label = text(node, &["name"]).or_else(|| text(node, &["abbreviation"]));
    let entries = at(node, &["standings", "entries"]).as_array().cloned().unwrap_or_default();
    if !entries.is_empty() {
        let rows: Vec<Value> = entries.iter().enumerate().map(|(i, e)| row(e, i)).collect();
        out.push(json!({"label": label, "conference": conference, "rows": rows}));
    }
    let child_conference = if depth > 0 && entries.is_empty() {
        label.clone().or_else(|| conference.map(str::to_owned))
    } else {
        conference.map(str::to_owned)
    };
    for child in node["children"].as_array().into_iter().flatten() {
        collect(child, child_conference.as_deref(), depth + 1, out);
    }
}

/// The end of the newest season, taken from its last stage because the season's own end date is padded.
fn season_window(data: &Value) -> Value {
    let newest = data["seasons"].get(0).filter(|s| !s.is_null()).unwrap_or(&data["season"]);
    if newest.is_null() {
        return Value::Null;
    }
    let last_stage = newest["types"].as_array().and_then(|t| t.last()).and_then(|t| t["endDate"].as_str());
    let start = newest["startDate"].as_str().filter(|s| !s.is_empty());
    let end = last_stage.or(newest["endDate"].as_str()).filter(|s| !s.is_empty());
    match (start, end) {
        (Some(start), Some(end)) => json!({"start": start, "end": end}),
        _ => Value::Null,
    }
}

pub fn parse_standings(data: &Value) -> Value {
    let mut sections = vec![];
    collect(data, None, 0, &mut sections);
    sections.retain(|s| s["rows"].as_array().is_some_and(|r| !r.is_empty()));
    json!({"sections": sections, "season": season_window(data)})
}
