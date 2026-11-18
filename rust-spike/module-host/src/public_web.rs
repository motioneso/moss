//! Public-web fetch mode. A package that declares the `public-web` resource on the fetch port may
//! read any public HTTPS site the person adds. Every hop is checked here, in the host:
//! HTTPS on port 443 only, no embedded passwords, public addresses only (the name is resolved
//! once, every answer is checked, and the connection is pinned to those answers), robots rules,
//! a pause between calls to one host, and caps on time, size and content type.
//! Failures are plain reasons. A failure never carries any part of a response body.
use crate::{network, robots::Robots};
use anyhow::Result;
use reqwest::{blocking::Client, header, Method};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    io::Read,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::{Host, Url};

pub const PUBLIC_WEB: &str = "public-web";
const REDIRECT_LIMIT: usize = 3;
const DEFAULT_BYTES: usize = 500_000;
const BYTES_CEILING: usize = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8);
const TIMEOUT_CEILING: Duration = Duration::from_secs(20);
const ROBOTS_BYTES: usize = 512 * 1024;
const ROBOTS_TTL: Duration = Duration::from_secs(30 * 60);
const ROBOTS_ENTRIES: usize = 256;
const PACE_ENTRIES: usize = 1024;
const PACE_MAX_WAIT: Duration = Duration::from_secs(10);
const ROBOTS_AGENT: &str = "moss";
const DEFAULT_AGENT: &str = "Moss-PublicWeb";
/// Reddit's robots file refuses generic agents, so its feed address alone skips the robots gate.
const ROBOTS_EXCEPTION_HOST: &str = "www.reddit.com";

/// The addresses a name resolved to. `checked` is what the guard inspects. `dial` is where the
/// connection goes. Production keeps them identical.
pub struct Resolved {
    pub checked: Vec<IpAddr>,
    pub dial: Vec<SocketAddr>,
}
pub trait Resolve: Send + Sync {
    fn resolve(&self, host: &str, remaining: Duration) -> Result<Resolved>;
}
struct System;
impl Resolve for System {
    fn resolve(&self, host: &str, remaining: Duration) -> Result<Resolved> {
        let dial = network::resolve(host, 443, remaining)?;
        Ok(Resolved {
            checked: dial.iter().map(SocketAddr::ip).collect(),
            dial,
        })
    }
}

/// A refused or failed read. Only the reason, an optional finer detail, the HTTP status and the
/// raw Retry-After text are ever reported.
#[derive(Debug, PartialEq)]
pub struct Failure {
    pub reason: &'static str,
    pub detail: Option<&'static str>,
    pub status: Option<u16>,
    pub retry_after: Option<String>,
}
impl Failure {
    fn new(reason: &'static str) -> Self {
        Self {
            reason,
            detail: None,
            status: None,
            retry_after: None,
        }
    }
    fn detail(mut self, detail: &'static str) -> Self {
        self.detail = Some(detail);
        self
    }
    fn status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
    pub fn to_json(&self) -> Value {
        let mut out = json!({"ok":false,"reason":self.reason});
        if let Some(detail) = self.detail {
            out["detail"] = json!(detail);
        }
        if let Some(status) = self.status {
            out["status"] = json!(status);
        }
        if let Some(after) = &self.retry_after {
            out["retryAfter"] = json!(after);
        }
        out
    }
}
type Fail<T> = std::result::Result<T, Failure>;

struct Options {
    max_bytes: usize,
    timeout: Duration,
    user_agent: String,
    accept: Option<String>,
    content_types: Option<Vec<String>>,
    allowed_hosts: Option<Vec<String>>,
    reject_oversized: bool,
    skip_robots: bool,
    base64: bool,
    /// Set only by the host's own browser path. A package cannot ask for it.
    unpaced: bool,
}
struct Raw {
    status: u16,
    headers: header::HeaderMap,
    body: Vec<u8>,
    truncated: bool,
    declared: Option<usize>,
    final_url: Url,
    hops: usize,
}

