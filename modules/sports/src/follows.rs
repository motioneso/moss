//! Followed leagues and teams. Reads and writes run as the signed-in person under row level
//! security, so one person's follows never reach another.
use crate::identity::Team;
use crate::teams::TeamList;
use crate::util::{bad_request, is_uuid, iso, values};
use crate::{catalog, input};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const TABLE: &str = "app.sports_follows";

/// One follow row as the public shape.
pub fn dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid follow row");
    let text = |key: &str| row[key].as_str().map(str::to_owned).ok_or_else(bad);
    let maybe = |key: &str| row[key].as_str().map(|t| Value::String(t.to_owned())).unwrap_or(Value::Null);
    Ok(json!({
        "id": text("id")?,
        "competitionKey": text("competition_key")?,
        "teamKey": maybe("team_key"),
        "sourceTeamId": maybe("source_team_id"),
        "createdAt": iso(&row["created_at"])?,
    }))
}

fn newest_first() -> Vec<Order> {
    vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ]
}

pub fn list<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let mut query = Query::select(Filter::All);
    query.order = newest_first();
    let rows = Client(host).query(TABLE, &query)?;
    let follows = rows.iter().map(dto).collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"follows":follows})))
}

/// Saves one follow. A repeat of a whole-league follow, or of a team already saved by its
/// permanent id, returns the row already there.
fn save<H: Host + ?Sized>(
    host: &H,
    competition: &str,
    team_key: Option<&str>,
    source_team_id: Option<&str>,
) -> Result<Value> {
    let mut insert = Query::insert(values(vec![
        ("competition_key", json!(competition)),
        ("team_key", json!(team_key)),
        ("source_team_id", json!(source_team_id)),
    ]));
    insert.conflict = Conflict::Ignore;
    let client = Client(host);
    if let Some(row) = client.query(TABLE, &insert)?.into_iter().next() {
        return dto(&row);
    }
    // A repeat: read the row that must already exist, by permanent id when there is one.
    let same = match source_team_id {
        Some(id) => Filter::eq("source_team_id", id),
        None => Filter::Null { column: "team_key".into(), not: false },
    };
    let mut query = Query::select(Filter::And { filters: vec![Filter::eq("competition_key", competition), same] });
    query.limit = Some(1);
    let row = client
        .query(TABLE, &query)?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("Follow could not be saved"))?;
    dto(&row)
}

fn shown_key(team: &Team) -> &str {
    team.abbreviation.as_deref().unwrap_or(&team.team_key)
}

/// `POST /follows`.
pub fn create<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, request: &RouteRequest) -> Result<Response> {
    let (competition, requested) = match input::new_follow(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    if !catalog::is_known(&competition) {
        return Ok(bad_request(format!("Unknown competition: {competition}")));
    }
    let Some(requested) = requested else {
        return Ok(Response::new(200, json!({"follow":save(host, &competition, None, None)?})));
    };
    // An empty list is an outage, and an outage refuses every team.
    let list = teams.teams(&competition);
    let Some(team) = list.iter().find(|t| t.team_key == requested) else {
        return Ok(bad_request(format!("Unknown team: {requested}")));
    };
    let Some(id) = team.source_team_id.as_deref() else {
        return Ok(bad_request(format!(
            "Sports could not get a permanent id for {} from the provider, so this team cannot be followed yet. Try again later.",
            team.name
        )));
    };
    let follow = save(host, &competition, Some(shown_key(team)), Some(id))?;
    Ok(Response::new(200, json!({"follow":follow})))
}

fn not_found() -> Response {
    Response::new(404, json!({"error":"That saved team no longer exists."}))
}

/// `POST /follows/:id/team`.
pub fn choose_team<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default();
    if !is_uuid(id) {
        return Ok(bad_request("params/id must match format \"uuid\""));
    }
    let chosen = match input::chosen_team(&request.body) {
        Ok(chosen) => chosen,
        Err(message) => return Ok(bad_request(message)),
    };
    let client = Client(host);
    let mut find = Query::select(Filter::eq("id", id));
    find.limit = Some(1);
    let Some(follow) = client.query(TABLE, &find)?.into_iter().next() else {
        return Ok(not_found());
    };
    if follow["team_key"].is_null() {
        return Ok(bad_request("That follow is a whole competition, not a team."));
    }
    let competition = follow["competition_key"].as_str().unwrap_or_default();
    let list = teams.teams(competition);
    if list.is_empty() {
        return Ok(bad_request(
            "The team list is unavailable right now, so this choice cannot be checked. Try again later.",
        ));
    }
    let Some(team) = list.iter().find(|t| t.source_team_id.as_deref() == Some(&chosen)) else {
        return Ok(bad_request("That team is not in this competition."));
    };
    let update = Query::update(
        Filter::And {
            filters: vec![
                Filter::eq("id", id),
                Filter::Null { column: "team_key".into(), not: true },
            ],
        },
        values(vec![("source_team_id", json!(chosen)), ("team_key", json!(shown_key(team)))]),
    );
    match client.query(TABLE, &update)?.into_iter().next() {
        Some(row) => Ok(Response::new(200, json!({"follow":dto(&row)?}))),
        None => Ok(not_found()),
    }
}

/// `DELETE /follows/:id`.
pub fn remove<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default();
    if !is_uuid(id) {
        return Ok(bad_request("params/id must match format \"uuid\""));
    }
    let removed = Client(host).query(TABLE, &Query::delete(Filter::eq("id", id)))?;
    Ok(Response::new(200, json!({"ok":!removed.is_empty()})))
}
