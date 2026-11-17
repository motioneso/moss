//! Retry and recipe rebuild for a saved source. Retry reads the source again right now. A rebuild
//! asks the model for a fresh recipe against the source's confirmed hosts, shows it for
//! confirmation, and replaces the saved recipe only if the source has not moved since.
use crate::source_discovery::{self as discovery, Authority, Candidate, Resolution, Wanted};
use crate::source_input as input;
use crate::source_preview;
use crate::source_refresh;
use crate::source_routes::{baseline_core, candidate_response, error, follow_rows, rejected, same_identity, source_id, text, wanted, ACKNOWLEDGEMENT};
use crate::source_scope::Target;
use crate::sources;
use crate::teams::TeamList;
use crate::util::bad_request;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};
use std::collections::HashMap;

/// `POST /sources/:id/retry`.
pub fn retry<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match source_id(request) {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };
    if sources::baseline(host, &id)?.is_none() {
        return Ok(error(404, "Source not found"));
    }
    source_refresh::refresh(host, Some(&id))?;
    match sources::baseline(host, &id)? {
        Some(baseline) => Ok(Response::new(200, json!({"source": baseline["source"]}))),
        None => Ok(error(404, "Source not found")),
    }
}

fn saved_target(assignment: &Value) -> Option<Target> {
    match (assignment["sportKey"].as_str(), assignment["followId"].as_str()) {
        (Some(key), _) if crate::source_scope::is_sport_key(key) => Some(Target::Sport(key.to_owned())),
        (Some(_), _) => None,
        (None, Some(follow)) => Some(Target::Follow(follow.to_owned())),
        (None, None) => None,
    }
}

/// `POST /sources/:id/rebuild/preview`.
pub fn preview<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, request: &RouteRequest) -> Result<Response> {
    let id = match source_id(request) {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };
    let Some(baseline) = sources::baseline(host, &id)? else { return Ok(error(404, "Source not found")) };
    let source = &baseline["source"];
    let rows = follow_rows(host)?;
    let mut cache = HashMap::new();
    let mut asked: Vec<Wanted> = Vec::new();
    for assignment in baseline["assignments"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(target) = saved_target(assignment) else { return Ok(rejected("stale_source")) };
        let Some(one) = wanted::<H>(teams, &target, &rows, &mut cache) else { return Ok(rejected("stale_source")) };
        asked.push(one);
    }
    let authority = Authority {
        canonical_domain: text(&source["canonicalDomain"]),
        confirmed_fetch_hosts: baseline["confirmedFetchHosts"].as_array().map(|h| h.iter().map(text).collect()).unwrap_or_default(),
        recipe: None,
    };
    let address = source["feedUrl"].as_str().unwrap_or_else(|| source["homepageUrl"].as_str().unwrap_or_default());
    let mut candidate = match discovery::resolve(host, address, &asked, Some(&authority))? {
        Resolution::Rejected(reason) => return Ok(rejected(reason)),
        Resolution::Ok(candidate) => candidate,
    };
    let same = if source["retrievalMethod"] == "reddit" || candidate.retrieval_method == "reddit" {
        sources::candidate_identity_key(&candidate)
            == sources::identity_key("reddit", &text(&source["canonicalDomain"]), source["feedUrl"].as_str(), source["homepageUrl"].as_str())
    } else {
        moss_news_reader::same_publisher(&candidate.canonical_domain, &text(&source["canonicalDomain"]))
    };
    if !same {
        return Ok(rejected("stale_source"));
    }
    // A rebuild refreshes retrieval, not identity, so the row keeps its own domain.
    candidate.canonical_domain = text(&source["canonicalDomain"]);
    let stored = json!({
        "kind": "recipe-rebuild",
        "sourceId": id,
        "baseline": baseline_core(&baseline),
        "candidate": serde_json::to_value(&*candidate)?,
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

/// `PATCH /sources/:id/rebuild`.
pub fn confirm<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match source_id(request) {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };
    let confirm = match input::confirm(&request.body) {
        Ok(confirm) => confirm,
        Err(message) => return Ok(bad_request(message)),
    };
    let stored = source_preview::take(host, &confirm.confirmation_id)?.filter(|v| v["kind"] == "recipe-rebuild" && v["sourceId"] == id.as_str());
    let Some(stored) = stored else { return Ok(error(409, "Recipe preview expired or was not found")) };
    let candidate: Candidate = serde_json::from_value(stored["candidate"].clone())?;
    if !same_identity(&confirm, &candidate) {
        return Ok(error(409, "Recipe preview identity changed"));
    }
    if !sources::baseline(host, &id)?.is_some_and(|now| baseline_core(&now) == stored["baseline"]) {
        return Ok(error(409, "Source changed after recipe preview"));
    }
    match sources::replace_recipe(host, &id, &candidate, &discovery::iso_now(host)?)? {
        Some(source) => Ok(Response::new(200, json!({"source": source}))),
        None => Ok(error(404, "Source not found")),
    }
}
