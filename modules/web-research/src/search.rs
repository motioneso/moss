//! One search, shaped like the old `web.search` tool: the query cut to 200 characters, at most
//! five results, and a trace that says what was cut.
use crate::{
    brave,
    gate::{self, Engine},
};
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};

pub const MAX_QUERY_UNITS: usize = 200;
pub const MAX_RESULTS: usize = 5;
const DEFAULT_RESULTS: f64 = 5.0;
pub const SEARCH_DOWN: &str = "Web search is temporarily unavailable";
pub const NEEDS_WORDS: &str = "A search needs words to look for";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freshness {
    Any,
    Day,
    Week,
    Month,
}

pub struct Query {
    pub text: String,
    pub limit: usize,
    pub freshness: Option<Freshness>,
    pub truncated: bool,
    /// True when the caller asked for more than the cap allows.
    pub limit_cut: bool,
}

pub struct Found {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub published_at: Option<String>,
}

/// Cuts to 200 UTF-16 units like the old code, never inside a character.
fn cut(text: &str) -> (String, bool) {
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        if units + c.len_utf16() > MAX_QUERY_UNITS {
            return (out, true);
        }
        units += c.len_utf16();
        out.push(c);
    }
    (out, false)
}

pub fn parse(input: &Value) -> Query {
    let (text, truncated) = cut(input["query"].as_str().unwrap_or(""));
    let requested = input["limit"]
        .as_f64()
        .filter(|n| n.is_finite())
        .unwrap_or(DEFAULT_RESULTS);
    let limit = requested.trunc().clamp(1.0, MAX_RESULTS as f64) as usize;
    let freshness = match input["freshness"].as_str() {
        Some("any") => Some(Freshness::Any),
        Some("day") => Some(Freshness::Day),
        Some("week") => Some(Freshness::Week),
        Some("month") => Some(Freshness::Month),
        _ => None,
    };
    Query {
        text,
        limit,
        freshness,
        truncated,
        limit_cut: requested > limit as f64,
    }
}

/// The host name of an address, or empty when it has none.
pub fn domain(address: &str) -> String {
    let Some((scheme, rest)) = address.split_once("://") else {
        return String::new();
    };
    if scheme.is_empty()
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return String::new();
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = match host.strip_prefix('[') {
        Some(inner) => inner.split(']').next().unwrap_or("").to_owned(),
        None => host.split(':').next().unwrap_or("").to_owned(),
    };
    host.to_ascii_lowercase()
}

fn shaped(found: &[Found], limit: usize) -> Vec<Value> {
    found
        .iter()
        .take(limit)
        .enumerate()
        .map(|(i, f)| {
            let mut row = Map::new();
            row.insert("resultId".into(), json!(format!("web-{}", i + 1)));
            row.insert("title".into(), json!(f.title));
            row.insert("url".into(), json!(f.url));
            row.insert("domain".into(), json!(domain(&f.url)));
            row.insert("snippet".into(), json!(f.snippet));
            if let Some(at) = &f.published_at {
                row.insert("publishedAt".into(), json!(at));
            }
            Value::Object(row)
        })
        .collect()
}

/// What the old unavailable provider returned, plus the reason the gate gave.
fn unavailable(query: &Query, provider: &str, reason: Option<&str>) -> Value {
    let mut trace = json!({
        "unavailable": true, "provider": provider, "resultCount": 0,
        "limitApplied": false, "queryTruncated": query.truncated
    });
    if let Some(reason) = reason {
        trace["reason"] = json!(reason);
    }
    json!({"query": query.text, "results": [], "trace": trace})
}

/// The `data` of a successful search. `Err` is a failed provider call, which callers show as
/// the fixed `SEARCH_DOWN` words.
pub fn run<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value, &'static str> {
    let query = parse(input);
    if query.text.trim().is_empty() {
        return Err(NEEDS_WORDS);
    }
    match gate::current(host) {
        Engine::None(reason) => Ok(unavailable(&query, "unavailable", Some(reason.as_str()))),
        // The host returns the model's words without the pages it cited. The old search refused
        // an address no citation backed, so this engine gives no results until it can.
        Engine::ModelNative => Ok(unavailable(
            &query,
            "model-native",
            Some("citations-not-available"),
        )),
        Engine::Brave => {
            let found = brave::search(host, &query).map_err(|()| SEARCH_DOWN)?;
            let results = shaped(&found, query.limit);
            let trace = json!({
                "provider": "brave", "count": found.len(), "resultCount": results.len(),
                "limitApplied": query.limit_cut || found.len() > results.len(),
                "queryTruncated": query.truncated
            });
            Ok(json!({"query": query.text, "results": results, "trace": trace}))
        }
    }
}
