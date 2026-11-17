//! The body of the one featured story, read from ESPN's content host.
//!
//! Only a bare number of four or more digits can reach the address, so a poisoned feed cannot
//! steer the read to another host or path. ESPN's markup is cut down to plain text and clipped
//! before it leaves this file. Any failure gives no body and the screen shows the summary.
use crate::public_cache::{self as cache, Store};
use crate::espn;
use moss_module_sdk::{Host, Result};
use serde_json::Value;

const CONTENT_BASE: &str = "https://content.core.api.espn.com/v1/sports/news";
const BODY_CHAR_CAP: usize = 900;
const MAX_BODY_PARAGRAPHS: usize = 3;
const SIX_HOURS_MS: i64 = 6 * 60 * 60 * 1000;

/// Real article ids are numbers of four or more digits. The ids a list gets for a story with no
/// id of its own are positions (one to three digits), and those name no article.
pub fn is_article_id(id: &str) -> bool {
    id.len() >= 4 && id.bytes().all(|b| b.is_ascii_digit())
}

fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// Removes every `<...>` run. A `<` with no closing `>` stays, and is dropped later with the rest
/// of the stray angle brackets.
fn strip_tags(text: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let after = &rest[open + 1..];
        match after.find('>') {
            // A tag needs at least one character before the closing bracket.
            Some(close) if close > 0 => {
                out.push_str(&rest[..open]);
                out.push_str(replacement);
                rest = &after[close + 1..];
            }
            _ => {
                out.push_str(&rest[..open + 1]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Replaces every `&#NNN;` (or `&#xHH;` when `hex`) with its character. A code that is not a
/// character stays as written.
fn replace_numeric(text: &str, hex: bool) -> String {
    let opener = if hex { "&#x" } else { "&#" };
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(opener) {
        out.push_str(&rest[..at]);
        let body = &rest[at + opener.len()..];
        let digits: String = body.chars().take_while(|c| if hex { c.is_ascii_hexdigit() } else { c.is_ascii_digit() }).collect();
        if !digits.is_empty() && body[digits.len()..].starts_with(';') {
            let whole = &rest[at..at + opener.len() + digits.len() + 1];
            let code = u32::from_str_radix(&digits, if hex { 16 } else { 10 }).ok().and_then(char::from_u32);
            out.push_str(&code.map(String::from).unwrap_or_else(|| whole.to_owned()));
            rest = &rest[whole.len()..];
        } else {
            out.push_str(opener);
            rest = body;
        }
    }
    out.push_str(rest);
    out
}

/// `&#39;` with any number of leading zeros, the apostrophe ESPN writes.
fn replace_apostrophes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("&#0") {
        let after = &rest[at + 2..];
        let zeros = after.bytes().take_while(|b| *b == b'0').count();
        if after[zeros..].starts_with("39;") {
            out.push_str(&rest[..at]);
            out.push('\u{2019}');
            rest = &after[zeros + 3..];
        } else {
            out.push_str(&rest[..at + 3]);
            rest = &rest[at + 3..];
        }
    }
    out.push_str(rest);
    out.replace("&#39;", "\u{2019}")
}

/// The small set of entities ESPN sends, replaced one name after another in a fixed order, as the
/// old code did.
fn decode_entities(text: &str) -> String {
    let mut out = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"");
    out = replace_apostrophes(&out).replace("&apos;", "\u{2019}").replace("&rsquo;", "\u{2019}");
    out = out
        .replace("&lsquo;", "\u{2018}")
        .replace("&ldquo;", "\u{201c}")
        .replace("&rdquo;", "\u{201d}")
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&hellip;", "\u{2026}")
        .replace("&nbsp;", " ");
    replace_numeric(&replace_numeric(&out, false), true)
}

/// Removes `<photoN>` placeholders and every stray angle bracket.
fn drop_debris(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let inner_end = after.find('>');
        let is_photo = inner_end.is_some_and(|end| {
            let inner = after[..end].trim().to_ascii_lowercase();
            inner.strip_prefix("photo").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        });
        rest = match (is_photo, inner_end) {
            (true, Some(end)) => &after[end + 1..],
            _ => after,
        };
    }
    out.push_str(rest);
    out.replace('>', "").trim().to_owned()
}

/// The text of each `<p>` block, in order, at most `limit` of them.
fn paragraphs(story: &str, limit: usize) -> Vec<String> {
    let lower = story.to_ascii_lowercase();
    let mut out = vec![];
    let mut from = 0;
    while out.len() < limit {
        let Some(found) = lower[from..].find("<p") else { break };
        let open = from + found;
        // `<p` must be a whole tag name, so `<pre>` and `<photo1>` do not count.
        let boundary = lower[open + 2..].chars().next();
        if boundary.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            from = open + 2;
            continue;
        }
        let Some(gt) = lower[open..].find('>') else { break };
        let inner_start = open + gt + 1;
        let Some(close) = lower[inner_start..].find("</p>") else { break };
        out.push(story[inner_start..inner_start + close].to_owned());
        from = inner_start + close + 4;
    }
    out
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// ESPN story HTML as plain text: the first three paragraphs, markup and placeholders gone, and
/// at most 900 characters, cut at a word and ended with an ellipsis.
pub fn sanitize(story: Option<&str>) -> String {
    let Some(story) = story.filter(|s| !s.is_empty()) else { return String::new() };
    let mut found: Vec<String> = vec![];
    for inner in paragraphs(story, MAX_BODY_PARAGRAPHS) {
        let plain = decode_entities(&collapse_spaces(&strip_tags(&inner, ""))).trim_matches(is_space).to_owned();
        let cleaned = drop_debris(&plain);
        if !cleaned.is_empty() {
            found.push(cleaned);
        }
    }
    if found.is_empty() {
        let flat = drop_debris(decode_entities(&collapse_spaces(&strip_tags(story, " "))).trim_matches(is_space));
        if !flat.is_empty() {
            found.push(flat);
        }
    }
    let joined = found.join("\n\n");
    if utf16_len(&joined) <= BODY_CHAR_CAP {
        return joined;
    }
    let mut clipped = String::new();
    let mut units = 0;
    for c in joined.chars() {
        units += c.len_utf16();
        if units > BODY_CHAR_CAP {
            break;
        }
        clipped.push(c);
    }
    let last_space = clipped.rfind(' ').map(|at| utf16_len(&clipped[..at]));
    let end = match last_space {
        Some(at) if at as f64 > BODY_CHAR_CAP as f64 * 0.6 => clipped[..clipped.rfind(' ').unwrap_or(0)].to_owned(),
        _ => clipped,
    };
    format!("{}\u{2026}", end.trim_end())
}

/// What a body read found. A failed read is not remembered, so the next overview tries again.
pub struct Body {
    pub text: String,
    /// True when ESPN could not be read, so the page is marked as partly out of date.
    pub failed: bool,
}

/// The sanitised body of one article, from the shared copy when it is under six hours old.
pub fn body<H: Host + ?Sized>(host: &H, article_id: &str) -> Result<Body> {
    if !is_article_id(article_id) {
        return Ok(Body { text: String::new(), failed: false });
    }
    let now = cache::now_ms(host)?;
    let mut store = Store::load(host, cache::ARTICLE_BODY)?;
    if let Some(Value::String(hit)) = store.get(article_id, now) {
        return Ok(Body { text: hit.clone(), failed: false });
    }
    let Ok(data) = espn::fetch_json(host, &format!("{CONTENT_BASE}/{article_id}")) else {
        return Ok(Body { text: String::new(), failed: true });
    };
    let text = sanitize(data["headlines"][0]["story"].as_str());
    store.put(article_id, Value::String(text.clone()), SIX_HOURS_MS, now);
    store.save(host);
    Ok(Body { text, failed: false })
}
