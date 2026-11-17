//! One plain public-web read for a recipe request. It sends the recipe's own accept header, keeps
//! redirects inside the recipe's fetch hosts, and reports why a read failed so a refresh can say
//! so. It never renders a page and never reads a second address.
use crate::recipe::{Kind, Recipe};
use moss_module_sdk::{Host, Result};
use moss_news_reader::url::Url;
use serde_json::json;

const USER_AGENT: &str = "Moss/1.0 (self-hosted personal dashboard)";
const MAX_BYTES: u64 = 1_000_000;
const TIMEOUT_MS: u64 = 10_000;

pub struct Answer {
    pub final_url: String,
    pub body: String,
    pub content_type: Option<String>,
}

/// Why a read failed. `reason` is the host's word (blocked, rate_limited, timeout and so on).
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub reason: String,
    pub status: Option<u16>,
}

pub fn get<H: Host + ?Sized>(host: &H, recipe: &Recipe, url: &str) -> Result<std::result::Result<Answer, Failure>> {
    let (accept, types): (&str, &[&str]) = match recipe.kind {
        Kind::Json => ("application/json", &["application/json", "text/json"]),
        Kind::Html => ("text/html,application/xhtml+xml", &["text/html", "application/xhtml+xml"]),
    };
    read(host, url, accept, types, &recipe.fetch_hosts)
}

/// The same read for any address, with the caller's accept header and host list.
pub fn read<H: Host + ?Sized>(
    host: &H,
    url: &str,
    accept: &str,
    types: &[&str],
    hosts: &[String],
) -> Result<std::result::Result<Answer, Failure>> {
    let answer = host.call(
        "fetch",
        "get",
        "public-web",
        json!({
            "url": url,
            "accept": accept,
            "maxBytes": MAX_BYTES,
            "timeoutMs": TIMEOUT_MS,
            "userAgent": USER_AGENT,
            "allowedContentTypes": types,
            "allowedHosts": hosts,
            "rejectOversizedResponses": true,
        }),
    );
    let Ok(answer) = answer else { return Ok(Err(Failure { reason: "network".into(), status: None })) };
    if answer["ok"].as_bool() != Some(true) {
        return Ok(Err(Failure {
            reason: answer["reason"].as_str().unwrap_or("network").to_owned(),
            status: answer["status"].as_u64().map(|s| s as u16),
        }));
    }
    let (Some(final_url), Some(body)) = (answer["finalUrl"].as_str(), answer["body"].as_str()) else {
        return Ok(Err(Failure { reason: "network".into(), status: None }));
    };
    let final_host = Url::parse(final_url).map(|u| u.hostname.to_lowercase()).unwrap_or_default();
    if !hosts.contains(&final_host) {
        return Ok(Err(Failure { reason: "blocked".into(), status: None }));
    }
    Ok(Ok(Answer { final_url: final_url.to_owned(), body: body.to_owned(), content_type: answer["contentType"].as_str().map(str::to_owned) }))
}
