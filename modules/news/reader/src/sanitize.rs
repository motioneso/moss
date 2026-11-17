//! Plain-text cleaning for feed text, addresses and dates.
//!
//! After `sanitize_feed_text` runs, no angle bracket is left, so a screen that shows the string
//! as text cannot emit publisher-controlled markup.

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};

use crate::url::Url;

pub const TITLE_CHAR_CAP: usize = 300;
pub const SUMMARY_CHAR_CAP: usize = 500;

/// JavaScript's `\s` set, which differs from `char::is_whitespace`.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// A code point from digits, or the source text when the number is not a valid scalar value.
fn code_point_or(n: Option<u32>, original: &str) -> String {
    match n.and_then(char::from_u32) {
        Some(c) => c.to_string(),
        None => original.to_string(),
    }
}

/// Replaces every `&#<digits>;` (or `&#x<hex>;`) with its character, left to right.
fn replace_numeric(text: &str, hex_form: bool) -> String {
    let prefix = if hex_form { "&#x" } else { "&#" };
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(prefix) {
        out.push_str(&rest[..at]);
        let after = &rest[at + prefix.len()..];
        let digits_len = after
            .find(|c: char| {
                if hex_form {
                    !c.is_ascii_hexdigit()
                } else {
                    !c.is_ascii_digit()
                }
            })
            .unwrap_or(after.len());
        if digits_len > 0 && after[digits_len..].starts_with(';') {
            let digits = &after[..digits_len];
            let radix = if hex_form { 16 } else { 10 };
            let value = u32::from_str_radix(digits.trim_start_matches('0'), radix)
                .ok()
                .or(if digits.chars().all(|c| c == '0') { Some(0) } else { None });
            let whole = &rest[at..at + prefix.len() + digits_len + 1];
            out.push_str(&code_point_or(value, whole));
            rest = &after[digits_len + 1..];
        } else {
            out.push_str(prefix);
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// Replaces `&#39;`, `&#039;` and any number of leading zeros before 39.
fn replace_apostrophe_numeric(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("&#") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let zeros = after.len() - after.trim_start_matches('0').len();
        let tail = &after[zeros..];
        if tail.starts_with("39;") {
            out.push('\u{2019}');
            rest = &tail[3..];
        } else {
            out.push_str("&#");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// The small set of HTML entities news feeds emit, in the old code's exact order.
pub fn decode_entities(text: &str) -> String {
    let mut s = text.replace("&amp;", "&");
    s = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"");
    s = replace_apostrophe_numeric(&s);
    s = s.replace("&apos;", "\u{2019}").replace("&rsquo;", "\u{2019}");
    s = s
        .replace("&lsquo;", "\u{2018}")
        .replace("&ldquo;", "\u{201c}")
        .replace("&rdquo;", "\u{201d}")
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&hellip;", "\u{2026}")
        .replace("&nbsp;", " ");
    s = replace_numeric(&s, false);
    replace_numeric(&s, true)
}

/// Removes `<...>` runs the way the old pattern `<[^>]+>` did (at least one inner character).
fn strip_tags_strict(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some(close) = text[i + 1..].find('>') {
                if close > 0 {
                    out.push_str(&text[copied..i]);
                    out.push(' ');
                    i = i + 1 + close + 1;
                    copied = i;
                    continue;
                }
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// Removes `<` through the next `>` (or the end of text), the old pattern `<[^>]*>?`.
fn strip_tags_loose(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        out.push(' ');
        match rest[at + 1..].find('>') {
            Some(close) => rest = &rest[at + 1 + close + 1..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            in_space = true;
        } else {
            if in_space {
                out.push(' ');
                in_space = false;
            }
            out.push(c);
        }
    }
    if in_space {
        out.push(' ');
    }
    out.trim_matches(is_js_space).to_string()
}

/// Feed text to capped plain text. `cap` counts UTF-16 units, as the old code did.
pub fn sanitize_feed_text(raw: Option<&str>, cap: usize) -> String {
    let Some(raw) = raw else { return String::new() };
    if raw.is_empty() {
        return String::new();
    }
    let decoded = decode_entities(&strip_tags_strict(raw));
    let loose = strip_tags_loose(&decoded);
    let no_brackets: String = loose.chars().filter(|c| *c != '<' && *c != '>').collect();
    let plain = collapse_spaces(&no_brackets);
    if utf16_len(&plain) <= cap {
        return plain;
    }
    let mut clipped = String::new();
    let mut used = 0;
    for c in plain.chars() {
        if used + c.len_utf16() > cap {
            break;
        }
        used += c.len_utf16();
        clipped.push(c);
    }
    let last_space = clipped.rfind(' ').map(|byte| utf16_len(&clipped[..byte]));
    let kept = match last_space {
        Some(units) if (units as f64) > (cap as f64) * 0.6 => {
            let byte = clipped.rfind(' ').unwrap_or(clipped.len());
            clipped[..byte].to_string()
        }
        _ => clipped,
    };
    format!("{}\u{2026}", kept.trim_end_matches(is_js_space))
}

/// An article link. It must parse as http or https, or the whole item is dropped.
pub fn sanitize_item_url(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    Url::parse(raw.trim_matches(is_js_space)).map(|u| u.href)
}

/// Artwork address. It must be https and its host must be on the allow-list.
pub fn sanitize_image_url(raw: Option<&str>, image_hosts: &[&str]) -> Option<String> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    let url = Url::parse(raw.trim_matches(is_js_space))?;
    if !url.https || !image_hosts.contains(&url.hostname.as_str()) {
        return None;
    }
    Some(url.href)
}

/// An RFC 822, RFC 2822 or ISO 8601 date as an ISO instant with milliseconds, or `None`.
/// A date or time with no zone is read as UTC.
pub fn sanitize_published_at(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim_matches(is_js_space);
    if raw.is_empty() {
        return None;
    }
    parse_instant(raw).map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub(crate) fn parse_instant(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(t) = DateTime::parse_from_rfc3339(raw) {
        return Some(t.with_timezone(&Utc));
    }
    if let Ok(t) = DateTime::parse_from_rfc2822(raw) {
        return Some(t.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(n) = chrono::NaiveDateTime::parse_from_str(raw, format) {
            return Some(n.and_utc());
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).map(|n| n.and_utc());
    }
    for format in ["%a, %d %b %Y %H:%M:%S GMT", "%d %b %Y %H:%M:%S GMT"] {
        if let Ok(n) = chrono::NaiveDateTime::parse_from_str(raw, format) {
            return Some(n.and_utc());
        }
    }
    None
}
