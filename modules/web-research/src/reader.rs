//! Page reading for `web.read`. Every guard lives in the host's public-web fetch: HTTPS only,
//! public addresses only (every redirect hop and every resolved address is checked), the site's
//! robots rules, one call per second to one site, and caps on time, size and content type.
//! This file asks the host, shapes the answer, and turns a page into readable text. It never
//! stores or logs an address, and a refused read carries only a fixed reason word.
use crate::search::domain;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

pub const MAX_READ_URLS: usize = 5;
pub const MAX_TEXT_UNITS: usize = 12_000;
pub const EXCERPT_UNITS: usize = 500;
const MAX_BYTES: u64 = 500_000;
const TIMEOUT_MS: u64 = 8_000;
const AGENT: &str = "Moss-WebResearch/0.1";
const READABLE: [&str; 3] = ["text/html", "application/xhtml+xml", "text/plain"];
/// Every reason the host can give. Anything else reads as a network failure.
const REASONS: [&str; 8] = [
    "blocked",
    "robots",
    "rate_limited",
    "not_https",
    "timeout",
    "network",
    "http_error",
    "challenge",
];
const DETAILS: [&str; 4] = [
    "aborted",
    "invalid_response",
    "response_too_large",
    "unsupported_content_type",
];

/// A read the host refused or could not finish.
pub struct Skipped {
    pub reason: &'static str,
    pub detail: Option<&'static str>,
}

fn skipped(reason: &'static str) -> Skipped {
    Skipped {
        reason,
        detail: None,
    }
}

/// The characters JavaScript counts as white space, which the old reader collapsed.
fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// UTF-16 length, the unit the old code counted in.
pub fn units(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The longest start of `text` within `limit` UTF-16 units, never cutting inside a character.
pub fn cut(text: &str, limit: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices() {
        used += c.len_utf16();
        if used > limit {
            return &text[..at];
        }
    }
    text
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Replaces each `open ... close` span with one space. With `tag` set, `open` is a tag name that
/// must end at a word boundary and the opening tag runs to its first `>`.
fn drop_spans(input: &str, open: &str, close: &str, tag: bool) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let (mut copied, mut from) = (0, 0);
    while let Some(found) = lower[from..].find(open) {
        let start = from + found;
        let mut body = start + open.len();
        if tag {
            if lower.as_bytes().get(body).is_some_and(|b| is_word(*b)) {
                from = start + 1;
                continue;
            }
            // No `>` after this point means no later tag can match either.
            let Some(gt) = lower[body..].find('>') else {
                break;
            };
            body += gt + 1;
        }
        let Some(end) = lower[body..].find(close) else {
            break;
        };
        out.push_str(&input[copied..start]);
        out.push(' ');
        copied = body + end + close.len();
        from = copied;
    }
    out.push_str(&input[copied..]);
    out
}

/// Replaces each `<` through the next `>` with a space. A `<>` with nothing between stays.
fn drop_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let (mut copied, mut from) = (0, 0);
    while let Some(found) = input[from..].find('<') {
        let start = from + found;
        let Some(gt) = input[start + 1..].find('>') else {
            break;
        };
        if gt == 0 {
            from = start + 1;
            continue;
        }
        out.push_str(&input[copied..start]);
        out.push(' ');
        copied = start + 1 + gt + 1;
        from = copied;
    }
    out.push_str(&input[copied..]);
    out
}

/// The six entities the old reader knew, replaced in the old order.
fn decode(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn title_of(html: &str) -> &str {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return "";
    };
    let Some(gt) = lower[start + 6..].find('>') else {
        return "";
    };
    let body = start + 6 + gt + 1;
    match lower[body..].find("</title>") {
        Some(end) => &html[body..body + end],
        None => "",
    }
}

