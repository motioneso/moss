//! The follow and unfollow chat tools, and the approval cards that show what each would change.
//! Following saves exactly what the follow route saves. A card is built from the catalog, today's
//! team list and the person's saved follows, never from text the model supplied.
use crate::teams::TeamList;
use crate::{catalog, follows};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result, RouteRequest,
};
use serde_json::{json, Map, Value};

pub const FOLLOW: &str = "sports.followTeam";
pub const UNFOLLOW: &str = "sports.unfollowTeam";

const PATTERN: &str = "^[a-z0-9.]{1,100}$";

fn key_ok(text: &str) -> bool {
    (1..=100).contains(&text.len()) && text.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.')
}

/// `competitionKey` and the optional `teamKey`, checked as the old tool schema checked them.
pub fn keys(input: &Map<String, Value>, verb: &str) -> std::result::Result<(String, Option<String>), String> {
    let get = |name: &str| match input.get(name) {
        None => Ok(None),
        Some(Value::String(text)) if key_ok(text) => Ok(Some(text.clone())),
        Some(Value::String(_)) => Err(format!("{name} must match pattern \"{PATTERN}\"")),
        Some(_) => Err(format!("{name} must be string")),
    };
    let competition = get("competitionKey")?.ok_or_else(|| format!("Provide a competitionKey to {verb}."))?;
    Ok((competition, get("teamKey")?))
}

fn failure(message: &str) -> Value {
    json!({"data":{"error":message}})
}

fn field(label: &str, value: &str) -> Value {
    json!({"label":label,"value":value})
}

fn competition_label(key: &str) -> String {
    catalog::entry(key).map_or_else(|| key.to_owned(), |e| e.label.to_owned())
}

/// `sports.followTeam`. The route's own check and save, so the two cannot disagree.
pub fn follow<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, input: &Map<String, Value>) -> Result<Value> {
    let (competition, team) = match keys(input, "follow") {
        Ok(found) => found,
        Err(message) => return Ok(failure(&message)),
    };
    let request = RouteRequest {
        method: "POST".into(),
        path: "/follows".into(),
        params: Default::default(),
        query: Default::default(),
        body: json!({"competitionKey": competition, "teamKey": team}),
    };
    let response = follows::create(host, teams, &request)?;
    if response.status >= 300 {
        return Ok(failure(response.body["error"].as_str().unwrap_or("The request failed")));
    }
    Ok(json!({"data":response.body}))
}

/// The saved follow a request means, found by the provider's permanent team id and never by name.
fn saved<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, competition: &str, team: Option<&str>) -> Result<Option<Value>> {
    let rows = Client(host).query(follows::TABLE, &Query::select(Filter::All))?;
    let in_competition = rows.into_iter().filter(|row| row["competition_key"] == competition);
    let Some(team) = team else {
        return Ok(in_competition.into_iter().find(|row| row["team_key"].is_null()));
    };
    let id = teams.teams(competition).into_iter().find(|t| t.team_key == team).and_then(|t| t.source_team_id);
    Ok(id.and_then(|id| in_competition.into_iter().find(|row| row["source_team_id"] == id.as_str())))
}

/// `sports.unfollowTeam`. Removing something never followed is a no-op, so follow, unfollow and
/// follow again always agree.
pub fn unfollow<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, input: &Map<String, Value>) -> Result<Value> {
    let (competition, team) = match keys(input, "unfollow") {
        Ok(found) => found,
        Err(message) => return Ok(failure(&message)),
    };
    if !catalog::is_known(&competition) {
        return Ok(failure(&format!("Unknown competition: {competition}")));
    }
    let Some(row) = saved(host, teams, &competition, team.as_deref())? else {
        return Ok(json!({"data":{"removed":false}}));
    };
    let gone = Client(host).query(follows::TABLE, &Query::delete(Filter::eq("id", row["id"].clone())))?;
    Ok(json!({"data":{"removed":!gone.is_empty()}}))
}

/// The card for one follow or unfollow call, or `None` when the call cannot be shown in full.
pub fn card<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, tool: &str, input: &Value) -> Result<Option<Value>> {
    let Some(map) = input.as_object().filter(|m| m.keys().all(|k| k == "competitionKey" || k == "teamKey")) else {
        return Ok(None);
    };
    let Ok((competition, team)) = keys(map, "follow") else { return Ok(None) };
    let label = competition_label(&competition);
    if tool == FOLLOW {
        let Ok(pick) = follows::pick(teams, &competition, team.as_deref()) else { return Ok(None) };
        let shown = pick.name.clone().unwrap_or_else(|| format!("All of {label}"));
        let version = json!([tool, competition, pick.team_key, pick.source_team_id]);
        return Ok(Some(json!({
            "title": if pick.name.is_some() { "Follow sports team" } else { "Follow sports competition" },
            "content": "user_authored", "target": shown,
            "fields": [field("Competition", &label), field("Team", &shown)],
            "version": version.to_string(),
        })));
    }
    if !catalog::is_known(&competition) {
        return Ok(None);
    }
    let found = saved(host, teams, &competition, team.as_deref())?;
    let shown = match (&team, &found) {
        (None, _) => format!("All of {label}"),
        (Some(_), Some(row)) => row["team_key"].as_str().unwrap_or_default().to_owned(),
        (Some(key), None) => teams
            .teams(&competition)
            .into_iter()
            .find(|t| &t.team_key == key)
            .map_or_else(|| key.clone(), |t| t.name),
    };
    let effect = if found.is_some() { "Stop following and remove it from your sports pages." } else { "You do not follow this, so nothing changes." };
    let version = json!([tool, competition, team, found.as_ref().map(|row| row["id"].clone())]);
    Ok(Some(json!({
        "title": "Unfollow sports team", "content": "user_authored", "target": shown,
        "fields": [field("Competition", &label), field("Team", &shown), field("Effect", effect)],
        "version": version.to_string(),
    })))
}
