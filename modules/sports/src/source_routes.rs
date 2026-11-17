//! The added-source routes: list, preview, save, change targets, delete and ESPN coverage.
//! Every read and write runs as the signed-in person under row level security.
use crate::source_discovery::{self as discovery, Authority, Candidate, Resolution, Verified, Wanted};
use crate::source_input::{self as input, Confirm};
use crate::source_preview;
use crate::source_scope::{has_valid_targets, sport_label, Target, ASSIGNMENT_LIMIT};
use crate::sources::{self, Created};
use crate::teams::TeamList;
use crate::util::{bad_request, is_uuid};
use crate::{catalog, espn_coverage, follows};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const ACKNOWLEDGEMENT: &str =
    "I confirm I am authorized to fetch this publisher's public, unauthenticated sports news.";

pub(crate) fn error(status: u16, message: &str) -> Response {
    Response::new(status, json!({"error":message}))
}

pub(crate) fn rejected(reason: &str) -> Response {
    if reason == "unavailable" {
        return Response::new(200, json!({"status":"unavailable"}));
    }
    Response::new(200, json!({"status":"rejected","reason":reason}))
}

pub(crate) fn source_id(request: &RouteRequest) -> std::result::Result<String, Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default();
    if is_uuid(id) {
        Ok(id.to_owned())
    } else {
        Err(bad_request("params/id must match format \"uuid\""))
    }
}

pub(crate) fn follow_rows<H: Host + ?Sized>(host: &H) -> Result<Vec<Value>> {
    Client(host).query(follows::TABLE, &Query::select(Filter::All))
}

/// The target as the screen names it, or nothing when the person no longer has the follow.
pub(crate) fn wanted<H: Host + ?Sized>(
    host_teams: &dyn TeamList,
    target: &Target,
    follows: &[Value],
    cache: &mut HashMap<String, Vec<crate::identity::Team>>,
) -> Option<Wanted> {
    let (label, scope) = match target {
        Target::Sport(key) => (sport_label(key).to_owned(), "sport"),
        Target::Follow(id) => {
            let follow = follows.iter().find(|row| row["id"].as_str() == Some(id.as_str()))?;
            let competition = follow["competition_key"].as_str()?;
            let entry = catalog::entry(competition)?;
            match follow["team_key"].as_str() {
                None => (entry.label.to_owned(), "competition"),
                Some(team_key) => {
                    let teams = cache.entry(competition.to_owned()).or_insert_with(|| host_teams.teams(competition));
                    let team = teams.iter().find(|t| t.team_key == team_key || t.abbreviation.as_deref() == Some(team_key))?;
                    (team.name.clone(), "team")
                }
            }
        }
    };
    Some(Wanted { target: target.clone(), label, scope, exact_target_url: None })
}

pub(crate) fn candidate_response(candidate: &Candidate) -> Value {
    let head = |items: &[String]| items.iter().take(10).cloned().collect::<Vec<_>>();
    json!({
        "label": candidate.label,
        "canonicalDomain": candidate.canonical_domain,
        "homepageUrl": candidate.homepage_url,
        "retrievalMethod": candidate.retrieval_method,
        "sampleCount": candidate.sample_count,
        "confirmedFetchHosts": candidate.confirmed_fetch_hosts,
        "sampleHeadlines": head(&candidate.sample_headlines),
        "targets": candidate.targets.iter().map(|t| json!({
            "target": t.target,
            "label": t.label,
            "scope": t.scope,
            "targetUrl": t.target_url,
            "sampleHeadlines": head(&t.sample_headlines),
        })).collect::<Vec<_>>(),
    })
}

/// `GET /sources`.
pub fn list<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let mut all = vec![espn_coverage::get(host)?];
    for mut source in sources::list(host)? {
        source["kind"] = json!("custom");
        all.push(source);
    }
    Ok(Response::new(200, json!({"sources":all})))
}

/// `PUT /sources/espn/coverage`.
pub fn put_coverage<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let targets = match input::coverage(&request.body) {
        Ok(targets) => targets,
        Err(message) => return Ok(bad_request(message)),
    };
    if !has_valid_targets(&targets) {
        return Ok(bad_request("Invalid ESPN sports coverage targets"));
    }
    let rows = follow_rows(host)?;
    let missing = targets.iter().any(|t| matches!(t, Target::Follow(id) if !rows.iter().any(|r| r["id"].as_str() == Some(id))));
    if missing {
        return Ok(bad_request("ESPN coverage contains an unavailable follow"));
    }
    Ok(Response::new(200, json!({"source":espn_coverage::replace(host, &targets)?})))
}

