//! The public-data routes. They read ESPN through the cache and carry no personal data.
use crate::util::bad_request;
use crate::{catalog, roster};
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::Value;

/// `GET /leagues/:competitionKey/teams`.
pub fn league_teams<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let key = request.params.get("competitionKey").map(String::as_str).unwrap_or_default();
    if key.chars().count() > 100 {
        return Ok(bad_request("params/competitionKey must NOT have more than 100 characters"));
    }
    if catalog::entry(key).is_none() {
        return Ok(bad_request(format!("Unknown competition: {key}")));
    }
    Ok(Response::new(200, roster::roster_body(&roster::league_teams(host, key)?)))
}

/// `GET /teams/search?q=`. The query is used only to filter and is never stored.
pub fn search<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let q = match request.query.get("q") {
        None => return Ok(bad_request("querystring must have required property 'q'")),
        Some(Value::String(q)) => q,
        Some(_) => return Ok(bad_request("querystring/q must be string")),
    };
    match q.chars().count() {
        0 | 1 => return Ok(bad_request("querystring/q must NOT have fewer than 2 characters")),
        81.. => return Ok(bad_request("querystring/q must NOT have more than 80 characters")),
        _ => {}
    }
    Ok(Response::new(200, roster::search_body(&roster::search(host, q)?)))
}
