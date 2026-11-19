//! Feed finder: reads a publisher's home page for its feed links, headline links, title,
//! description and canonical address. Pure text in, values out.

use crate::feed::parse_feed_xml;
use crate::publisher::same_publisher;
use crate::sanitize::{
    sanitize_feed_text, sanitize_item_url, sanitize_published_at, TITLE_CHAR_CAP,
};
use crate::url::Url;
use scraper::{Html, Node};

/// A headline taken from a page link or a feed item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SampleHeadline {
    pub headline: String,
    pub url: String,
    pub published_at: Option<String>,
}

/// What a page says about itself.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HtmlMetadata {
    pub title: String,
    pub description: String,
    pub canonical_url: Option<String>,
}

fn has_scheme(raw: &str) -> bool {
    let mut chars = raw.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// `new URL(raw, base)` for http and https. Anything else answers `None`.
pub fn resolve_url(raw: &str, base: &Url) -> Option<Url> {
    let raw: String = raw
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let scheme = if base.https { "https" } else { "http" };
    let origin = || {
        let port = base.port.map(|p| format!(":{p}")).unwrap_or_default();
        format!("{scheme}://{}{port}", base.hostname)
    };
    let absolute = if has_scheme(&raw) {
        raw
    } else if let Some(rest) = raw.strip_prefix("//") {
        format!("{scheme}://{rest}")
    } else if raw.starts_with('/') {
        format!("{}{raw}", origin())
    } else if raw.starts_with('?') {
        format!("{}{}{raw}", origin(), base.pathname)
    } else if raw.starts_with('#') {
        format!("{}{}{}{raw}", origin(), base.pathname, base.search)
    } else if raw.is_empty() {
        format!("{}{}{}", origin(), base.pathname, base.search)
    } else {
        let dir = match base.pathname.rfind('/') {
            Some(at) => &base.pathname[..=at],
            None => "/",
        };
        format!("{}{dir}{raw}", origin())
    };
    Url::parse(&absolute)
}

/// The address as an https address on the same publisher as `base`, or `None`.
fn publisher_https(raw: &str, base: &Url) -> Option<String> {
    let url = resolve_url(raw, base)?;
    (url.https && same_publisher(&url.hostname, &base.hostname)).then_some(url.href)
}

/// Up to three feed links the page names, on the same publisher and over https.
pub fn discover_feed_urls(html: &str, base_url: &str) -> Vec<String> {
    let Some(base) = Url::parse(base_url) else { return Vec::new() };
    let document = Html::parse_document(html);
    let mut urls: Vec<String> = Vec::new();
    for node in document.tree.nodes() {
        let Node::Element(element) = node.value() else { continue };
        if element.name() != "link" || urls.len() >= 3 {
            continue;
        }
        let rel = element.attr("rel").unwrap_or("").to_lowercase();
        let kind = element.attr("type").unwrap_or("").to_lowercase();
        let is_alternate = rel.split_whitespace().any(|part| part == "alternate");
        if !is_alternate || !matches!(kind.as_str(), "application/rss+xml" | "application/atom+xml") {
            continue;
        }
        if let Some(found) = publisher_https(element.attr("href").unwrap_or(""), &base) {
            if !urls.contains(&found) {
                urls.push(found);
            }
        }
    }
    urls
}

/// Page links with a long enough text to be a headline, on the same publisher.
pub fn extract_listing_headlines(html: &str, base_url: &str, cap: usize) -> Vec<SampleHeadline> {
    let Some(base) = Url::parse(base_url) else { return Vec::new() };
    let document = Html::parse_document(html);
    let mut results: Vec<SampleHeadline> = Vec::new();
    for node in document.tree.nodes() {
        let Node::Element(element) = node.value() else { continue };
        if element.name() != "a" {
            continue;
        }
        if results.len() >= cap {
            break;
        }
        let text: String = scraper::ElementRef::wrap(node)
            .map(|e| e.text().collect())
            .unwrap_or_default();
        let headline = sanitize_feed_text(Some(&text), TITLE_CHAR_CAP);
        let Some(url) = publisher_https(element.attr("href").unwrap_or(""), &base) else { continue };
        if headline.encode_utf16().count() >= 20 && !results.iter().any(|r| r.url == url) {
            results.push(SampleHeadline { headline, url, published_at: None });
        }
    }
    results.truncate(cap);
    results
}

/// The first usable items of a feed, with https links only.
pub fn sample_feed_headlines(feed_xml: &str, cap: usize) -> Vec<SampleHeadline> {
    let mut results = Vec::new();
    for item in parse_feed_xml(feed_xml) {
        if results.len() >= cap {
            break;
        }
        let headline = sanitize_feed_text(Some(&item.title), TITLE_CHAR_CAP);
        let Some(url) = sanitize_item_url(Some(&item.link)) else { continue };
        if headline.is_empty() || !url.starts_with("https://") {
            continue;
        }
        results.push(SampleHeadline {
            headline,
            url,
            published_at: sanitize_published_at(Some(&item.published_at)),
        });
    }
    results
}

/// Title, description and canonical address, read in page order. A later value wins.
pub fn html_metadata(html: &str) -> HtmlMetadata {
    let document = Html::parse_document(html);
    let mut title = String::new();
    let mut title_done = false;
    let mut description = String::new();
    let mut canonical: Option<String> = None;
    for node in document.tree.nodes() {
        let Node::Element(element) = node.value() else { continue };
        match element.name() {
            "title" if !title_done => {
                title = scraper::ElementRef::wrap(node)
                    .map(|e| e.text().collect())
                    .unwrap_or_default();
                title_done = true;
            }
            "link" if element.attr("rel").unwrap_or("").to_lowercase() == "canonical" => {
                canonical = element.attr("href").map(str::to_owned);
            }
            "meta" => {
                let key = element
                    .attr("property")
                    .or_else(|| element.attr("name"))
                    .unwrap_or("")
                    .to_lowercase();
                if key == "og:url" {
                    if let Some(content) = element.attr("content") {
                        canonical = Some(content.to_owned());
                    }
                }
                if key == "description" || key == "og:description" {
                    if let Some(content) = element.attr("content") {
                        description = content.to_owned();
                    }
                }
            }
            _ => {}
        }
    }
    HtmlMetadata {
        title: sanitize_feed_text(Some(&title), TITLE_CHAR_CAP),
        description: sanitize_feed_text(Some(&description), 300),
        canonical_url: canonical,
    }
}
