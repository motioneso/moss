//! The first real picture inside a story's HTML body, for feeds that carry no media tag.
//!
//! The fragment is capped, then read with a real HTML parser. Tracking pixels are skipped only on
//! unambiguous evidence: a declared size of 0 or 1, a hiding attribute or style, a counting host
//! label, or the whole word "pixel" or "impression" as a path segment or query key.

use scraper::{Html, Selector};

use crate::sanitize::{is_js_space, sanitize_image_url};
use crate::url::Url;

pub const BODY_IMAGE_SCAN_CHAR_CAP: usize = 20_000;

const TRACKING_HOST_LABELS: &[&str] = &[
    "pixel", "pixels", "px", "beacon", "track", "tracker", "tracking", "analytics", "stats",
    "metrics", "collect", "counter", "imp", "impression", "log", "logs",
];

fn strip_css_comments(style: &str) -> String {
    let mut out = String::with_capacity(style.len());
    let mut rest = style;
    while let Some(start) = rest.find("/*") {
        match rest[start + 2..].find("*/") {
            Some(end) => {
                out.push_str(&rest[..start]);
                rest = &rest[start + 2 + end + 2..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn is_hiding_declaration(declaration: &str) -> bool {
    let lower = declaration.to_ascii_lowercase();
    let Some((property, value)) = lower.split_once(':') else { return false };
    let property = property.trim_matches(is_js_space);
    let mut value = value.trim_matches(is_js_space);
    if let Some(bang) = value.rfind('!') {
        if value[bang + 1..].trim_matches(is_js_space) == "important" {
            value = value[..bang].trim_matches(is_js_space);
        }
    }
    match property {
        "display" => value == "none",
        "visibility" => value == "hidden",
        "width" | "height" => is_zero_or_one(value),
        _ => false,
    }
}

/// `0` or `1`, optionally `.000`, optionally `px`.
fn is_zero_or_one(value: &str) -> bool {
    let without_unit = value.strip_suffix("px").unwrap_or(value);
    let whole = match without_unit.split_once('.') {
        Some((whole, fraction)) => {
            if fraction.is_empty() || !fraction.chars().all(|c| c == '0') {
                return false;
            }
            whole
        }
        None => without_unit,
    };
    whole == "0" || whole == "1"
}

fn has_hiding_style(style: &str) -> bool {
    strip_css_comments(style).split(';').any(is_hiding_declaration)
}

/// A declared whole-pixel size, or `None` for anything that is not a plain number.
fn declared_pixel_size(value: Option<&str>) -> Option<u64> {
    let text = value?.trim_matches(is_js_space).to_ascii_lowercase();
    let text = text.strip_suffix("px").map(|t| t.trim_end_matches(is_js_space)).unwrap_or(&text);
    let (whole, fraction) = match text.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (text, None),
    };
    if whole.is_empty() || !whole.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if let Some(f) = fraction {
        if f.is_empty() || !f.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    whole.parse().ok()
}

fn is_invisible_image(element: &scraper::node::Element) -> bool {
    if element.attr("hidden").is_some() {
        return true;
    }
    if element.attr("style").is_some_and(has_hiding_style) {
        return true;
    }
    let width = declared_pixel_size(element.attr("width"));
    let height = declared_pixel_size(element.attr("height"));
    width.is_some_and(|w| w <= 1) || height.is_some_and(|h| h <= 1)
}

fn is_tracking_word(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    let stem = match lower.split_once('.') {
        Some((stem, ext)) if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) => stem,
        _ => lower.as_str(),
    };
    stem == "pixel" || stem == "impression"
}

/// Resolves a picture address against a placeholder base, as the old code did.
fn resolve_against_placeholder(src: &str) -> Option<Url> {
    if let Some(url) = Url::parse(src) {
        return Some(url);
    }
    let head_end = src.find(['/', '?', '#']).unwrap_or(src.len());
    if src[..head_end].contains(':') {
        return None;
    }
    let joined = if src.starts_with("//") {
        format!("https:{src}")
    } else if src.starts_with('/') {
        format!("https://feed.invalid{src}")
    } else {
        format!("https://feed.invalid/{src}")
    };
    Url::parse(&joined)
}

fn is_tracking_address(src: &str) -> bool {
    let Some(url) = resolve_against_placeholder(src) else { return false };
    let first_label = url.hostname.split('.').next().unwrap_or("");
    if TRACKING_HOST_LABELS.contains(&first_label.to_ascii_lowercase().as_str()) {
        return true;
    }
    if url.pathname.split('/').any(|s| !s.is_empty() && is_tracking_word(s)) {
        return true;
    }
    url.search_param_keys()
        .iter()
        .any(|k| matches!(k.to_ascii_lowercase().as_str(), "pixel" | "impression"))
}

/// First real, non-tracking picture address in an HTML fragment.
pub fn first_real_img_src(html: &str) -> Option<String> {
    if html.is_empty() {
        return None;
    }
    let text: String = if html.encode_utf16().count() > BODY_IMAGE_SCAN_CHAR_CAP {
        let mut used = 0;
        html.chars()
            .take_while(|c| {
                used += c.len_utf16();
                used <= BODY_IMAGE_SCAN_CHAR_CAP
            })
            .collect()
    } else {
        html.to_string()
    };
    let fragment = Html::parse_fragment(&text);
    let selector = Selector::parse("img").ok()?;
    for node in fragment.select(&selector) {
        let element = node.value();
        let src = element.attr("src").unwrap_or("").trim_matches(is_js_space);
        if src.is_empty() || is_invisible_image(element) || is_tracking_address(src) {
            continue;
        }
        return Some(src.to_string());
    }
    None
}

/// The first real body picture (story body, then summary), kept only when its host is allowed.
pub fn feed_body_image_url(content_fallback: &str, summary: &str, image_hosts: &[&str]) -> Option<String> {
    let found = first_real_img_src(content_fallback).or_else(|| first_real_img_src(summary));
    sanitize_image_url(found.as_deref(), image_hosts)
}
