//! The follow and unfollow chat tools. Following saves exactly what the follow route saves, and
//! both tools touch only the signed-in person's own follows, so neither needs an approval card.
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
