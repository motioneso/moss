//! `GET /results/latest`: the latest completed result for one club. It reads the person's
//! follows and public ESPN data only, and it writes nothing.
use crate::follows;
use crate::util::bad_request;
use crate::{catalog, datasets, public_cache as cache, roster};
use chrono::{DateTime, SecondsFormat};
use moss_module_sdk::{query::{Filter, Order, Query}, Client, Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

const WINDOW_MS: i64 = 90 * 86_400_000;
/// The read time rounds down to this, matching the results cache lifetime.
const ROUND_MS: i64 = 30_000;
const MAX_COMPETITIONS: usize = 8;

fn iso(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms).map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)).unwrap_or_default()
}

fn normalized(text: &str) -> String {
    text.trim().to_lowercase()
}

fn pattern_ok(text: &str, max: usize, allowed: impl Fn(char) -> bool) -> bool {
    (1..=max).contains(&text.chars().count()) && text.chars().all(allowed)
}

/// The query, checked the way the old route's schema checked it. Unknown parameters are dropped.
fn read_query(request: &RouteRequest) -> std::result::Result<(Option<String>, Option<String>, Option<String>), Response> {
    let get = |name: &str| match request.query.get(name) {
        None => Ok(None),
        Some(Value::String(t)) => Ok(Some(t.clone())),
        Some(_) => Err(bad_request(format!("querystring/{name} must be string"))),
    };
    let (name, comp, id) = (get("teamName")?, get("competitionKey")?, get("sourceTeamId")?);
    if let Some(n) = &name {
        match n.chars().count() {
            0 => return Err(bad_request("querystring/teamName must NOT have fewer than 1 characters")),
            201.. => return Err(bad_request("querystring/teamName must NOT have more than 200 characters")),
            _ => {}
        }
    }
    if let Some(c) = &comp {
        if !pattern_ok(c, 100, |ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' || ch == '-') {
            return Err(bad_request("querystring/competitionKey must match pattern \"^[a-z0-9.-]{1,100}$\""));
        }
    }
    if let Some(i) = &id {
        if !pattern_ok(i, 20, |ch| ch.is_ascii_digit()) {
            return Err(bad_request("querystring/sourceTeamId must match pattern \"^[0-9]{1,20}$\""));
        }
    }
    Ok((name, comp, id))
}

fn stop(status: &str, candidates: Vec<Value>, message: &str) -> Response {
    Response::new(200, json!({"status": status, "candidates": candidates, "message": message}))
}