/// `POST /sources/preview`.
pub fn preview_new<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, request: &RouteRequest) -> Result<Response> {
    let (url, items) = match input::new_preview(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let targets: Vec<Target> = items.iter().map(|a| a.target.clone()).collect();
    if !has_valid_targets(&targets) {
        return Ok(rejected("invalid_input"));
    }
    let rows = follow_rows(host)?;
    let mut cache = HashMap::new();
    let mut asked = Vec::new();
    for item in &items {
        let Some(mut one) = wanted::<H>(teams, &item.target, &rows, &mut cache) else { return Ok(rejected("invalid_input")) };
        one.exact_target_url = item.exact_target_url.clone();
        asked.push(one);
    }
    let candidate = match discovery::resolve(host, &url, &asked, None)? {
        Resolution::Rejected(reason) => return Ok(rejected(reason)),
        Resolution::Ok(candidate) => candidate,
    };
    let key = sources::candidate_identity_key(&candidate);
    let duplicate = sources::rows(host)?
        .into_iter()
        .find(|(source, _)| sources::row_identity_key(source) == key)
        .and_then(|(source, _)| source["id"].as_str().map(str::to_owned));
    let confirmation_id = source_preview::put(host, json!({"kind":"new-source","candidate":serde_json::to_value(&*candidate)?}))?;
    let mut body = json!({
        "status": "ok",
        "confirmationId": confirmation_id,
        "authorizationAcknowledgement": ACKNOWLEDGEMENT,
        "candidate": candidate_response(&candidate),
    });
    if let Some(id) = duplicate {
        body["duplicateOfSourceId"] = json!(id);
    }
    Ok(Response::new(200, body))
}

pub(crate) fn same_identity(confirm: &Confirm, candidate: &Candidate) -> bool {
    confirm.acknowledgement == ACKNOWLEDGEMENT
        && confirm.canonical_domain == candidate.canonical_domain
        && confirm.confirmed_fetch_hosts == candidate.confirmed_fetch_hosts
        && confirm.targets.len() == candidate.targets.len()
        && confirm.targets.iter().zip(&candidate.targets).all(|((target, url), saved)| {
            Target::from_json(&saved.target).is_some_and(|t| t.key() == target.key()) && *url == saved.target_url
        })
}

/// `POST /sources`.
pub fn confirm_new<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let confirm = match input::confirm(&request.body) {
        Ok(confirm) => confirm,
        Err(message) => return Ok(bad_request(message)),
    };
    let stored = source_preview::take(host, &confirm.confirmation_id)?.filter(|v| v["kind"] == "new-source");
    let Some(stored) = stored else { return Ok(error(409, "Source preview expired or was not found")) };
    let candidate: Candidate = serde_json::from_value(stored["candidate"].clone())?;
    if !same_identity(&confirm, &candidate) {
        return Ok(error(409, "Source preview identity changed"));
    }
    let key = sources::candidate_identity_key(&candidate);
    if sources::rows(host)?.iter().any(|(source, _)| sources::row_identity_key(source) == key) {
        return Ok(error(409, "Source already exists"));
    }
    if sources::count_assignments(host)? + candidate.targets.len() > ASSIGNMENT_LIMIT {
        return Ok(bad_request("A maximum of 20 source assignments is allowed"));
    }
    match sources::create(host, &candidate, &discovery::iso_now(host)?)? {
        Created::LimitExceeded => Ok(bad_request("A maximum of 10 custom sources is allowed")),
        Created::Source(source) => Ok(Response::new(201, json!({"source":source}))),
    }
}

fn verified_from(target: &Target, label: String, scope: &str, url: &str, parameters: Value, checked_at: &str) -> Verified {
    Verified {
        target: target.to_json(),
        label,
        scope: scope.to_owned(),
        target_url: url.to_owned(),
        parameters,
        sample_headlines: Vec::new(),
        checked_at: checked_at.to_owned(),
    }
}

