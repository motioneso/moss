//! The gameday hero: which followed games lead the page and in what order.
use crate::followed::{current_team_game, instant_ms, side_for, Bundle};
use crate::catalog;
use serde_json::{json, Value};
use std::collections::HashSet;

/// A game leads the page from fifteen minutes before it starts until it ends.
const LEAD_MS: i64 = 15 * 60 * 1000;

pub fn in_window(game: &Value, now_ms: i64) -> bool {
    match game["state"].as_str() {
        Some("live") => true,
        Some("pre") => game["startsAt"].as_str().and_then(instant_ms).is_some_and(|t| t - now_ms <= LEAD_MS),
        _ => false,
    }
}

/// One slide per followed game in the window, live games first, then the rest in follow order.
/// A game both clubs of which are followed is one slide.
pub fn games(bundles: &[&Bundle], now_ms: i64) -> Vec<Value> {
    let mut slides: Vec<Value> = vec![];
    let mut seen: HashSet<String> = HashSet::new();
    for bundle in bundles {
        let Some(game) = current_team_game(&bundle.scoreboard, &bundle.match_id, now_ms) else { continue };
        let Some(side) = side_for(game, &bundle.match_id) else { continue };
        if !in_window(game, now_ms) {
            continue;
        }
        if !seen.insert(game["id"].as_str().unwrap_or_default().to_owned()) {
            continue;
        }
        let key = &bundle.follow.competition_key;
        let label = catalog::entry(key).map(|e| e.label.to_owned()).unwrap_or_else(|| key.clone());
        slides.push(json!({
            "game": game, "competitionLabel": label,
            "rationale": format!("You follow {}.", side["name"].as_str().unwrap_or_default()),
        }));
    }
    let (live, rest): (Vec<Value>, Vec<Value>) = slides.into_iter().partition(|s| s["game"]["state"] == "live");
    live.into_iter().chain(rest).collect()
}
