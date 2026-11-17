//! Chat tools. The host picks the person, so no tool takes a person from the request.
use crate::evidence;
use crate::personalization::SOURCES;
use crate::previews::{self, Pending};
use crate::resolve::{resolve, Resolution};
use crate::sources::duplicate_of;
use crate::util::{new_id, now_ms};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

const CREDENTIALS: &str = "app.news_source_credentials";
const RATE_LIMITED: &str = "Reddit is rate limiting Moss. Headlines resume automatically.";
const AUTH_REQUIRED: &str = "This subreddit is private or restricted.";
const DISCOVERY_DOWN: &str = "Source discovery is currently unavailable \u{2014} try again later.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    pub tool: String,
    pub parameters: Value,
}

fn refusal(message: &str) -> Value {
    json!({"data": {"error": message}})
}

fn guidance(health: &str, credential: &str) -> &'static str {
    if credential == "not_configured" {
        return "No key is configured. Connect one in News settings.";
    }
    match health {
        "authentication_failed" => "Authentication failed. Replace the key in News settings.",
        "disabled" => "Access is disabled. Replace the key in News settings.",
        "temporarily_unavailable" => "The publisher is temporarily unavailable. Try again later.",
        "unsupported" => "This publisher is unsupported. Choose another source.",
        _ => "This source is connected and healthy.",
    }
}

/// Display-safe source diagnostics. Only the source and its status are read from the key rows.
fn credentialed_status<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let sources = client.query(SOURCES, &Query::select(Filter::All))?;
    let keys = client.query(CREDENTIALS, &Query::select(Filter::All))?;
    let rows: Vec<Value> = sources
        .iter()
        .map(|source| {
            let credential = keys
                .iter()
                .find(|key| key["source_id"] == source["id"])
                .and_then(|key| key["status"].as_str())
                .filter(|status| matches!(*status, "configured" | "revoked"))
                .unwrap_or("not_configured");
            let health = source["health_status"].as_str().unwrap_or_default();
            json!({
                "sourceId": source["id"], "label": source["label"], "domain": source["canonical_domain"],
                "healthStatus": source["health_status"], "credentialStatus": credential,
                "guidance": guidance(health, credential),
            })
        })
        .collect();
    Ok(json!({"data": {"sources": rows}}))
}

fn failure_text(reason: &str) -> &'static str {
    match reason {
        "policy" => "That publisher is not allowed by content policy.",
        "redirected" => "That address redirects to a different site; try the address it sends you to.",
        "invalid_input" => "That doesn't look like a news publisher URL or name.",
        "not_https" => "Publisher sites must be reachable over HTTPS.",
        "unreachable" => "Could not reach or verify that publisher.",
        "blocked" => "That publisher's site does not allow automatic access, so it can't be added.",
        "rate_limited" => RATE_LIMITED,
        "auth_required" => AUTH_REQUIRED,
        _ => DISCOVERY_DOWN,
    }
}

/// Checks a typed publisher and stores the result for a later confirm. The reply never carries
/// the feed address or the check fingerprint.
fn preview_source<H: Host + ?Sized>(host: &H, source: &str) -> Result<Value> {
    let typed = source.trim();
    if typed.is_empty() {
        return Ok(refusal("Provide a publisher URL or name to preview."));
    }
    let candidate = match resolve(host, typed)? {
        Resolution::Unavailable => return Ok(refusal(DISCOVERY_DOWN)),
        Resolution::Rejected(reason) => return Ok(refusal(failure_text(reason))),
        Resolution::Ok(candidate) => candidate,
    };
    let id = new_id(host)?;
    previews::put(host, &id, Pending { candidates: vec![candidate.clone()], replace_source_id: None, created_at: now_ms(host)? })?;
    let existing = Client(host).query(SOURCES, &Query::select(Filter::All))?;
    let mut shown = json!({"candidateId": candidate.candidate_id, "label": candidate.label, "domain": candidate.canonical_domain});
    if let Some(note) = &candidate.redirect_note {
        shown["redirectNote"] = json!(note);
    }
    let mut data = json!({"confirmationId": id, "candidates": [shown]});
    if let Some(found) = duplicate_of(&existing, &candidate).and_then(|row| row["id"].as_str()) {
        data["duplicateOfSourceId"] = json!(found);
    }
    Ok(json!({"data": data}))
}

/// Queues a refresh of the person's feed. The work runs in the background.
fn refresh_news<H: Host + ?Sized>(host: &H) -> Result<Value> {
    crate::refresh::bump(host, false)?;
    let _ = crate::refresh::reconcile_schedule(host);
    let queued = crate::refresh::enqueue_refresh(host)?;
    Ok(json!({"data": {"status": if queued { "queued" } else { "accepted" }, "asynchronous": true}}))
}

fn empty(parameters: &Value) -> bool {
    parameters.is_null() || parameters.as_object().is_some_and(|map| map.is_empty())
}

pub fn handle<H: Host + ?Sized>(host: &H, request: ToolRequest) -> Result<Value> {
    match request.tool.as_str() {
        "news.heartbeatHeadlines" => match evidence::heartbeat_limit(&if request.parameters.is_null() { json!({}) } else { request.parameters.clone() }) {
            Some(limit) => Ok(json!({"data": evidence::heartbeat(host, limit)?})),
            None => Err(Error::new("Invalid heartbeat read input")),
        },
        "news.topHeadlinesToday" => Ok(json!({"data": evidence::top_headlines(host)?})),
        "news.credentialedSourceStatus" => credentialed_status(host),
        "news.previewSource" => preview_source(host, request.parameters["source"].as_str().unwrap_or_default()),
        "news.refreshNews" if empty(&request.parameters) => refresh_news(host),
        "news.refreshNews" => Err(Error::new("Invalid refresh input")),
        _ => Err(Error::new("Unknown News tool")),
    }
}
