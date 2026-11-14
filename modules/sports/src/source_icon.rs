//! `GET /sources/:sourceId/icon`. The icon is fetched by the server, accepted on its first bytes
//! alone, and answered as JSON with the image in base64, because a package reply has no raw image
//! channel. A source whose icon cannot be found is remembered for an hour.
use crate::public_cache::now_ms;
use crate::sources;
use crate::util::bad_request;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use moss_news_reader::url::Url;
use serde_json::{json, Map, Value};

pub const MAX_BYTES: u64 = 256 * 1024;
const TIMEOUT_MS: u64 = 5_000;
const MISS_TTL_MS: i64 = 60 * 60 * 1000;
const MISS_NAMESPACE: &str = "source-icon-misses";
const MISS_ENTRIES: usize = 256;
const REDDIT_ICON_HOSTS: [&str; 2] = ["styles.redditmedia.com", "b.thumbs.redditmedia.com"];

fn sextet(c: u8) -> Option<u32> {
    Some(match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    } as u32)
}

/// The first twelve bytes of a base64 body, enough to tell the image types apart.
fn head(encoded: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(12);
    for group in encoded.as_bytes().chunks(4).take(4) {
        let mut bits = 0u32;
        let mut count = 0;
        for &c in group {
            let Some(value) = sextet(c) else { break };
            bits = bits << 6 | value;
            count += 1;
        }
        if count < 2 {
            break;
        }
        bits <<= 6 * (4 - count);
        out.extend_from_slice(&bits.to_be_bytes()[1..count]);
    }
    out
}

/// The image type, from the first bytes only. HTML, SVG and anything else answer nothing.
pub fn sniff(first: &[u8]) -> Option<&'static str> {
    if first.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if first.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if first.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if first.starts_with(b"GIF87a") || first.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if first.len() >= 12 && &first[..4] == b"RIFF" && &first[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// The addresses tried for one source, in order.
pub fn lookup_urls(domain: &str, icon_url: Option<&str>) -> Vec<String> {
    if let Some(saved) = icon_url {
        if let Some(url) = Url::parse(saved) {
            if url.protocol() == "https:" && REDDIT_ICON_HOSTS.contains(&url.hostname.to_lowercase().as_str()) {
                return vec![saved.to_owned()];
            }
        }
    }
    let domain = domain.trim().to_lowercase();
    let mut urls = vec![format!("https://{domain}/favicon.ico")];
    if !domain.starts_with("www.") {
        urls.push(format!("https://www.{domain}/favicon.ico"));
    }
    urls
}

fn fetch<H: Host + ?Sized>(host: &H, url: &str) -> Result<Option<(&'static str, String)>> {
    let Some(parsed) = Url::parse(url) else { return Ok(None) };
    let answer = host.call(
        "fetch",
        "get",
        "public-web",
        json!({
            "url": url,
            "maxBytes": MAX_BYTES,
            "timeoutMs": TIMEOUT_MS,
            "allowedHosts": [parsed.hostname],
            "rejectOversizedResponses": true,
            "encoding": "base64",
        }),
    )?;
    if answer["ok"].as_bool() != Some(true) || answer["truncated"].as_bool() == Some(true) {
        return Ok(None);
    }
    let Some(body) = answer["body"].as_str() else { return Ok(None) };
    Ok(sniff(&head(body)).map(|kind| (kind, body.to_owned())))
}

fn misses<H: Host + ?Sized>(host: &H) -> Result<Map<String, Value>> {
    Ok(match host.call("kv", "get", MISS_NAMESPACE, Value::Null)? {
        Value::Object(map) => map,
        _ => Map::new(),
    })
}

fn remember_miss<H: Host + ?Sized>(host: &H, id: &str, now: i64, mut entries: Map<String, Value>) -> Result<()> {
    entries.retain(|_, until| until.as_i64().is_some_and(|t| t > now));
    while entries.len() >= MISS_ENTRIES {
        let Some(oldest) = entries.iter().min_by_key(|(_, t)| t.as_i64().unwrap_or(0)).map(|(k, _)| k.clone()) else { break };
        entries.remove(&oldest);
    }
    entries.insert(id.to_owned(), json!(now + MISS_TTL_MS));
    host.call("kv", "set", MISS_NAMESPACE, Value::Object(entries)).map(|_| ())
}

pub fn icon<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("sourceId").map(String::as_str).unwrap_or_default();
    if id.is_empty() || id.chars().count() > 128 {
        return Ok(bad_request(if id.is_empty() {
            "params/sourceId must NOT have fewer than 1 characters"
        } else {
            "params/sourceId must NOT have more than 128 characters"
        }));
    }
    let not_found = |message: &str| Response::new(404, json!({"error":message}));
    // Row level security hides another person's source, so it answers the same as a missing one.
    let found = if crate::util::is_uuid(id) { sources::icon_record(host, id)? } else { None };
    let Some((domain, saved)) = found else { return Ok(not_found("Sports source not found")) };
    let now = now_ms(host)?;
    let known = misses(host)?;
    if known.get(id).and_then(Value::as_i64).is_some_and(|until| until > now) {
        return Ok(not_found("Sports source icon not found"));
    }
    for url in lookup_urls(&domain, saved.as_deref()) {
        if let Some((kind, body)) = fetch(host, &url)? {
            return Ok(Response::new(200, json!({"contentType":kind,"bodyBase64":body})));
        }
    }
    remember_miss(host, id, now, known)?;
    Ok(not_found("Sports source icon not found"))
}
