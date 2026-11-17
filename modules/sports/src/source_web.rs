//! Plain public-web reads for added sources: the host fetch call, publisher domain rules, and the
//! small page readers that find a site's feed. Everything here is pure except `get` and
//! `get_reddit`, which make one host fetch call each.
use moss_module_sdk::{Host, Result};
use moss_news_reader::url::Url;
use moss_news_reader::{
    is_public_feed_document, parse_feed_xml, same_publisher, sanitize_feed_text, sanitize_item_url,
    RedditFetchFailure, RedditFetchOptions, RedditFetchResult, RedditFetched,
    RedditHop, TITLE_CHAR_CAP,
};
use scraper::{Html, Selector};
use serde_json::json;

const USER_AGENT: &str = "Moss/1.0 (self-hosted personal dashboard)";
pub const ACCEPT: &str = "text/html, application/xhtml+xml, application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8";
pub const CONTENT_TYPES: [&str; 7] = [
    "text/html",
    "application/xhtml+xml",
    "application/atom+xml",
    "application/rss+xml",
    "application/xml",
    "text/xml",
    "text/plain",
];
const MAX_BYTES: u64 = 1_000_000;
const TIMEOUT_MS: u64 = 10_000;
const MAX_INPUT_LENGTH: usize = 2048;
const MAX_HOSTNAME_LENGTH: usize = 253;
const HEAD_FALLBACK_CHARS: usize = 30_000;
const MAX_FEED_LINKS: usize = 3;

/// One successful page read.
pub struct Fetched {
    pub final_url: String,
    pub body: String,
}

/// Why a page read failed, reduced to what the preview tells the person.
#[derive(Debug, PartialEq)]
pub enum Fail {
    NotHttps,
    Other,
}

/// One GET through the host's public-web mode. `allowed_hosts` narrows redirects to exact hosts.
pub fn get<H: Host + ?Sized>(host: &H, url: &str, allowed_hosts: Option<&[String]>) -> Result<std::result::Result<Fetched, Fail>> {
    get_up_to(host, url, allowed_hosts, MAX_BYTES, true)
}

/// A read that keeps only the first `max_bytes` of the page when `reject_oversized` is false.
pub fn get_up_to<H: Host + ?Sized>(host: &H, url: &str, allowed_hosts: Option<&[String]>, max_bytes: u64, reject_oversized: bool) -> Result<std::result::Result<Fetched, Fail>> {
    let mut parameters = json!({
        "url": url,
        "accept": ACCEPT,
        "maxBytes": max_bytes,
        "timeoutMs": TIMEOUT_MS,
        "userAgent": USER_AGENT,
        "allowedContentTypes": CONTENT_TYPES,
        "rejectOversizedResponses": reject_oversized,
    });
    if let Some(hosts) = allowed_hosts {
        parameters["allowedHosts"] = json!(hosts);
    }
    let answer = host.call("fetch", "get", "public-web", parameters)?;
    if answer["ok"].as_bool() != Some(true) {
        return Ok(Err(if answer["reason"].as_str() == Some("not_https") { Fail::NotHttps } else { Fail::Other }));
    }
    let (Some(final_url), Some(body)) = (answer["finalUrl"].as_str(), answer["body"].as_str()) else {
        return Ok(Err(Fail::Other));
    };
    Ok(Ok(Fetched { final_url: final_url.to_owned(), body: body.to_owned() }))
}

/// The subreddit feed call, with the options the shared reader says it must obey. A redirect or a
/// different final address is refused the way the reader's own hop check refuses it.
pub fn get_reddit<H: Host + ?Sized>(host: &H, url: &str, options: &RedditFetchOptions) -> RedditFetchResult {
    let fail = |reason: &str, status: Option<u16>, detail: Option<&str>| RedditFetchFailure {
        reason: reason.to_owned(),
        status,
        detail: detail.map(str::to_owned),
    };
    let mut parameters = json!({
        "url": url,
        "accept": options.accept,
        "maxBytes": options.max_bytes,
        "userAgent": options.user_agent,
        "allowedContentTypes": options.allowed_content_types,
        "allowedHosts": options.allowed_hosts,
        "rejectOversizedResponses": options.reject_oversized_responses,
        "skipRobots": options.skip_robots,
    });
    if let Some(ms) = options.timeout_ms {
        parameters["timeoutMs"] = json!(ms);
    }
    let answer = host.call("fetch", "get", "public-web", parameters).map_err(|_| fail("network", None, None))?;
    if answer["ok"].as_bool() != Some(true) {
        return Err(RedditFetchFailure {
            reason: answer["reason"].as_str().unwrap_or("network").to_owned(),
            status: answer["status"].as_u64().map(|s| s as u16),
            detail: answer["detail"].as_str().map(str::to_owned),
        });
    }
    let final_url = answer["finalUrl"].as_str().unwrap_or_default();
    let hops = answer["hopCount"].as_u64().unwrap_or(0) as u32;
    let allowed = Url::parse(final_url).is_some_and(|url| options.hop_allowed(&RedditHop { url, redirect_count: hops }));
    if !allowed {
        return Err(fail("blocked", None, None));
    }
    Ok(RedditFetched {
        status: answer["status"].as_u64().unwrap_or(200) as u16,
        final_url: final_url.to_owned(),
        content_type: answer["contentType"].as_str().map(str::to_owned),
        body: answer["body"].as_str().unwrap_or_default().to_owned(),
        truncated: false,
    })
}

