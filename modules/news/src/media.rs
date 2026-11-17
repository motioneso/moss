//! Story pictures and publisher icons. A picture is only fetched for a story in the person's own
//! stored page, and an icon only for a publisher the person already sees. The shell sends the
//! bytes, so a route here returns the picture as base64 and the shell checks it again.
use crate::compile::{parse_ms, snapshot_valid, MAX_AGE_MS};
use crate::personalization::{SNAPSHOTS, SOURCES};
use crate::util::{error, now};
use crate::{catalog, web};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

/// Largest story picture in bytes. The old limit was 2 MiB, but a picture crosses the host as
/// base64 inside a 1 MiB message, so the raw limit sits below that.
pub const IMAGE_MAX_BYTES: usize = 700_000;
pub const FAVICON_MAX_BYTES: usize = 256 * 1024;
const IMAGE_CACHE_SECONDS: u32 = 300;
const FAVICON_CACHE_SECONDS: u32 = 86_400;

/// A bare hostname: dotted labels of letters, digits and hyphens, no scheme, path or port.
pub fn valid_hostname(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 || !name.contains('.') {
        return false;
    }
    name.split('.').all(|label| {
        let bytes = label.as_bytes();
        (1..=63).contains(&bytes.len())
            && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-')
            && bytes[0] != b'-'
            && bytes[bytes.len() - 1] != b'-'
    })
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The story with this id from the person's stored page, when the page is current, valid and
/// holds exactly one recent story with a picture.
pub fn image_article<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let now_ms = now(host)?.timestamp_millis();
    let rows = Client(host).query(SNAPSHOTS, &Query::select(Filter::All))?;
    let Some(row) = rows.into_iter().next() else { return Ok(None) };
    if parse_ms(row["expires_at"].as_str().unwrap_or_default()).unwrap_or_default() <= now_ms || !snapshot_valid(&row["payload"]) {
        return Ok(None);
    }
    let cutoff = now_ms - MAX_AGE_MS;
    let mut matches = row["payload"]["articles"].as_array().into_iter().flatten().filter(|article| {
        article["id"] == id
            && article["imageUrl"].is_string()
            && parse_ms(article["publishedAt"].as_str().unwrap_or_default()).unwrap_or_default() >= cutoff
    });
    let found = matches.next().cloned();
    Ok(if matches.next().is_some() { None } else { found })
}

/// The first bytes of a base64 string, enough to read a picture's signature.
fn head(base64: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::new();
    for chunk in base64.as_bytes().chunks(4).take(4) {
        let mut bits = 0u32;
        let mut used = 0;
        for c in chunk {
            let Some(v) = value(*c) else { break };
            bits = (bits << 6) | u32::from(v);
            used += 1;
        }
        if used < 2 {
            break;
        }
        bits <<= 6 * (4 - used);
        out.extend_from_slice(&bits.to_be_bytes()[1..][..used - 1]);
    }
    out
}

fn image_type(declared: Option<&str>, bytes: &[u8]) -> Option<&'static str> {
    let mime = declared?.split(';').next()?.trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some("image/jpeg"),
        "image/png" if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) => Some("image/png"),
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Some("image/gif"),
        "image/webp" if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => Some("image/webp"),
        _ => None,
    }
}

/// Icons arrive with unreliable type headers, so the bytes decide. SVG is left out because it can
/// carry a script.
fn icon_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn read_picture<H: Host + ?Sized>(host: &H, url: &str, limit: usize, hosts: Option<&[String]>, skip_robots: bool) -> Option<web::Fetched> {
    let mut extra = json!({"maxBytes": limit, "rejectOversizedResponses": true, "encoding": "base64", "accept": "image/*,*/*;q=0.5"});
    if skip_robots {
        extra["skipRobots"] = json!(true);
    }
    if let Some(hosts) = hosts {
        extra["allowedHosts"] = json!(hosts);
    }
    web::get(host, url, Some(extra)).ok().filter(|fetched| fetched.status == 200)
}

/// `GET /images/:article_id`.
pub fn image<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("article_id").map(String::as_str).unwrap_or_default();
    let Some(url) = image_article(host, id)?.and_then(|a| a["imageUrl"].as_str().map(str::to_owned)) else {
        return Ok(error(404, "News image not found"));
    };
    let unavailable = || error(502, "News image is unavailable");
    let Some(fetched) = read_picture(host, &url, IMAGE_MAX_BYTES, None, false) else { return Ok(unavailable()) };
    match image_type(fetched.content_type.as_deref(), &head(&fetched.body)) {
        Some(kind) => Ok(Response::image(kind, fetched.body, IMAGE_CACHE_SECONDS)),
        None => Ok(unavailable()),
    }
}

/// Hosts a catalog publisher's icon may be read from, and the pages of a saved source.
pub fn approved_publisher<H: Host + ?Sized>(host: &H, domain: &str) -> Result<Option<String>> {
    let lower = domain.to_ascii_lowercase();
    let fixed = catalog::SOURCES.iter().any(|s| {
        host_of(s.homepage_url).as_deref() == Some(&lower) || s.image_hosts.iter().any(|h| h.eq_ignore_ascii_case(&lower))
    });
    let saved = Client(host).query(SOURCES, &Query::select(Filter::All))?;
    let mine = saved.iter().find(|row| row["canonical_domain"].as_str().is_some_and(|d| d.eq_ignore_ascii_case(&lower)));
    Ok(match (fixed, mine) {
        (_, Some(row)) => Some(row["label"].as_str().unwrap_or(domain).to_owned()),
        (true, None) => Some(domain.to_owned()),
        (false, None) => None,
    })
}

/// The icon may redirect only to its own host or, for a catalog publisher, a host that
/// publisher already lists for its pictures.
fn icon_hosts(domain: &str) -> Vec<String> {
    let lower = domain.to_ascii_lowercase();
    let mut hosts = vec![lower.clone()];
    if let Some(source) = catalog::SOURCES.iter().find(|s| host_of(s.homepage_url).as_deref() == Some(&lower)) {
        for extra in source.image_hosts {
            let extra = extra.to_ascii_lowercase();
            if !hosts.contains(&extra) {
                hosts.push(extra);
            }
        }
    }
    hosts
}

/// `GET /favicon/:domain`.
pub fn favicon<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let domain = request.params.get("domain").map(String::as_str).unwrap_or_default();
    let missing = || error(404, "Favicon not found");
    if !valid_hostname(domain) || approved_publisher(host, domain)?.is_none() {
        return Ok(missing());
    }
    let hosts = icon_hosts(domain);
    let Some(fetched) = read_picture(host, &format!("https://{domain}/favicon.ico"), FAVICON_MAX_BYTES, Some(&hosts), true) else {
        return Ok(missing());
    };
    match icon_type(&head(&fetched.body)) {
        Some(kind) => Ok(Response::image(kind, fetched.body, FAVICON_CACHE_SECONDS)),
        None => Ok(missing()),
    }
}
