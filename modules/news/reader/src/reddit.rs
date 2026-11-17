//! Subreddit reading. A subreddit is read through its public Atom feed,
//! `https://www.reddit.com/r/{name}/hot.rss`, and every entry whose "[link]" anchor points out to
//! a publisher becomes a headline for that article. No keys, no sign-in, no page scraping.
//!
//! This module never fetches. `read_subreddit` takes the fetching function as an argument, and
//! `RedditFetchOptions` says exactly what that call may do. Publisher credit rules stay with the
//! caller through `RedditReaderOptions::publisher_domain`.

use serde::Serialize;

use crate::feed::is_public_feed_document;
use crate::sanitize::{is_js_space, parse_instant, sanitize_feed_text};
use crate::url::Url;
use chrono::SecondsFormat;

pub const REDDIT_CANONICAL_DOMAIN: &str = "reddit.com";
pub const REDDIT_FETCH_HOSTS: [&str; 1] = ["www.reddit.com"];
pub const REDDIT_CONTENT_TYPES: [&str; 4] = [
    "application/atom+xml",
    "application/rss+xml",
    "application/xml",
    "text/xml",
];
pub const REDDIT_ACCEPT: &str =
    "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8";
/// Reddit throttles generic agents, so the call names Moss.
pub const REDDIT_USER_AGENT: &str = "Moss/1.0 (self-hosted personal dashboard)";
pub const REDDIT_MAX_RESPONSE_BYTES: u64 = 1_000_000;
pub const REDDIT_MAX_HEADLINES: usize = 40;
pub const REDDIT_PREVIEW_SAMPLES: usize = 10;
pub const REDDIT_RATE_LIMIT_MESSAGE: &str =
    "Reddit is rate limiting Moss. Headlines resume automatically.";
pub const REDDIT_AUTH_REQUIRED_MESSAGE: &str = "This subreddit is private or restricted.";

const REDDIT_INTERNAL_HOSTS: [&str; 5] =
    ["reddit.com", "redd.it", "i.redd.it", "v.redd.it", "preview.redd.it"];

/// Everything the host needs to run one feed call safely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedditFetchOptions {
    pub allowed_hosts: &'static [&'static str],
    pub accept: &'static str,
    pub user_agent: &'static str,
    pub allowed_content_types: &'static [&'static str],
    pub max_bytes: u64,
    pub reject_oversized_responses: bool,
    /// Reddit's robots rules refuse generic agents, so the host skips that gate for this call.
    pub skip_robots: bool,
    pub timeout_ms: Option<u64>,
    expected_path: String,
}

impl RedditFetchOptions {
    /// True only for the exact requested path on the allowed host with no redirect and no port.
    pub fn hop_allowed(&self, hop: &RedditHop) -> bool {
        hop.redirect_count == 0
            && hop.url.port.is_none()
            && REDDIT_FETCH_HOSTS.contains(&hop.url.hostname.to_lowercase().as_str())
            && hop.url.pathname == self.expected_path
    }
}

#[derive(Debug, Clone)]
pub struct RedditHop {
    pub url: Url,
    pub redirect_count: u32,
}

pub fn reddit_fetch_options(url: &str, timeout_ms: Option<u64>) -> RedditFetchOptions {
    RedditFetchOptions {
        allowed_hosts: &REDDIT_FETCH_HOSTS,
        accept: REDDIT_ACCEPT,
        user_agent: REDDIT_USER_AGENT,
        allowed_content_types: &REDDIT_CONTENT_TYPES,
        max_bytes: REDDIT_MAX_RESPONSE_BYTES,
        reject_oversized_responses: true,
        skip_robots: true,
        timeout_ms,
        expected_path: Url::parse(url).map(|u| u.pathname).unwrap_or_default(),
    }
}