/// The page title and its text with scripts, styles, navigation, comments and tags removed and
/// white space collapsed, as the old reader did it.
pub fn extract_readable_text(html: &str) -> (String, String) {
    let title = decode(title_of(html)).trim_matches(is_space).to_owned();
    let mut text = drop_spans(html, "<!--", "-->", false);
    for name in ["script", "style", "nav", "noscript", "svg"] {
        text = drop_spans(&text, &format!("<{name}"), &format!("</{name}>"), true);
    }
    let decoded = decode(&drop_tags(&text));
    let mut out = String::with_capacity(decoded.len());
    let mut gap = false;
    for c in decoded.trim_matches(is_space).chars() {
        if is_space(c) {
            gap = true;
        } else {
            if gap {
                out.push(' ');
                gap = false;
            }
            out.push(c);
        }
    }
    (title, out)
}

fn known(value: &Value, list: &[&'static str]) -> Option<&'static str> {
    list.iter().copied().find(|k| value.as_str() == Some(k))
}

/// Reads one address through the host. `Err` carries the fixed reason the read was refused.
pub fn read_page<H: Host + ?Sized>(
    host: &H,
    address: &str,
    fetched_at: &str,
) -> std::result::Result<Value, Skipped> {
    let reply = host
        .call(
            "fetch",
            "get",
            "public-web",
            json!({
                "url": address, "maxBytes": MAX_BYTES, "timeoutMs": TIMEOUT_MS,
                "userAgent": AGENT, "allowedContentTypes": READABLE
            }),
        )
        .map_err(|_| skipped("network"))?;
    if reply["ok"] != json!(true) {
        return Err(Skipped {
            reason: known(&reply["reason"], &REASONS).unwrap_or("network"),
            detail: known(&reply["detail"], &DETAILS),
        });
    }
    let body = reply["body"].as_str().unwrap_or("");
    let (title, text) = extract_readable_text(body.strip_prefix('\u{feff}').unwrap_or(body));
    let capped = cut(&text, MAX_TEXT_UNITS);
    let final_url = reply["finalUrl"].as_str().unwrap_or(address);
    Ok(json!({
        "url": final_url,
        "domain": domain(final_url),
        "title": title,
        "text": capped,
        "excerpt": cut(capped, EXCERPT_UNITS),
        "fetchedAt": fetched_at,
        "truncated": reply["truncated"] == json!(true) || units(&text) > MAX_TEXT_UNITS,
        "status": reply["status"].as_u64().unwrap_or(200)
    }))
}

/// The host clock for this call, as the time a page was fetched.
fn fetched_at<H: Host + ?Sized>(host: &H) -> Result<String> {
    host.call("context", "read", "call", json!({}))?["now"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| moss_module_sdk::Error::new("Host clock unavailable"))
}

/// The `data` of a `web.read` call. Up to five addresses are read in order. A page that could
/// not be read appears as a skipped entry with a fixed reason, never as an error.
pub fn run<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let asked: Vec<&str> = input["urls"]
        .as_array()
        .map(|rows| rows.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let taken = &asked[..asked.len().min(MAX_READ_URLS)];
    let at = if taken.is_empty() {
        String::new()
    } else {
        fetched_at(host)?
    };
    let (mut documents, mut passed) = (Vec::new(), Vec::new());
    for address in taken {
        match read_page(host, address, &at) {
            Ok(document) => documents.push(document),
            Err(why) => {
                let mut row = json!({"url": address, "status": "skipped", "reason": why.reason});
                if let Some(detail) = why.detail {
                    row["detail"] = json!(detail);
                }
                passed.push(row);
            }
        }
    }
    let mut seen: Vec<Value> = documents
        .iter()
        .map(|d| json!({"url": d["url"], "status": d["status"], "truncated": d["truncated"]}))
        .collect();
    let skipped_count = passed.len() + asked.len() - taken.len();
    seen.extend(passed);
    Ok(json!({
        "documents": documents,
        "trace": {
            "requestedUrlCount": asked.len(),
            "fetchedUrlCount": documents.len(),
            "skippedUrlCount": skipped_count,
            "urlLimitApplied": asked.len() > taken.len(),
            "documents": seen
        }
    }))
}
