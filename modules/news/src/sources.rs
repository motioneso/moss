//! Adding a source: preview what a typed address or subreddit would give, then save it.
use crate::personalization::{source_dto, SOURCES};
use crate::previews::{self, Candidate, Pending};
use crate::resolve::{resolve, Resolution};
use crate::util::{bad_request, error, new_id, now, now_ms, values};
use crate::input;
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

const MAX_CUSTOM_SOURCES: usize = 10;

/// A saved source already covers this candidate. Every subreddit shares one domain, so
/// subreddits match on their feed address, ignoring case, and sites match on their domain.
fn duplicate_of<'a>(existing: &'a [Value], candidate: &Candidate) -> Option<&'a Value> {
    if candidate.retrieval_method == "reddit" {
        let feed = candidate.feed_url.as_deref()?.to_lowercase();
        return existing.iter().find(|row| {
            row["retrieval_method"] == "reddit" && row["feed_url"].as_str().map(str::to_lowercase).as_deref() == Some(&feed)
        });
    }
    existing
        .iter()
        .find(|row| row["retrieval_method"] != "reddit" && row["canonical_domain"] == candidate.canonical_domain.as_str())
}

/// `POST /sources/preview`.
pub fn preview<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let (text, replace) = match input::source_preview(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let candidate = match resolve(host, &text)? {
        Resolution::Unavailable => {
            return Ok(Response::new(
                200,
                json!({"status":"unavailable","error":{"code":"news.add_source.discovery_unavailable","class":"transient"}}),
            ))
        }
        Resolution::Rejected(reason) => return Ok(Response::new(200, json!({"status":"rejected","reason":reason}))),
        Resolution::Ok(candidate) => candidate,
    };
    let confirmation_id = new_id(host)?;
    previews::put(
        host,
        &confirmation_id,
        Pending { candidates: vec![candidate.clone()], replace_source_id: replace.clone(), created_at: now_ms(host)? },
    )?;
    let duplicate = if replace.is_some() {
        None
    } else {
        let existing = Client(host).query(SOURCES, &Query::select(Filter::All))?;
        duplicate_of(&existing, &candidate).and_then(|row| row["id"].as_str().map(str::to_owned))
    };
    let mut shown = json!({
        "label": candidate.label,
        "canonicalDomain": candidate.canonical_domain,
        "homepageUrl": candidate.homepage_url,
        "retrievalMethod": candidate.retrieval_method,
        "sampleCount": candidate.sample_count,
    });
    if let Some(note) = &candidate.redirect_note {
        shown["redirectNote"] = json!(note);
    }
    let mut body = json!({
        "status": "ok",
        "confirmationId": confirmation_id,
        "candidates": [shown],
        "candidateIds": [candidate.candidate_id],
    });
    if let Some(id) = duplicate {
        body["duplicateOfSourceId"] = json!(id);
    }
    Ok(Response::new(200, body))
}

fn row_values(candidate: &Candidate, at: &str) -> std::collections::BTreeMap<String, Value> {
    values(vec![
        ("label", json!(candidate.label)),
        ("canonical_domain", json!(candidate.canonical_domain)),
        ("homepage_url", json!(candidate.homepage_url)),
        ("feed_url", json!(candidate.feed_url)),
        ("retrieval_method", json!(candidate.retrieval_method)),
        ("icon_url", json!(candidate.icon_url)),
        ("confirmed_fetch_hosts", json!(candidate.confirmed_fetch_hosts)),
        ("validation_status", json!("approved")),
        ("health_status", json!("healthy")),
        ("validation_fingerprint", json!(candidate.validation_fingerprint)),
        ("validated_at", json!(at)),
    ])
}

/// `POST /sources`. Saving does not start a refresh. The refresh job owns that.
pub fn confirm<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let (confirmation, candidate_id) = match input::source_confirm(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let Some(pending) = previews::take(host, &confirmation)? else {
        return Ok(error(409, "Source preview expired or was not found"));
    };
    if pending.candidates.len() > 1 && candidate_id.is_none() {
        return Ok(bad_request("Choose a publisher candidate"));
    }
    let chosen = match &candidate_id {
        Some(id) => pending.candidates.iter().find(|c| &c.candidate_id == id),
        None => pending.candidates.first(),
    };
    let Some(candidate) = chosen else { return Ok(bad_request("Publisher candidate is invalid")) };
    let at = now(host)?.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let client = Client(host);
    if let Some(replace) = &pending.replace_source_id {
        let mut set = row_values(candidate, &at);
        set.insert("consecutive_failures".into(), json!(0));
        let changed = client.query(SOURCES, &Query::update(Filter::eq("id", replace.as_str()), set))?;
        return Ok(match changed.first() {
            Some(row) => Response::new(201, json!({"source": source_dto(row)?})),
            None => error(409, "Source to replace was not found"),
        });
    }
    let existing = client.query(SOURCES, &Query::select(Filter::All))?;
    if duplicate_of(&existing, candidate).is_some() {
        return Ok(error(409, "news custom source already exists for this publisher"));
    }
    if existing.len() >= MAX_CUSTOM_SOURCES {
        return Ok(bad_request(format!(
            "news personalization limit reached: at most {MAX_CUSTOM_SOURCES} custom_sources per user"
        )));
    }
    let mut insert = Query::insert(row_values(candidate, &at));
    insert.conflict = Conflict::Ignore;
    match client.query(SOURCES, &insert)?.first() {
        Some(row) => Ok(Response::new(201, json!({"source": source_dto(row)?}))),
        // A parallel save won the unique rule between the read and the insert.
        None => Ok(error(409, "news custom source already exists for this publisher")),
    }
}