pub(crate) fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// `POST /sources/:id/assignments/preview`.
pub fn preview_assignments<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, request: &RouteRequest) -> Result<Response> {
    let id = match source_id(request) {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };
    let items = match input::assignments_preview(&request.body) {
        Ok(items) => items,
        Err(message) => return Ok(bad_request(message)),
    };
    let targets: Vec<Target> = items.iter().map(|a| a.target.clone()).collect();
    if !has_valid_targets(&targets) {
        return Ok(rejected("invalid_input"));
    }
    let Some(baseline) = sources::baseline(host, &id)? else { return Ok(error(404, "Source not found")) };
    let source = &baseline["source"];
    let checked_at = source["lastCheckedAt"].as_str().or(source["createdAt"].as_str()).unwrap_or_default().to_owned();
    let rows = follow_rows(host)?;
    let mut cache = HashMap::new();
    let current: Vec<(String, &Value)> = baseline["assignments"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter_map(|a| {
                    let target = match (a["sportKey"].as_str(), a["followId"].as_str()) {
                        (Some(key), _) if crate::source_scope::is_sport_key(key) => Target::Sport(key.to_owned()),
                        (Some(_), _) => return None,
                        (None, Some(follow)) => Target::Follow(follow.to_owned()),
                        (None, None) => return None,
                    };
                    Some((target.key(), a))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut requested = Vec::new();
    let mut reused: Vec<(String, &Value)> = Vec::new();
    for item in &items {
        let Some(mut one) = wanted::<H>(teams, &item.target, &rows, &mut cache) else { return Ok(rejected("invalid_input")) };
        let key = item.target.key();
        let exact = item.exact_target_url.clone();
        if let Some(url) = &exact {
            if moss_news_reader::url::Url::parse(url).is_none() {
                return Ok(rejected("invalid_input"));
            }
        }
        let held = current.iter().find(|(k, _)| *k == key).map(|(_, a)| *a);
        match held {
            Some(a) if a["previewStatus"] == "verified" && a["targetUrl"].is_string() && exact.as_deref().is_none_or(|u| Some(u) == a["targetUrl"].as_str()) => {
                reused.push((key, a));
            }
            _ => {
                one.exact_target_url = exact;
                requested.push(one);
            }
        }
    }

    let reddit_feed = source["feedUrl"].as_str().filter(|_| source["retrievalMethod"] == "reddit");
    let mut found: Vec<Verified> = Vec::new();
    let (mut sample_count, mut sample_headlines) = (0, Vec::new());
    if !requested.is_empty() {
        if let (Some(feed), true) = (reddit_feed, requested.iter().all(|w| w.exact_target_url.is_none())) {
            // Every subreddit target reads the one stored feed, so no network call is made.
            found = requested.iter().map(|w| verified_from(&w.target, w.label.clone(), w.scope, feed, json!({}), &checked_at)).collect();
        } else {
            let authority = Authority {
                canonical_domain: text(&source["canonicalDomain"]),
                confirmed_fetch_hosts: baseline["confirmedFetchHosts"]
                    .as_array()
                    .map(|hosts| hosts.iter().map(text).collect())
                    .unwrap_or_default(),
                recipe: baseline["recipeJson"].as_object().map(|_| baseline["recipeJson"].clone()),
            };
            let address = source["feedUrl"].as_str().unwrap_or_else(|| source["homepageUrl"].as_str().unwrap_or_default());
            let resolved = match discovery::resolve(host, address, &requested, Some(&authority))? {
                Resolution::Rejected(reason) => return Ok(rejected(reason)),
                Resolution::Ok(candidate) => candidate,
            };
            if resolved.canonical_domain != authority.canonical_domain || resolved.confirmed_fetch_hosts != authority.confirmed_fetch_hosts {
                return Ok(rejected("stale_source"));
            }
            sample_count = resolved.sample_count;
            sample_headlines = resolved.sample_headlines.clone();
            found = resolved.targets.clone();
        }
    }

    let mut all = Vec::new();
    for (item, one) in items.iter().zip(wanted_in_order(host, teams, &items, &rows, &mut cache)) {
        let key = item.target.key();
        if let Some(hit) = found.iter().find(|v| Target::from_json(&v.target).is_some_and(|t| t.key() == key)) {
            all.push(hit.clone());
            continue;
        }
        let Some((_, held)) = reused.iter().find(|(k, _)| *k == key) else { return Ok(rejected("invalid_input")) };
        let Some(one) = one else { return Ok(rejected("invalid_input")) };
        let parameters: serde_json::Map<String, Value> =
            held["parameters"].as_object().map(|m| m.iter().filter(|(_, v)| v.is_string()).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
        all.push(verified_from(&item.target, one.label, one.scope, &text(&held["targetUrl"]), Value::Object(parameters), &checked_at));
    }

    let candidate = Candidate {
        label: text(&source["label"]),
        canonical_domain: text(&source["canonicalDomain"]),
        homepage_url: text(&source["homepageUrl"]),
        feed_url: source["feedUrl"].as_str().unwrap_or_default().to_owned(),
        retrieval_method: text(&source["retrievalMethod"]),
        validation_fingerprint: text(&baseline["validationFingerprint"]),
        icon_url: None,
        confirmed_fetch_hosts: baseline["confirmedFetchHosts"].as_array().map(|h| h.iter().map(text).collect()).unwrap_or_default(),
        checked_at,
        sample_count,
        sample_headlines,
        targets: all,
        recipe: baseline["recipeJson"].as_object().map(|_| baseline["recipeJson"].clone()),
        recipe_fingerprint: baseline["recipeFingerprint"].as_str().map(str::to_owned),
    };
    let kept: Vec<Value> = reused.iter().map(|(_, a)| a["id"].clone()).collect();
    let stored = json!({
        "kind": "assignment-replacement",
        "sourceId": id,
        "baseline": baseline_core(&baseline),
        "candidate": serde_json::to_value(&candidate)?,
        "reusedAssignmentIds": kept,
        "verifiedTargets": serde_json::to_value(&found)?,
    });
    let confirmation_id = source_preview::put(host, stored)?;
    Ok(Response::new(
        200,
        json!({
            "status": "ok",
            "confirmationId": confirmation_id,
            "authorizationAcknowledgement": ACKNOWLEDGEMENT,
            "candidate": candidate_response(&candidate),
        }),
    ))
}

/// The labels again, in request order, for the targets a preview reused.
fn wanted_in_order<H: Host + ?Sized>(
    _host: &H,
    teams: &dyn TeamList,
    items: &[input::Assignment],
    rows: &[Value],
    cache: &mut HashMap<String, Vec<crate::identity::Team>>,
) -> Vec<Option<Wanted>> {
    items.iter().map(|a| wanted::<H>(teams, &a.target, rows, cache)).collect()
}

/// The parts of a source a confirm compares to see whether it moved after the preview.
pub(crate) fn baseline_core(baseline: &Value) -> Value {
    json!({
        "updatedAt": baseline["updatedAt"],
        "validationFingerprint": baseline["validationFingerprint"],
        "recipeFingerprint": baseline["recipeFingerprint"],
        "assignments": baseline["assignments"],
    })
}

/// `PATCH /sources/:id/assignments`.
pub fn confirm_assignments<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match source_id(request) {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };
    let confirm = match input::confirm(&request.body) {
        Ok(confirm) => confirm,
        Err(message) => return Ok(bad_request(message)),
    };
    let stored = source_preview::take(host, &confirm.confirmation_id)?
        .filter(|v| v["kind"] == "assignment-replacement" && v["sourceId"] == id.as_str());
    let Some(stored) = stored else { return Ok(error(409, "Assignment preview expired or was not found")) };
    let candidate: Candidate = serde_json::from_value(stored["candidate"].clone())?;
    if !same_identity(&confirm, &candidate) {
        return Ok(error(409, "Assignment preview identity changed"));
    }
    let Some(current) = sources::baseline(host, &id)?.filter(|now| baseline_core(now) == stored["baseline"]) else {
        return Ok(error(409, "Source changed after assignment preview"));
    };
    let held = current["assignments"].as_array().map_or(0, Vec::len);
    if sources::count_assignments(host)? - held + candidate.targets.len() > ASSIGNMENT_LIMIT {
        return Ok(bad_request("A maximum of 20 source assignments is allowed"));
    }
    let reused: Vec<String> = stored["reusedAssignmentIds"].as_array().map(|ids| ids.iter().map(text).collect()).unwrap_or_default();
    let verified: Vec<Verified> = serde_json::from_value(stored["verifiedTargets"].clone())?;
    match sources::replace_assignments(host, &id, &reused, &verified)? {
        Some(source) => Ok(Response::new(200, json!({"source":source}))),
        None => Ok(error(404, "Source not found")),
    }
}

/// `DELETE /sources/:id`.
pub fn remove<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match source_id(request) {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };
    let deleted = sources::remove(host, &id)?;
    // The copies are private files, so they go with the source. If removal fails, no route can
    // reach the leftover copy, and the retention sweep removes it later.
    if deleted {
        let _ = crate::photo_store::remove_source(host, &id);
    }
    Ok(Response::new(200, json!({"deleted":deleted})))
}
