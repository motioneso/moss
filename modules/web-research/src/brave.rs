//! The Brave Search request and reply. The key never appears here. The host attaches it.
use crate::gate::{BRAVE_HOST, BRAVE_KEY};
use crate::search::{Found, Freshness, Query};
use moss_module_sdk::Host;
use serde_json::{json, Value};

fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn url(query: &Query) -> String {
    let mut url = format!(
        "https://{BRAVE_HOST}/res/v1/web/search?q={}&count={}&text_decorations=false&extra_snippets=false",
        encode(&query.text),
        query.limit.min(20)
    );
    let freshness = match query.freshness {
        Some(Freshness::Day) => Some("pd"),
        Some(Freshness::Week) => Some("pw"),
        Some(Freshness::Month) => Some("pm"),
        _ => None,
    };
    if let Some(code) = freshness {
        url.push_str(&format!("&freshness={code}"));
    }
    url
}

/// The provider's results in order. A failed call or a non-success status is an error with no
/// reply text, because the reply can echo the query.
pub fn search<H: Host + ?Sized>(host: &H, query: &Query) -> Result<Vec<Found>, ()> {
    let reply = host
        .call(
            "credentials",
            "request",
            BRAVE_HOST,
            json!({"credential": BRAVE_KEY, "url": url(query), "method": "GET"}),
        )
        .map_err(|_| ())?;
    if !reply["status"]
        .as_u64()
        .is_some_and(|s| (200..300).contains(&s))
    {
        return Err(());
    }
    Ok(parse(&reply["body"]))
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").to_owned()
}

pub fn parse(body: &Value) -> Vec<Found> {
    body["web"]["results"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| Found {
                    title: text(&row["title"]),
                    url: text(&row["url"]),
                    snippet: text(&row["description"]),
                    published_at: row["age"]
                        .as_str()
                        .filter(|a| !a.is_empty())
                        .map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default()
}