pub struct PublicWeb {
    resolver: Arc<dyn Resolve>,
    trust: Option<String>,
    pace: Duration,
    robots: Mutex<HashMap<String, (Instant, Arc<Robots>)>>,
    next_free: Mutex<HashMap<String, Instant>>,
    /// Proof only. Skips the private-address check so a test can see it fail.
    #[cfg(feature = "browser-proof")]
    private_allowed: bool,
}
impl Default for PublicWeb {
    fn default() -> Self {
        Self::new(Arc::new(System), None, Duration::from_secs(1))
    }
}
impl PublicWeb {
    /// Test-only seam. Production uses `default()`: the system resolver, the built-in trust roots
    /// and a one second pause between calls to one host. Tests supply their own resolver, an
    /// extra trusted certificate and a shorter pause.
    pub fn new(resolver: Arc<dyn Resolve>, trust: Option<String>, pace: Duration) -> Self {
        Self {
            resolver,
            trust,
            pace,
            robots: Mutex::default(),
            next_free: Mutex::default(),
            #[cfg(feature = "browser-proof")]
            private_allowed: false,
        }
    }

    #[cfg(feature = "browser-proof")]
    pub fn with_private_destinations_allowed(mut self) -> Self {
        self.private_allowed = true;
        self
    }

    /// Reads one address for a package. Always returns a JSON answer with `ok` set, so a refused
    /// read reaches the package as a reason it can show, not as a crashed call.
    pub fn fetch(&self, operation: &str, parameters: &Value, remaining: Duration) -> Value {
        match self.read(operation, parameters, remaining, false) {
            Ok(done) => done,
            Err(failure) => failure.to_json(),
        }
    }

    /// The rendering browser's page requests. Same guards as `fetch`, without the pause between
    /// calls to one host, because one page load makes many requests to the same site. The
    /// browser port's own caps bound how many.
    pub(crate) fn fetch_for_browser(&self, parameters: &Value, remaining: Duration) -> Value {
        match self.read("get", parameters, remaining, true) {
            Ok(done) => done,
            Err(failure) => failure.to_json(),
        }
    }