/// A hop check bound to one expected address.
pub fn reddit_hop_guard(expected_url: &str) -> impl Fn(&RedditHop) -> bool {
    let options = reddit_fetch_options(expected_url, None);
    move |hop| options.hop_allowed(hop)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedditFetched {
    pub status: u16,
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedditFetchFailure {
    pub reason: String,
    pub status: Option<u16>,
    pub detail: Option<String>,
}

pub type RedditFetchResult = Result<RedditFetched, RedditFetchFailure>;

#[derive(Default)]
pub struct RedditReaderOptions<'a> {
    /// Maps a linked article's host to the publisher domain it is credited to. The default
    /// strips a leading `www.`.
    pub publisher_domain: Option<&'a dyn Fn(&str) -> Option<String>>,
    pub limit: Option<usize>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubredditInput {
    Subreddit { name: String },
    Invalid,
}

fn is_subreddit_name(name: &str) -> bool {
    (3..=21).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &text[prefix.len()..])
}

fn short_form(text: &str) -> Option<&str> {
    let rest = text.strip_prefix('/').unwrap_or(text);
    let rest = strip_prefix_ci(rest, "r/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() || rest.contains(|c: char| c == '/' || is_js_space(c) || c == '?' || c == '#') {
        return None;
    }
    Some(rest)
}

fn url_form(text: &str) -> Option<&str> {
    let mut rest = text;
    if let Some(r) = strip_prefix_ci(rest, "https://").or_else(|| strip_prefix_ci(rest, "http://")) {
        rest = r;
    }
    if let Some(r) = strip_prefix_ci(rest, "www.").or_else(|| strip_prefix_ci(rest, "old.")) {
        rest = r;
    }
    let rest = strip_prefix_ci(rest, "reddit.com/r/")?;
    let name_end = rest
        .find(|c: char| c == '/' || is_js_space(c) || c == '?' || c == '#' || c == '.')
        .unwrap_or(rest.len());
    let (name, mut tail) = rest.split_at(name_end);
    if name.is_empty() {
        return None;
    }
    let after_rss = strip_prefix_ci(tail, ".rss");
    let ok_tail = |t: &str| {
        t.is_empty()
            || (t.starts_with(['/', '?', '#']) && !t.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
    };
    if let Some(t) = after_rss {
        if ok_tail(t) {
            tail = t;
        }
    }
    ok_tail(tail).then_some(name)
}

/// `r/Name`, `/r/Name` and `https://(www.|old.)reddit.com/r/Name[.rss][/...]`. A Reddit-shaped
/// input whose name breaks Reddit's rules is `Invalid`; anything else is `None`.
pub fn parse_subreddit_input(raw: &str) -> Option<SubredditInput> {
    let trimmed = raw.trim_matches(is_js_space);
    let name = short_form(trimmed).or_else(|| url_form(trimmed))?;
    Some(if is_subreddit_name(name) {
        SubredditInput::Subreddit { name: name.to_string() }
    } else {
        SubredditInput::Invalid
    })
}

pub fn reddit_subreddit_url(name: &str) -> String {
    format!("https://www.reddit.com/r/{name}/")
}

/// Reddit's "hot" order. The newest-first feed would be `/new.rss`.
pub fn reddit_hot_feed_url(name: &str) -> String {
    format!("https://www.reddit.com/r/{name}/hot.rss")
}

pub fn subreddit_name_from_url(url: Option<&str>) -> Option<String> {
    match parse_subreddit_input(url?)? {
        SubredditInput::Subreddit { name } => Some(name),
        SubredditInput::Invalid => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedditLinkedHeadline {
    pub id: String,
    pub title: String,
    pub url: String,
    pub published_at: Option<String>,
    pub publisher_label: String,
    pub publisher_domain: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedditSubredditInfo {
    /// Reddit's own casing of the name, from the feed's category term.
    pub display_name: String,
    pub title: String,
    pub description: String,
    /// Always `None`. The Atom feed only carries Reddit's generic icon.
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedditFeed {
    pub subreddit: RedditSubredditInfo,
    pub headlines: Vec<RedditLinkedHeadline>,
}

// ---- text scanning (case-insensitive, over the raw feed text) ----------------------------------

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Entities in the old reader's order. `&amp;` goes last so escaped escapes decode once.
fn decode_reddit_entities(value: &str) -> String {
    let numeric = |text: &str, hex: bool| -> String {
        let prefix = if hex { "&#x" } else { "&#" };
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = match (rest.find(prefix), hex.then(|| rest.find("&#X")).flatten()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        } {
            out.push_str(&rest[..at]);
            let after = &rest[at + prefix.len()..];
            let len = after
                .find(|c: char| if hex { !c.is_ascii_hexdigit() } else { !c.is_ascii_digit() })
                .unwrap_or(after.len());
            if len > 0 && after[len..].starts_with(';') {
                let value = u32::from_str_radix(after[..len].trim_start_matches('0'), if hex { 16 } else { 10 })
                    .ok()
                    .or(after[..len].chars().all(|c| c == '0').then_some(0));
                match value.and_then(char::from_u32) {
                    Some(c) => out.push(c),
                    None => out.push_str(&rest[at..at + prefix.len() + len + 1]),
                }
                rest = &after[len + 1..];
            } else {
                out.push_str(prefix);
                rest = after;
            }
        }
        out.push_str(rest);
        out
    };
    let step = numeric(&numeric(value, false), true);
    step.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Text of the first `<tag ...>..</tag>`: CDATA unwrapped, entities decoded.
fn element_text(xml: &str, tag: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut from = 0;
    while let Some(found) = lower[from..].find(&open) {
        let start = from + found;
        let after = start + open.len();
        let gt = match lower[after..].chars().next() {
            Some('>') => Some(after),
            Some(c) if is_js_space(c) => lower[after..].find('>').map(|p| p + after),
            _ => None,
        };
        if let Some(gt) = gt {
            let inner_start = gt + 1;
            let end = lower[inner_start..].find(&close)? + inner_start;
            let inner = &xml[inner_start..end];
            let trimmed = inner.trim_matches(is_js_space);
            let content = match trimmed.strip_prefix("<![CDATA[").and_then(|t| t.strip_suffix("]]>")) {
                Some(cdata) => cdata,
                None => inner,
            };
            return Some(decode_reddit_entities(content));
        }
        from = after;
    }
    None
}

/// Value of `name="..."` inside the first `<tag ...>` that has it (the last copy within one tag).
fn attribute(xml: &str, tag: &str, name: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let open = format!("<{tag}");
    let needle = format!("{name}=\"");
    let mut from = 0;
    while let Some(found) = lower[from..].find(&open) {
        let start = from + found;
        let after = start + open.len();
        from = after;
        if lower[after..].chars().next().is_some_and(is_word) {
            continue;
        }
        let tag_end = lower[after..].find('>').map_or(lower.len(), |p| p + after);
        let region = &lower[after..tag_end];
        let mut hit = None;
        for (at, _) in region.match_indices(&needle) {
            if at > 0 && region[..at].chars().next_back().is_some_and(is_js_space) {
                hit = Some(at);
            }
        }
        if let Some(at) = hit {
            let value_start = after + at + needle.len();
            let value_end = xml[value_start..].find('"')? + value_start;
            return Some(decode_reddit_entities(&xml[value_start..value_end]));
        }
    }
    None
}

/// The href of the anchor whose text is "[link]" inside the entry's HTML content.
pub fn reddit_outbound_link(content_html: &str) -> Option<String> {
    let lower = content_html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<a") {
        let start = from + found;
        let after = start + 2;
        from = after;
        let Some(first) = lower[after..].chars().next() else { break };
        if !is_js_space(first) {
            continue;
        }
        let search_from = after + first.len_utf8();
        let tag_gt = lower[search_from..].find('>').map(|p| p + search_from);
        let prefix_end = tag_gt.unwrap_or(lower.len());
        let mut candidates: Vec<usize> = lower[search_from..prefix_end]
            .match_indices("href=\"")
            .map(|(p, _)| p + search_from)
            .collect();
        candidates.reverse();
        for at in candidates {
            let value_start = at + 6;
            let Some(quote) = lower[value_start..].find('"') else { continue };
            if quote == 0 {
                continue;
            }
            let value_end = value_start + quote;
            let Some(gt) = lower[value_end + 1..].find('>').map(|p| p + value_end + 1) else {
                continue;
            };
            let tail = lower[gt + 1..].trim_start_matches(is_js_space);
            let Some(tail) = tail.strip_prefix("[link]") else { continue };
            let tail = tail.trim_start_matches(is_js_space);
            if tail.starts_with("</a>") {
                return Some(decode_reddit_entities(&content_html[value_start..value_end]));
            }
        }
    }
    None
}

fn publisher_from_link(url: &Url, options: &RedditReaderOptions<'_>) -> Option<(String, String)> {
    let hostname = url.hostname.to_lowercase();
    let hostname = hostname.strip_suffix('.').unwrap_or(&hostname).to_string();
    if hostname.is_empty() || REDDIT_INTERNAL_HOSTS.contains(&hostname.as_str()) {
        return None;
    }
    let mapped = match options.publisher_domain {
        Some(f) => f(&hostname).unwrap_or_else(|| hostname.clone()),
        None => hostname.strip_prefix("www.").unwrap_or(&hostname).to_string(),
    };
    if REDDIT_INTERNAL_HOSTS.contains(&mapped.as_str()) {
        return None;
    }
    let domain = mapped.strip_prefix("www.").unwrap_or(&mapped).to_string();
    Some((domain.clone(), domain))
}

/// An Atom entry is a headline only when its "[link]" anchor points out to a publisher rather than
/// back into Reddit or its media hosts. Self posts, images, videos and galleries all link to
/// Reddit, so the one host rule covers the whole skip list.
pub fn reddit_entry_to_headline(
    entry_xml: &str,
    options: &RedditReaderOptions<'_>,
) -> Option<RedditLinkedHeadline> {
    let content = element_text(entry_xml, "content")
        .or_else(|| element_text(entry_xml, "summary"))
        .unwrap_or_default();
    let raw_link = reddit_outbound_link(&content).filter(|l| !l.is_empty())?;
    let raw_title = element_text(entry_xml, "title").filter(|t| !t.is_empty())?;
    let url = Url::parse(&raw_link)?;
    if !url.username.is_empty() || !url.password.is_empty() {
        return None;
    }
    let (label, domain) = publisher_from_link(&url, options)?;
    let title = sanitize_feed_text(Some(&raw_title), 500);
    if title.is_empty() {
        return None;
    }
    let stamp = element_text(entry_xml, "published").or_else(|| element_text(entry_xml, "updated"));
    let published_at = stamp
        .filter(|s| !s.is_empty())
        .and_then(|s| parse_instant(s.trim_matches(is_js_space)))
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true));
    let id = element_text(entry_xml, "id")
        .map(|i| i.trim_matches(is_js_space).to_string())
        .filter(|i| !i.is_empty())
        .unwrap_or_else(|| url.href.clone());
    Some(RedditLinkedHeadline {
        id,
        title,
        url: url.href,
        published_at,
        publisher_label: label,
        publisher_domain: domain,
    })
}

fn find_feed_tag(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<feed") {
        let after = from + found + 5;
        if !lower[after..].chars().next().is_some_and(is_word) {
            return true;
        }
        from = after;
    }
    false
}

/// `(index of the opener, entry text)` for each `<entry ...>..</entry>`, in order.
fn entries(body: &str) -> Vec<(usize, &str)> {
    let lower = body.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<entry") {
        let start = from + found;
        let after = start + 6;
        if lower[after..].chars().next().is_some_and(is_word) {
            from = after;
            continue;
        }
        let Some(gt) = lower[after..].find('>').map(|p| p + after) else { break };
        let Some(end) = lower[gt + 1..].find("</entry>").map(|p| p + gt + 1) else { break };
        out.push((start, &body[gt + 1..end]));
        from = end + "</entry>".len();
    }
    out
}

/// The feed body to the subreddit's identity plus at most `limit` linked-article headlines, in feed
/// order. `None` means the body is not an Atom feed (a block page, an RSS channel from elsewhere).
pub fn parse_reddit_feed(
    body: &str,
    fallback_name: &str,
    options: &RedditReaderOptions<'_>,
) -> Option<RedditFeed> {
    if !is_public_feed_document(body) || !find_feed_tag(body) {
        return None;
    }
    let limit = options.limit.unwrap_or(REDDIT_MAX_HEADLINES);
    let found = entries(body);
    let head = match found.first() {
        Some((index, _)) => &body[..*index],
        None => body,
    };
    let display_name = attribute(head, "category", "term")
        .filter(|t| is_subreddit_name(t))
        .unwrap_or_else(|| fallback_name.to_string());
    let subreddit = RedditSubredditInfo {
        display_name,
        title: sanitize_feed_text(element_text(head, "title").as_deref(), 120),
        description: sanitize_feed_text(element_text(head, "subtitle").as_deref(), 300),
        icon_url: None,
    };
    let mut headlines: Vec<RedditLinkedHeadline> = Vec::new();
    for (_, entry) in found {
        let Some(headline) = reddit_entry_to_headline(entry, options) else { continue };
        if headlines.iter().any(|h| h.url == headline.url) {
            continue;
        }
        headlines.push(headline);
        if headlines.len() >= limit {
            break;
        }
    }
    Some(RedditFeed { subreddit, headlines })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RedditFailureReason {
    NotFound,
    AuthRequired,
    RateLimited,
    Unreachable,
}

/// Reddit answers 404 for a banned or missing subreddit, 403 for a private one (and for a network
/// block), and 429 when throttling. A refused redirect (unknown names go to search) is "not found".
pub fn reddit_failure_reason(failure: &RedditFetchFailure) -> RedditFailureReason {
    if failure.status == Some(404) {
        return RedditFailureReason::NotFound;
    }
    if failure.reason == "blocked" {
        return if failure.detail.as_deref() == Some("unsupported_content_type") {
            RedditFailureReason::Unreachable
        } else {
            RedditFailureReason::NotFound
        };
    }
    if matches!(failure.status, Some(401) | Some(403)) {
        return RedditFailureReason::AuthRequired;
    }
    if failure.status == Some(429) || failure.reason == "rate_limited" {
        return RedditFailureReason::RateLimited;
    }
    RedditFailureReason::Unreachable
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadSubredditResult {
    Ok {
        subreddit: RedditSubredditInfo,
        headlines: Vec<RedditLinkedHeadline>,
        /// The hot feed address in Reddit's own casing of the name.
        feed_url: String,
    },
    Failed(RedditFailureReason),
}

/// One feed call carries identity and headlines. `fetch` runs it, with the options it must obey.
pub fn read_subreddit(
    fetch: impl FnOnce(&str, &RedditFetchOptions) -> RedditFetchResult,
    name: &str,
    options: &RedditReaderOptions<'_>,
) -> ReadSubredditResult {
    let request_url = reddit_hot_feed_url(name);
    let fetch_options = reddit_fetch_options(&request_url, options.timeout_ms);
    let response = match fetch(&request_url, &fetch_options) {
        Ok(response) => response,
        Err(failure) => return ReadSubredditResult::Failed(reddit_failure_reason(&failure)),
    };
    match parse_reddit_feed(&response.body, name, options) {
        None => ReadSubredditResult::Failed(RedditFailureReason::NotFound),
        Some(feed) => ReadSubredditResult::Ok {
            feed_url: reddit_hot_feed_url(&feed.subreddit.display_name),
            subreddit: feed.subreddit,
            headlines: feed.headlines,
        },
    }
}