/// Why a typed site address cannot be a publisher domain.
#[derive(Debug, PartialEq)]
pub enum DomainRefusal {
    NonHttpsScheme,
    Other,
}

fn has_scheme(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && text.find(':').is_some_and(|at| text[..at].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)))
}

fn is_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

/// A bare host name or HTTPS address to a canonical publisher domain, or the reason it is not one.
pub fn normalize_publisher_domain(input: &str) -> std::result::Result<String, DomainRefusal> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_INPUT_LENGTH {
        return Err(DomainRefusal::Other);
    }
    let candidate = if has_scheme(trimmed) { trimmed.to_owned() } else { format!("https://{trimmed}") };
    let Some(url) = Url::parse(&candidate) else {
        return Err(if has_scheme(trimmed) { DomainRefusal::NonHttpsScheme } else { DomainRefusal::Other });
    };
    if !url.https {
        return Err(DomainRefusal::NonHttpsScheme);
    }
    if !url.username.is_empty() || !url.password.is_empty() || url.port.is_some() {
        return Err(DomainRefusal::Other);
    }
    let host = url.hostname.strip_suffix('.').unwrap_or(&url.hostname).to_owned();
    let dotted_quad = {
        let parts: Vec<&str> = host.split('.').collect();
        parts.len() == 4 && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    };
    if host.starts_with('[') || host.contains(':') || dotted_quad || host.len() > MAX_HOSTNAME_LENGTH {
        return Err(DomainRefusal::Other);
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || !labels.iter().all(|l| is_label(l)) {
        return Err(DomainRefusal::Other);
    }
    Ok(host)
}

/// `new URL(raw, base)` for the cases a page link takes.
pub fn resolve(raw: &str, base: &Url) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if has_scheme(raw) {
        return Url::parse(raw);
    }
    let origin = format!("{}//{}{}", base.protocol(), base.hostname, base.port.map(|p| format!(":{p}")).unwrap_or_default());
    let joined = if let Some(rest) = raw.strip_prefix("//") {
        format!("{}//{rest}", base.protocol())
    } else if raw.starts_with('/') {
        format!("{origin}{raw}")
    } else if raw.starts_with('?') {
        format!("{origin}{}{raw}", base.pathname)
    } else if raw.starts_with('#') {
        format!("{origin}{}{}{raw}", base.pathname, base.search)
    } else {
        let dir = base.pathname.rsplit_once('/').map(|(head, _)| head).unwrap_or("");
        format!("{origin}{dir}/{raw}")
    };
    Url::parse(&joined)
}

/// The final address, only when it stays on the publisher the person asked for.
pub fn accepted_final_domain(final_url: &str, expected: &str) -> Option<String> {
    let domain = normalize_publisher_domain(final_url).ok()?;
    same_publisher(expected, &domain).then_some(domain)
}

/// A linked address that is HTTPS, has no credentials, and stays on the publisher.
pub fn publisher_url(value: &str, base: &Url, publisher_domain: &str) -> Option<String> {
    let url = resolve(value, base)?;
    if !url.https || !url.username.is_empty() || !url.password.is_empty() {
        return None;
    }
    accepted_final_domain(&url.href, publisher_domain).map(|_| url.href)
}

pub struct Metadata {
    pub title: String,
    pub description: String,
    pub canonical_url: Option<String>,
}