    fn read(
        &self,
        operation: &str,
        parameters: &Value,
        remaining: Duration,
        unpaced: bool,
    ) -> Fail<Value> {
        if !operation.eq_ignore_ascii_case("get") {
            return Err(Failure::new("blocked"));
        }
        let mut options = options(parameters, remaining)?;
        options.unpaced = unpaced;
        let url = Url::parse(parameters["url"].as_str().unwrap_or_default())
            .map_err(|_| Failure::new("blocked"))?;
        let deadline = Instant::now() + options.timeout;
        let raw = self.hops(url, &options, deadline, true)?;
        let content_type = raw
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if raw.status == 429 {
            return Err(with_retry(Failure::new("rate_limited").status(429), &raw));
        }
        if raw.status >= 400 {
            let challenge = raw
                .headers
                .get("cf-mitigated")
                .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"challenge"));
            let reason = if challenge { "challenge" } else { "http_error" };
            return Err(with_retry(Failure::new(reason).status(raw.status), &raw));
        }
        if let Some(allowed) = &options.content_types {
            let media = content_type
                .as_deref()
                .and_then(|v| v.split(';').next())
                .map(|v| v.trim().to_ascii_lowercase());
            if !media.is_some_and(|m| allowed.contains(&m)) {
                return Err(Failure::new("blocked")
                    .detail("unsupported_content_type")
                    .status(raw.status));
            }
        }
        if options.reject_oversized {
            let too_big = raw.truncated || raw.declared.is_some_and(|n| n > options.max_bytes);
            if too_big {
                return Err(Failure::new("blocked")
                    .detail("response_too_large")
                    .status(raw.status));
            }
            if raw.declared.is_some_and(|n| n != raw.body.len()) {
                return Err(Failure::new("blocked")
                    .detail("invalid_response")
                    .status(raw.status));
            }
        }
        let body = if options.base64 {
            use base64::Engine;
            json!(base64::engine::general_purpose::STANDARD.encode(&raw.body))
        } else {
            json!(String::from_utf8_lossy(&raw.body))
        };
        Ok(json!({
            "ok":true,"status":raw.status,"finalUrl":raw.final_url.as_str(),
            "contentType":content_type,"body":body,"truncated":raw.truncated,
            "hopCount":raw.hops,"encoding":if options.base64 {"base64"} else {"text"},
        }))
    }

    /// Follows redirects one hop at a time. Each hop repeats every check. A gated hop first asks
    /// the robots rules about its own address.
    fn hops(&self, first: Url, options: &Options, deadline: Instant, gated: bool) -> Fail<Raw> {
        let mut current = first;
        for hops in 0..=REDIRECT_LIMIT {
            let host = self.check_destination(&current, options)?;
            let robots_off = !gated || (options.skip_robots && reddit_listing(&current));
            if !robots_off && !self.robots_allow(&current, options, deadline)? {
                return Err(Failure::new("robots"));
            }
            if !options.unpaced {
                self.pace(&host, deadline)?;
            }
            let addresses = self.resolve(&host, deadline)?;
            let remaining = left(deadline)?;
            let response = self
                .client(&host, &addresses, remaining)?
                .request(Method::GET, current.clone())
                .header(header::USER_AGENT, &options.user_agent)
                .header(header::ACCEPT, options.accept.as_deref().unwrap_or("*/*"))
                .send()
                .map_err(transport)?;
            let status = response.status();
            if status.is_redirection() {
                let target = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| current.join(v).ok());
                let Some(target) = target else {
                    return Err(Failure::new("http_error").status(status.as_u16()));
                };
                current = target;
                continue;
            }
            let headers = response.headers().clone();
            let declared = match headers.get(header::CONTENT_LENGTH) {
                None => None,
                Some(v) => match v.to_str().ok().and_then(|v| v.trim().parse::<usize>().ok()) {
                    Some(n) => Some(n),
                    None => {
                        return Err(Failure::new("blocked")
                            .detail("invalid_response")
                            .status(status.as_u16()))
                    }
                },
            };
            let max = options.max_bytes;
            let mut body = Vec::new();
            if status.as_u16() < 400 || !gated {
                response
                    .take(max as u64 + 1)
                    .read_to_end(&mut body)
                    .map_err(|e| read_failure(&e))?;
            }
            let truncated = body.len() > max;
            body.truncate(max);
            return Ok(Raw {
                status: status.as_u16(),
                headers,
                body,
                truncated,
                declared,
                final_url: current,
                hops,
            });
        }
        Err(Failure::new("network"))
    }

    /// The address guard for one hop. Returns the host name to connect to.
    fn check_destination(&self, url: &Url, options: &Options) -> Fail<String> {
        if url.scheme() == "http" {
            return Err(Failure::new("not_https"));
        }
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port_or_known_default() != Some(443)
        {
            return Err(Failure::new("blocked"));
        }
        let host = url.host().ok_or_else(|| Failure::new("blocked"))?;
        let name = match host {
            Host::Domain(name) => {
                let name = name.to_ascii_lowercase();
                if name == "localhost" || name.ends_with(".localhost") {
                    return Err(Failure::new("blocked"));
                }
                name
            }
            Host::Ipv4(ip) => {
                ensure_public(IpAddr::V4(ip))?;
                ip.to_string()
            }
            Host::Ipv6(ip) => {
                ensure_public(IpAddr::V6(ip))?;
                ip.to_string()
            }
        };
        if options
            .allowed_hosts
            .as_ref()
            .is_some_and(|hosts| !hosts.contains(&name))
        {
            return Err(Failure::new("blocked"));
        }
        Ok(name)
    }

    fn resolve(&self, host: &str, deadline: Instant) -> Fail<Vec<SocketAddr>> {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(vec![SocketAddr::new(ip, 443)]);
        }
        let resolved = self
            .resolver
            .resolve(host, left(deadline)?)
            .map_err(|_| Failure::new("blocked"))?;
        if resolved.checked.is_empty() || resolved.dial.is_empty() {
            return Err(Failure::new("blocked"));
        }
        #[cfg(feature = "browser-proof")]
        if self.private_allowed {
            return Ok(resolved.dial);
        }
        for ip in &resolved.checked {
            ensure_public(*ip)?;
        }
        Ok(resolved.dial)
    }

    fn client(&self, host: &str, addresses: &[SocketAddr], remaining: Duration) -> Fail<Client> {
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(remaining)
            .resolve_to_addrs(host, addresses);
        if let Some(pem) = &self.trust {
            let certificate = reqwest::Certificate::from_pem(pem.as_bytes())
                .map_err(|_| Failure::new("network"))?;
            builder = builder.add_root_certificate(certificate);
        }
        builder.build().map_err(|_| Failure::new("network"))
    }

    /// Waits so one host sees at most one call per pause. A wait longer than the ceiling, or past
    /// the call's deadline, is refused instead of slept.
    fn pace(&self, host: &str, deadline: Instant) -> Fail<()> {
        let wait = {
            let mut slots = self.next_free.lock().map_err(|_| Failure::new("network"))?;
            let now = Instant::now();
            let wait = slots
                .get(host)
                .map_or(Duration::ZERO, |at| at.saturating_duration_since(now));
            if wait > PACE_MAX_WAIT {
                return Err(Failure::new("rate_limited"));
            }
            if now + wait >= deadline {
                return Err(Failure::new("timeout"));
            }
            slots.insert(host.to_owned(), now + wait + self.pace);
            if slots.len() > PACE_ENTRIES {
                slots.retain(|_, at| *at > now);
            }
            wait
        };
        std::thread::sleep(wait);
        Ok(())
    }

    /// Asks the site's robots file about this address. An unreadable file blocks the read, so an
    /// unknown policy never counts as permission.
    fn robots_allow(&self, url: &Url, options: &Options, deadline: Instant) -> Fail<bool> {
        let origin = url.origin().ascii_serialization();
        let cached = self
            .robots
            .lock()
            .map_err(|_| Failure::new("network"))?
            .get(&origin)
            .filter(|(at, _)| at.elapsed() < ROBOTS_TTL)
            .map(|(_, rules)| rules.clone());
        let rules = match cached {
            Some(rules) => rules,
            None => {
                let fetched = Url::parse(&format!("{origin}/robots.txt"))
                    .map_err(|_| Failure::new("robots"))?;
                let probe = Options {
                    max_bytes: ROBOTS_BYTES,
                    content_types: None,
                    reject_oversized: false,
                    skip_robots: false,
                    accept: None,
                    base64: false,
                    user_agent: options.user_agent.clone(),
                    allowed_hosts: options.allowed_hosts.clone(),
                    timeout: options.timeout,
                    unpaced: options.unpaced,
                };
                let rules = match self.hops(fetched, &probe, deadline, false) {
                    Err(failure) => return Err(failure),
                    Ok(raw) if raw.status == 200 => {
                        Robots::parse(&String::from_utf8_lossy(&raw.body), ROBOTS_AGENT)
                    }
                    Ok(raw) if raw.status == 404 || raw.status == 410 => Robots::allow_all(),
                    _ => Robots::deny_all(),
                };
                let rules = Arc::new(rules);
                let mut cache = self.robots.lock().map_err(|_| Failure::new("network"))?;
                if cache.len() >= ROBOTS_ENTRIES {
                    cache.retain(|_, (at, _)| at.elapsed() < ROBOTS_TTL);
                }
                if cache.len() >= ROBOTS_ENTRIES {
                    if let Some(oldest) = cache
                        .iter()
                        .min_by_key(|(_, (at, _))| *at)
                        .map(|(k, _)| k.clone())
                    {
                        cache.remove(&oldest);
                    }
                }
                cache.insert(origin, (Instant::now(), rules.clone()));
                rules
            }
        };
        let path = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_owned(),
        };
        Ok(rules.allows(&path))
    }
}

