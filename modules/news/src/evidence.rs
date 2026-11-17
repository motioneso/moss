//! Top stories as briefing evidence and as heartbeat items. Both read the stored page and
//! never fetch a feed. The shape and limits match the old briefing tool.
use crate::compile::{stored_page, Freshness};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

pub const STORIES_MAX: usize = 5;
const SUMMARY_MAX: usize = 240;
const HEARTBEAT_ITEMS_MAX: i64 = 20;
const HEARTBEAT_HOURS_MAX: i64 = 48;

/// Cuts to a count of UTF-16 units, the unit the old limits used, without splitting a character.
fn cut(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

fn web_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["https://", "http://"].iter().any(|scheme| lower.strip_prefix(scheme).is_some_and(|rest| !rest.is_empty()))
}

/// One story as evidence, or `None` when it has no title or no http(s) link.
fn story(headline: &Value) -> Option<Value> {
    let (title, url) = (text(headline, "title"), text(headline, "url"));
    if title.is_empty() || !web_link(url) {
        return None;
    }
    Some(json!({
        "id": cut(text(headline, "id"), 300),
        "title": cut(title, 300),
        "sourceLabel": cut(text(headline, "sourceLabel"), 200),
        "sourceKey": cut(text(headline, "sourceKey"), 200),
        "url": cut(url, 2000),
        "publishedAt": text(headline, "publishedAt"),
        "summary": cut(&text(headline, "summary").split_whitespace().collect::<Vec<_>>().join(" "), SUMMARY_MAX),
        "imageUrl": headline["imageUrl"].as_str().map(|u| json!(cut(u, 2000))).unwrap_or(Value::Null),
    }))
}

fn top(page: &Value) -> Vec<&Value> {
    page["topStories"].as_array().map(|rows| rows.iter().take(STORIES_MAX).collect()).unwrap_or_default()
}

/// `news.topHeadlinesToday` and the `newsTopHeadlinesToday` API: short "Title - Source" lines
/// plus the evidence each one came from.
pub fn top_headlines<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let (page, _) = stored_page(host)?;
    let now = crate::util::now(host)?.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let shown = top(&page);
    let facts: Vec<String> = shown.iter().map(|h| format!("{} \u{2014} {}", text(h, "title"), text(h, "sourceLabel"))).collect();
    let stories: Vec<Value> = shown.iter().filter_map(|h| story(h)).collect();
    Ok(json!({
        "facts": facts,
        "evidence": {"version": 1, "capturedAt": now, "degraded": page["degraded"], "stories": stories},
    }))
}

/// A cheap fingerprint of the story list that does not depend on the time. 32-bit FNV-1a over
/// UTF-16 units, so it matches what the old heartbeat produced.
fn revision(parts: &[String]) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for part in parts {
        for unit in part.encode_utf16() {
            hash ^= u32::from(unit);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        hash ^= 0x1f;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{}-{:08x}", parts.len(), hash)
}

/// The read contract: only `horizonHours` (1 to 48) and `limit` (1 to 20), whole numbers.
/// Anything else, including an owner or user id, is refused.
pub fn heartbeat_limit(input: &Value) -> Option<usize> {
    let map = input.as_object()?;
    if map.keys().any(|key| key != "horizonHours" && key != "limit") {
        return None;
    }
    let whole = |key: &str, default: i64, max: i64| -> Option<i64> {
        let Some(value) = map.get(key) else { return Some(default) };
        let number = value.as_i64().or_else(|| value.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))?;
        (1..=max).contains(&number).then_some(number)
    };
    whole("horizonHours", 24, HEARTBEAT_HOURS_MAX)?;
    whole("limit", HEARTBEAT_ITEMS_MAX, HEARTBEAT_ITEMS_MAX).map(|n| n as usize)
}

/// `news.heartbeatHeadlines`. Reads the stored page only. Nothing stored reads as unknown, and
/// an expired or invalid page gives no stories and reads as stale.
pub fn heartbeat<H: Host + ?Sized>(host: &H, limit: usize) -> Result<Value> {
    let (page, freshness) = stored_page(host)?;
    let stories: Vec<Value> = match freshness {
        Freshness::Fresh => top(&page).into_iter().filter_map(story).collect(),
        _ => Vec::new(),
    };
    let label = match freshness {
        Freshness::Fresh => "fresh",
        Freshness::Stale => "stale",
        Freshness::Unknown => "unknown",
    };
    let parts: Vec<String> = stories.iter().map(|s| format!("{}|{}", text(s, "id"), text(s, "title"))).collect();
    let items: Vec<Value> = stories
        .iter()
        .take(limit)
        .map(|s| {
            let key = format!("story:{}", text(s, "id"));
            json!({
                "entityKey": key, "episodeKey": key, "title": s["title"], "at": s["publishedAt"], "kind": "headline",
                "facts": {"source": s["sourceLabel"], "summary": s["summary"]},
            })
        })
        .collect();
    Ok(json!({
        "source": "news", "revision": revision(&parts), "nextBoundaryAt": null, "freshness": label,
        "truncated": stories.len() > limit.min(HEARTBEAT_ITEMS_MAX as usize), "items": items,
    }))
}