/// Drops script, style, svg and noscript blocks. Selectors never read them, and they make up
/// most of a modern page, so parsing the rest costs far less of the module's compute budget.
pub fn lean_html(html: &str) -> String {
    const SKIPPED: [&str; 4] = ["script", "style", "svg", "noscript"];
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut out = String::with_capacity(html.len() / 2);
    let mut copied = 0;
    let mut at = 0;
    while let Some(offset) = lower[at..].find('<') {
        let start = at + offset;
        at = start + 1;
        let name = &lower[start + 1..];
        let Some(tag) = SKIPPED.iter().find(|tag| {
            name.starts_with(**tag) && matches!(bytes.get(start + 1 + tag.len()), Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/'))
        }) else {
            continue;
        };
        out.push_str(&html[copied..start]);
        let close = format!("</{tag}");
        let end = match lower[start..].find(&close) {
            Some(end) => match lower[start + end..].find('>') {
                Some(gt) => start + end + gt + 1,
                None => html.len(),
            },
            None => html.len(),
        };
        copied = end;
        at = end;
    }
    out.push_str(&html[copied..]);
    out
}

/// The part of a page before its body. Titles and link tags live there, so the body is never parsed for them.
fn head_of(html: &str) -> String {
    match html.to_ascii_lowercase().find("</head") {
        Some(end) => lean_html(&html[..end]),
        None => lean_html(&html.chars().take(HEAD_FALLBACK_CHARS).collect::<String>()),
    }
}

/// The href of every anchor tag, in page order, found by a plain scan so the page is never parsed.
pub fn anchor_hrefs(html: &str) -> Vec<String> {
    let lean = lean_html(html);
    let lower = lean.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(offset) = lower[at..].find("<a") {
        let start = at + offset;
        at = start + 2;
        if !matches!(lower.as_bytes().get(at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            continue;
        }
        let end = lower[at..].find('>').map_or(lower.len(), |gt| at + gt);
        let tag = &lower[at..end];
        let Some(key) = tag.find("href=") else { continue };
        let value_start = at + key + 5;
        let Some(quote) = lower[value_start..].chars().next().filter(|c| *c == '"' || *c == '\'') else { continue };
        let value_start = value_start + 1;
        if let Some(len) = lean[value_start..].find(quote) {
            out.push(lean[value_start..value_start + len].to_owned());
        }
        at = end;
    }
    out
}

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("fixed selector")
}

/// Page title, description and canonical address, read the way the old reader read them.
pub fn html_metadata(html: &str) -> Metadata {
    let document = Html::parse_document(&head_of(html));
    let title = document
        .select(&selector("title"))
        .next()
        .map(|el| el.text().collect::<String>())
        .unwrap_or_default();
    let mut description = String::new();
    let mut canonical_url: Option<String> = None;
    for el in document.select(&selector("link, meta")) {
        let value = el.value();
        if value.name() == "link" {
            if value.attr("rel").unwrap_or_default().eq_ignore_ascii_case("canonical") {
                canonical_url = value.attr("href").map(str::to_owned);
            }
            continue;
        }
        let key = value.attr("property").or_else(|| value.attr("name")).unwrap_or_default().to_ascii_lowercase();
        if key == "og:url" {
            canonical_url = value.attr("content").map(str::to_owned).or(canonical_url);
        }
        if key == "description" || key == "og:description" {
            if let Some(content) = value.attr("content") {
                description = content.to_owned();
            }
        }
    }
    Metadata {
        title: sanitize_feed_text(Some(&title), 120),
        description: sanitize_feed_text(Some(&description), 300),
        canonical_url,
    }
}

/// Up to three same-publisher HTTPS feed links the page advertises, in page order.
pub fn discover_feed_urls(html: &str, base_url: &str) -> Vec<String> {
    let Some(base) = Url::parse(base_url) else { return Vec::new() };
    let document = Html::parse_document(&head_of(html));
    let mut urls: Vec<String> = Vec::new();
    for el in document.select(&selector("link")) {
        if urls.len() >= MAX_FEED_LINKS {
            break;
        }
        let value = el.value();
        let alternate = value.attr("rel").unwrap_or_default().to_ascii_lowercase().split_whitespace().any(|r| r == "alternate");
        let kind = value.attr("type").unwrap_or_default().to_ascii_lowercase();
        if !alternate || !(kind == "application/rss+xml" || kind == "application/atom+xml") {
            continue;
        }
        let Some(url) = resolve(value.attr("href").unwrap_or_default(), &base) else { continue };
        if url.https && same_publisher(&url.hostname, &base.hostname) && !urls.contains(&url.href) {
            urls.push(url.href);
        }
    }
    urls
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    pub headline: String,
    pub url: String,
}

/// The first `cap` usable stories in a feed: a headline and an HTTPS link.
pub fn sample_feed_headlines(xml: &str, cap: usize) -> Vec<Sample> {
    let mut out = Vec::new();
    for item in parse_feed_xml(xml) {
        if out.len() >= cap {
            break;
        }
        let headline = sanitize_feed_text(Some(&item.title), TITLE_CHAR_CAP);
        let Some(url) = sanitize_item_url(Some(&item.link)) else { continue };
        if headline.is_empty() || !url.starts_with("https://") {
            continue;
        }
        out.push(Sample { headline, url });
    }
    out
}

pub fn is_feed(body: &str) -> bool {
    is_public_feed_document(body)
}

/// Lower-case hex SHA-256, the form the old code stored as the validation fingerprint.
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
        0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
        0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for (slot, add) in h.iter_mut().zip(v) {
            *slot = slot.wrapping_add(add);
        }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}