/// The one robots exception: a subreddit's feed, `/r/<name>/<hot|new|top>.rss` on the Reddit host.
fn reddit_listing(url: &Url) -> bool {
    if url.host_str() != Some(ROBOTS_EXCEPTION_HOST) || url.query().is_some() {
        return false;
    }
    let parts: Vec<&str> = url.path().split('/').collect();
    matches!(
        parts.as_slice(),
        ["", "r", name, "hot.rss" | "new.rss" | "top.rss"]
            if !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    )
}

fn left(deadline: Instant) -> Fail<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(Failure::new("timeout"))
    } else {
        Ok(remaining)
    }
}
fn transport(error: reqwest::Error) -> Failure {
    Failure::new(if error.is_timeout() {
        "timeout"
    } else {
        "network"
    })
}
fn read_failure(error: &std::io::Error) -> Failure {
    let text = error.to_string().to_ascii_lowercase();
    Failure::new(
        if error.kind() == std::io::ErrorKind::TimedOut || text.contains("timed out") {
            "timeout"
        } else {
            "network"
        },
    )
}
fn with_retry(mut failure: Failure, raw: &Raw) -> Failure {
    failure.retry_after = raw
        .headers
        .get(header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= 64)
        .map(str::to_owned);
    failure
}

/// Public addresses only. Wraps the install-wide private-range list and also refuses 6to4
/// (2002::/16), which hides an IPv4 address inside an IPv6 one.
pub fn public_destination(ip: IpAddr) -> bool {
    let six_to_four = matches!(ip, IpAddr::V6(v) if v.segments()[0] == 0x2002);
    crate::registry::public_ip(ip) && !six_to_four
}
fn ensure_public(ip: IpAddr) -> Fail<()> {
    if public_destination(ip) {
        Ok(())
    } else {
        Err(Failure::new("blocked"))
    }
}