pub fn latest<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let (team_name, requested, source_id) = match read_query(request) {
        Ok(q) => q,
        Err(response) => return Ok(response),
    };
    let mut query = Query::select(Filter::All);
    query.order = vec![Order { column: "created_at".into(), descending: true }, Order { column: "id".into(), descending: false }];
    let follows: Vec<Value> = Client(host).query(follows::TABLE, &query)?.iter().map(follows::dto).collect::<Result<_>>()?;
    let follow_comp = |f: &Value| f["competitionKey"].as_str().unwrap_or_default().to_owned();

    if let Some(r) = &requested {
        if catalog::entry(r).is_none() {
            return Ok(stop("unavailable", vec![], "That competition is not available in Sports."));
        }
    }
    let mut keys: Vec<String> = match &requested {
        Some(r) => vec![r.clone()],
        None => {
            let mut out: Vec<String> = vec![];
            for f in &follows {
                let k = follow_comp(f);
                if !out.contains(&k) && catalog::entry(&k).is_some() {
                    out.push(k);
                }
            }
            out
        }
    };
    if keys.is_empty() || keys.len() > MAX_COMPETITIONS || (team_name.is_none() && source_id.is_none()) {
        return Ok(stop("needs_team", vec![], "Which team and competition do you mean? Specify men's or women's when needed."));
    }
    keys.dedup();

    let mut rosters = vec![];
    for key in &keys {
        let roster = roster::league_teams(host, key)?;
        if roster.degraded || roster.teams.is_empty() {
            return Ok(stop("unavailable", vec![], "Team coverage is incomplete. Please specify the team and competition or try again."));
        }
        rosters.push((key.clone(), roster.teams));
    }

    let name = normalized(team_name.as_deref().unwrap_or(""));
    let mut candidates: Vec<(String, String, String)> = vec![];
    for (key, teams) in &rosters {
        for t in teams {
            let Some(id) = t.source_team_id.as_deref() else { continue };
            let labelled = [&t.name, &t.short_name].iter().any(|l| normalized(l) == name);
            let keep = match &source_id {
                Some(want) => id == want && (name.is_empty() || labelled),
                None => labelled && (requested.is_some() || follows.iter().any(|f| follow_comp(f) == *key && f["sourceTeamId"].as_str() == Some(id))),
            };
            if keep {
                candidates.push((key.clone(), id.to_owned(), t.name.clone()));
            }
        }
    }
    let as_json = |c: &(String, String, String)| json!({"competitionKey": c.0, "sourceTeamId": c.1, "name": c.2});
    let sport_of = |key: &str| catalog::entry(key).map(|e| e.espn_sport).unwrap_or_default();
    // One club is one sport and id. Later entries for the same club replace earlier ones.
    let mut identities: Vec<(String, &(String, String, String))> = vec![];
    for c in &candidates {
        let id = format!("{}:{}", sport_of(&c.0), c.1);
        match identities.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = c,
            None => identities.push((id, c)),
        }
    }
    let listed: Vec<Value> = candidates.iter().map(as_json).collect();
    if identities.len() != 1 {
        let status = if identities.len() > 1 { "ambiguous" } else { "needs_team" };
        return Ok(stop(status, listed, "Please choose the team and competition, including men's or women's when relevant."));
    }
    let team = identities[0].1;
    let sport = sport_of(&team.0);
    let mut competitions: Vec<String> = vec![team.0.clone()];
    for f in &follows {
        let k = follow_comp(f);
        if f["sourceTeamId"].as_str() == Some(team.1.as_str()) && sport_of(&k) == sport && !competitions.contains(&k) {
            competitions.push(k);
        }
    }
    competitions.truncate(MAX_COMPETITIONS);

    let now = cache::now_ms(host)? / ROUND_MS * ROUND_MS;
    let (from_ms, to_ms) = (now - WINDOW_MS, now);
    let (from, to) = (iso(from_ms), iso(to_ms));
    let mut failed: Vec<String> = vec![];
    let mut fetched: Vec<i64> = vec![];
    let mut found: Vec<(String, Value)> = vec![];
    for key in &competitions {
        let read = datasets::results(host, key, &team.1, from_ms, to_ms)?;
        fetched.push(read.fetched_at);
        if read.degraded {
            failed.push(key.clone());
            continue;
        }
        for result in read.results {
            let id = format!("{}:{}", result["sport"].as_str().unwrap_or_default(), result["id"].as_str().unwrap_or_default());
            match found.iter_mut().find(|(k, _)| *k == id) {
                Some(slot) => slot.1 = result,
                None => found.push((id, result)),
            }
        }
    }
    let team_json = as_json(team);
    if failed.len() == competitions.len() {
        let message = format!("Results could not be read for {} from {from} to {to}. Try again later.", competitions.join(", "));
        return Ok(stop("unavailable", vec![team_json], &message));
    }
    let when = |r: &Value| r["startsAt"].as_str().and_then(crate::followed::instant_ms).unwrap_or(i64::MIN);
    found.sort_by_key(|(_, r)| std::cmp::Reverse(when(r)));
    let result = found.into_iter().next().map(|(_, r)| r);
    fetched.sort();
    let coverage = format!(
        "Latest available result. Checked {} from {from} to {to}; other competitions may be missing.{}",
        competitions.join(", "),
        if failed.is_empty() { String::new() } else { format!(" Failed: {}.", failed.join(", ")) }
    );
    Ok(Response::new(
        200,
        json!({
            "status": if result.is_some() { "result" } else { "empty" }, "team": team_json, "result": result,
            "retrievedAt": fetched.first().map(|m| iso(*m)).unwrap_or_else(|| to.clone()),
            "from": from, "to": to, "competitions": competitions, "failedCompetitions": failed, "coverage": coverage,
        }),
    ))
}
