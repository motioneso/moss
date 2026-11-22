//! Scoreboard parsing. Soccer scorers come from the play-by-play details and hockey scorers from
//! the goal leaders, because those are the lists ESPN fills for each sport.
//!
//! A page is read into the lean `ScoreboardPage` shape instead of a loose tree, the same way the
//! team-page shape in `espn` reads team lists: a busy league day carries megabytes the compact
//! game never keeps (odds, rosters, broadcasts, articles), and skipping those without building
//! nodes keeps a full default-slate briefing inside the module's fuel budget. Every field the
//! game does keep is a plain leaf, so the old loose-tree semantics — a missing or oddly typed
//! slot reads as empty, never as an error — hold unchanged.
use crate::catalog;
use crate::espn::{id_text, number};
use moss_module_sdk::{Error, Result};
use serde::Deserialize;
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

// --- The lean scoreboard shape ---------------------------------------------------------------

/// The few fields of one ESPN scoreboard page the module reads. Recorded fixtures and live
/// answers deserialize through the same shape.
#[derive(serde::Deserialize, Default)]
pub struct ScoreboardPage {
    #[serde(default, deserialize_with = "list_or_empty")]
    events: Option<Vec<ScoreboardEvent>>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardEvent {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    date: Option<Value>,
    #[serde(default, deserialize_with = "list_or_empty")]
    competitions: Option<Vec<ScoreboardCompetition>>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardCompetition {
    #[serde(default, deserialize_with = "list_or_empty")]
    competitors: Option<Vec<ScoreboardCompetitor>>,
    /// Kept loose: the game reads only `["type"]["state"]` and `["type"]["detail"]`.
    #[serde(default)]
    status: Option<Value>,
    #[serde(default, deserialize_with = "list_or_empty")]
    headlines: Option<Vec<ScoreboardHeadline>>,
    #[serde(default, deserialize_with = "list_or_empty")]
    notes: Option<Vec<ScoreboardNote>>,
    #[serde(default, deserialize_with = "list_or_empty")]
    details: Option<Vec<ScoreboardDetail>>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardHeadline {
    #[serde(rename = "shortLinkText", default)]
    short_link_text: Option<Value>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardNote {
    #[serde(default)]
    headline: Option<Value>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardCompetitor {
    #[serde(rename = "homeAway", default)]
    home_away: Option<Value>,
    #[serde(default)]
    score: Option<Value>,
    #[serde(default)]
    winner: Option<Value>,
    #[serde(default, deserialize_with = "list_or_empty")]
    records: Option<Vec<ScoreboardRecord>>,
    #[serde(default)]
    team: Option<ScoreboardTeam>,
    #[serde(default, deserialize_with = "one_or_list")]
    leaders: Option<Vec<ScoreboardLeaderCategory>>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardRecord {
    #[serde(default)]
    summary: Option<Value>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardTeam {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    abbreviation: Option<Value>,
    #[serde(rename = "displayName", default)]
    display_name: Option<Value>,
    #[serde(rename = "shortDisplayName", default)]
    short_display_name: Option<Value>,
    #[serde(default)]
    logo: Option<Value>,
    #[serde(default, deserialize_with = "list_or_empty")]
    logos: Option<Vec<ScoreboardLogo>>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardLogo {
    #[serde(default)]
    href: Option<Value>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardDetail {
    #[serde(rename = "scoringPlay", default)]
    scoring_play: Option<Value>,
    /// The play's "type" object.
    #[serde(rename = "type", default)]
    kind: Option<Value>,
    #[serde(default)]
    clock: Option<Value>,
    #[serde(rename = "athletesInvolved", default, deserialize_with = "list_or_empty")]
    athletes_involved: Option<Vec<ScoreboardAthlete>>,
    /// The scoring side, kept loose: only `["id"]` is read.
    #[serde(default)]
    team: Option<Value>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardAthlete {
    #[serde(rename = "shortName", default)]
    short_name: Option<Value>,
    #[serde(rename = "displayName", default)]
    display_name: Option<Value>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardLeaderCategory {
    #[serde(default)]
    name: Option<Value>,
    #[serde(default, deserialize_with = "list_or_empty")]
    leaders: Option<Vec<ScoreboardLeader>>,
}
#[derive(serde::Deserialize, Default)]
struct ScoreboardLeader {
    #[serde(rename = "displayValue", default)]
    display_value: Option<Value>,
    #[serde(default)]
    athlete: Option<ScoreboardAthlete>,
}

/// The old loose tree read an odd slot as nothing, so a typed list keeps exactly that: a list
/// deserializes element by element, and a missing, null or non-list slot (or one whose elements
/// do not fit the shape) reads as empty instead of failing the whole page.
fn list_or_empty<'de, D, T>(deserializer: D) -> std::result::Result<Option<Vec<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Shape<T> {
        List(Vec<T>),
        Anything(serde::de::IgnoredAny),
    }
    Ok(match Option::<Shape<T>>::deserialize(deserializer)? {
        None | Some(Shape::Anything(_)) => None,
        Some(Shape::List(list)) => Some(list),
    })
}

/// The old loose tree also accepted a single category object in the `leaders` slot, not just a
/// list, so the lean shape keeps accepting one. Anything else odd reads as empty.
fn one_or_list<'de, D>(deserializer: D) -> std::result::Result<Option<Vec<ScoreboardLeaderCategory>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Shape {
        List(Vec<ScoreboardLeaderCategory>),
        One(ScoreboardLeaderCategory),
        Anything(serde::de::IgnoredAny),
    }
    Ok(match Option::<Shape>::deserialize(deserializer)? {
        None | Some(Shape::Anything(_)) => None,
        Some(Shape::List(list)) => Some(list),
        Some(Shape::One(one)) => Some(vec![one]),
    })
}

// --- Small readers over the shape ------------------------------------------------------------

fn leaf_text(leaf: Option<&Value>) -> Option<String> {
    leaf.and_then(Value::as_str).map(str::to_owned)
}

fn athlete_name(athlete: &ScoreboardAthlete) -> Option<String> {
    leaf_text(athlete.short_name.as_ref()).or_else(|| leaf_text(athlete.display_name.as_ref()))
}

/// ESPN's own scoring-play flag decides, because goal labels vary ("Goal - Header" and more).
fn is_soccer_goal(detail: &ScoreboardDetail) -> bool {
    match detail.scoring_play.as_ref().and_then(Value::as_bool) {
        Some(flag) => flag,
        None => detail
            .kind
            .as_ref()
            .is_some_and(|k| k["text"].as_str().unwrap_or("").starts_with("Goal")),
    }
}

fn soccer_scorers(details: Option<&[ScoreboardDetail]>, team_id: Option<&str>) -> Option<Vec<String>> {
    let goals: Vec<(String, Option<String>)> = details
        .unwrap_or(&[])
        .iter()
        .filter(|d| {
            is_soccer_goal(d)
                && d.team.as_ref().and_then(|t| id_text(&t["id"])).as_deref() == team_id
                && team_id.is_some()
        })
        .flat_map(|d| {
            let minute = goal_minute(d.clock.as_ref().and_then(|c| c["displayValue"].as_str()));
            d.athletes_involved
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .filter_map(move |a| Some((athlete_name(a)?, minute.clone())))
        })
        .collect();
    (!goals.is_empty()).then(|| tally(&goals))
}

fn hockey_scorers(leaders: Option<&[ScoreboardLeaderCategory]>) -> Option<Vec<String>> {
    let goals = leaders?.iter().find(|c| c.name.as_ref().is_some_and(|n| *n == json!("goals")))?;
    let names: Vec<String> = goals
        .leaders
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter_map(|l| {
            let name = l.athlete.as_ref().and_then(athlete_name)?;
            let count = match l.display_value.as_ref().unwrap_or(&Value::Null) {
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
fn score(raw: Option<&Value>) -> Value {
    let raw = raw.unwrap_or(&Value::Null);
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

fn side(competitor: Option<&ScoreboardCompetitor>, scorers: Option<Vec<String>>) -> Value {
    let team = competitor.and_then(|c| c.team.as_ref());
    let id = team.and_then(|t| t.id.as_ref()).and_then(id_text);
    let key = leaf_text(team.and_then(|t| t.abbreviation.as_ref()))
        .or_else(|| id.clone())
        .unwrap_or_default()
        .to_lowercase();
    let display = leaf_text(team.and_then(|t| t.display_name.as_ref()));
    let short = leaf_text(team.and_then(|t| t.short_display_name.as_ref())).or_else(|| display.clone());
    let crest = leaf_text(team.and_then(|t| t.logo.as_ref())).or_else(|| {
        team.and_then(|t| t.logos.as_deref().and_then(|l| l.first()))
            .and_then(|l| l.href.as_ref())
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    json!({
        "teamKey": key,
        "sourceTeamId": id,
        "name": display.clone().unwrap_or_else(|| key.clone()),
        "shortName": short.unwrap_or_else(|| key.clone()),
        "crestUrl": crest,
        "score": score(competitor.and_then(|c| c.score.as_ref())),
        "record": competitor
            .and_then(|c| c.records.as_deref().and_then(|r| r.first()))
            .and_then(|r| r.summary.as_ref())
            .and_then(Value::as_str)
            .map(str::to_owned),
        "winner": competitor.and_then(|c| c.winner.as_ref()).is_some_and(|w| *w == Value::Bool(true)),
        "scorers": scorers,
    })
}

fn game(event: &ScoreboardEvent, competition_key: &str) -> Result<Value> {
    let sport = catalog::entry(competition_key).ok_or_else(|| Error::new("Unknown competition"))?.espn_sport;
    let competition = event.competitions.as_deref().and_then(|c| c.first());
    let competitors: &[ScoreboardCompetitor] =
        competition.and_then(|c| c.competitors.as_deref()).unwrap_or(&[]);
    let by = |side_name: &str, fallback: usize| {
        competitors
            .iter()
            .find(|c| c.home_away.as_ref().is_some_and(|h| *h == json!(side_name)))
            .or_else(|| competitors.get(fallback))
    };
    let (home, away) = (by("home", 0), by("away", 1));
    let scorers = |c: Option<&ScoreboardCompetitor>| match sport {
        "soccer" => soccer_scorers(
            competition.and_then(|c| c.details.as_deref()),
            c.and_then(|c| c.team.as_ref()).and_then(|t| t.id.as_ref()).and_then(id_text).as_deref(),
        ),
        "hockey" => hockey_scorers(c.and_then(|c| c.leaders.as_deref())),
        _ => None,
    };
    let null = Value::Null;
    let status = competition.and_then(|c| c.status.as_ref()).unwrap_or(&null);
    let status_type = &status["type"];
    Ok(json!({
        "id": event.id.as_ref().and_then(id_text).unwrap_or_default(),
        "competitionKey": competition_key,
        "startsAt": event.date.as_ref().and_then(Value::as_str).unwrap_or(""),
        "state": state(status_type["state"].as_str()),
        "statusDetail": status_type["detail"].as_str().unwrap_or(""),
        "recap": competition
            .and_then(|c| c.headlines.as_deref().and_then(|h| h.first()))
            .and_then(|h| h.short_link_text.as_ref())
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                competition
                    .and_then(|c| c.notes.as_deref().and_then(|n| n.first()))
                    .and_then(|n| n.headline.as_ref())
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }),
        "home": side(home, scorers(home)),
        "away": side(away, scorers(away)),
    }))
}

/// One page of games, straight from the lean shape the live fetch deserializes into. The
/// caller dedupes across days, as before, so a page's events are kept as ESPN sends them.
pub fn parse_scoreboard_page(page: &ScoreboardPage, competition_key: &str) -> Result<Vec<Value>> {
    page.events
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|e| game(e, competition_key))
        .collect()
}

/// Whole pages merged by event id the way the club schedule reads two disjoint soccer slices.
/// Every entry point — scoreboard day, briefing, schedule — shares the one extraction. An event
/// with no id is kept without dedupe, exactly as before.
pub fn parse_scoreboard_pages(pages: &[ScoreboardPage], competition_key: &str) -> Result<Vec<Value>> {
    let mut seen: Vec<String> = vec![];
    let mut games = vec![];
    for page in pages {
        for event in page.events.as_deref().unwrap_or(&[]) {
            if let Some(id) = event.id.as_ref().and_then(id_text) {
                if seen.contains(&id) {
                    continue;
                }
                seen.push(id);
            }
            games.push(game(event, competition_key)?);
        }
    }
    Ok(games)
}

/// The recorded-fixture entry, used by the golden tests only: the page arrives as a loose tree
/// (the caller may hold it for other reads), and reads through the same lean shape, so fixtures
/// and live answers parse identically.
pub fn parse_scoreboard(data: &Value, competition_key: &str) -> Result<Vec<Value>> {
    let page: ScoreboardPage = serde_json::from_value(data.clone())?;
    parse_scoreboard_page(&page, competition_key)
}