/// Reads the package's limits and clamps each to the host ceiling.
fn options(parameters: &Value, remaining: Duration) -> Fail<Options> {
    let empty = Map::new();
    let map = parameters.as_object().unwrap_or(&empty);
    let allowed = [
        "url",
        "maxBytes",
        "timeoutMs",
        "userAgent",
        "accept",
        "allowedContentTypes",
        "allowedHosts",
        "rejectOversizedResponses",
        "skipRobots",
        "encoding",
    ];
    if map.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(Failure::new("blocked"));
    }
    let max_bytes = match map.get("maxBytes") {
        None => DEFAULT_BYTES,
        Some(v) => v
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| Failure::new("blocked"))?
            .min(BYTES_CEILING as u64) as usize,
    };
    let timeout = match map.get("timeoutMs") {
        None => DEFAULT_TIMEOUT,
        Some(v) => Duration::from_millis(
            v.as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| Failure::new("blocked"))?,
        ),
    }
    .min(TIMEOUT_CEILING)
    .min(remaining);
    let printable = |text: &str| {
        !text.is_empty() && text.len() <= 200 && text.bytes().all(|b| (0x20..=0x7e).contains(&b))
    };
    let text = |key: &str| -> Fail<Option<String>> {
        match map.get(key) {
            None => Ok(None),
            Some(v) => v
                .as_str()
                .filter(|s| printable(s))
                .map(|s| Some(s.to_owned()))
                .ok_or_else(|| Failure::new("blocked")),
        }
    };
    let list = |key: &str, lower: bool| -> Fail<Option<Vec<String>>> {
        match map.get(key) {
            None => Ok(None),
            Some(v) => {
                let items = v
                    .as_array()
                    .filter(|a| a.len() <= 32)
                    .ok_or_else(|| Failure::new("blocked"))?;
                items
                    .iter()
                    .map(|i| {
                        i.as_str()
                            .filter(|s| printable(s))
                            .map(|s| {
                                if lower {
                                    s.to_ascii_lowercase()
                                } else {
                                    s.to_owned()
                                }
                            })
                            .ok_or_else(|| Failure::new("blocked"))
                    })
                    .collect::<Fail<Vec<_>>>()
                    .map(Some)
            }
        }
    };
    let flag = |key: &str| -> Fail<bool> {
        match map.get(key) {
            None => Ok(false),
            Some(v) => v.as_bool().ok_or_else(|| Failure::new("blocked")),
        }
    };
    let base64 = match map.get("encoding").and_then(Value::as_str) {
        None | Some("text") => false,
        Some("base64") => true,
        Some(_) => return Err(Failure::new("blocked")),
    };
    Ok(Options {
        max_bytes,
        timeout,
        user_agent: text("userAgent")?.unwrap_or_else(|| DEFAULT_AGENT.to_owned()),
        accept: text("accept")?,
        content_types: list("allowedContentTypes", true)?,
        allowed_hosts: list("allowedHosts", true)?,
        reject_oversized: flag("rejectOversizedResponses")?,
        skip_robots: flag("skipRobots")?,
        base64,
        unpaced: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_in_private_ranges_are_never_public() {
        for text in [
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "100.100.100.100",
            "0.0.0.0",
            "::1",
            "fd7a:115c:a1e0::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "2002:0a00:0001::1",
            "64:ff9b::a00:1",
        ] {
            assert!(!public_destination(text.parse().unwrap()), "{text}");
        }
        for text in ["93.184.216.34", "2606:2800:220:1::1"] {
            assert!(public_destination(text.parse().unwrap()), "{text}");
        }
    }
    #[test]
    fn unknown_or_malformed_options_are_refused() {
        let ok = options(&json!({"url":"https://a.test/"}), Duration::from_secs(30)).unwrap();
        assert_eq!(ok.max_bytes, DEFAULT_BYTES);
        let big = options(
            &json!({"url":"https://a.test/","maxBytes":99999999999u64,"timeoutMs":999999}),
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            (big.max_bytes, big.timeout),
            (BYTES_CEILING, TIMEOUT_CEILING)
        );
        for bad in [
            json!({"headers":{}}),
            json!({"maxBytes":0}),
            json!({"userAgent":"a\nb"}),
            json!({"encoding":"gzip"}),
            json!({"skipRobots":"yes"}),
        ] {
            assert!(options(&bad, Duration::from_secs(30)).is_err(), "{bad}");
        }
    }
}
