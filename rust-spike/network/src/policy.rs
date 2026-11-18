use axum::http::{HeaderMap, Method};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use url::Url;

/// Exact HTTPS authorities only. Neither proxy headers nor DNS lookups confer trust.
pub struct Policy {
    origins: Vec<(String, String, bool)>,
    sharing: AtomicBool,
}

pub fn loopback(ip: IpAddr) -> bool {
    ip.is_loopback()
        || matches!(ip, IpAddr::V6(v) if v.to_ipv4_mapped().is_some_and(|v| v.is_loopback()))
}

impl Policy {
    pub fn new(origins: &[&str], sharing: bool) -> Result<Self, &'static str> {
        if origins.is_empty() || origins.len() > 32 {
            return Err("Configure between one and thirty-two HTTPS origins");
        }
        let mut parsed = Vec::new();
        for origin in origins {
            let url = Url::parse(origin).map_err(|_| "Invalid HTTPS origin")?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || url.host_str().is_none()
                || url.host_str().is_some_and(|h| h.ends_with('.'))
                || origin.contains(['*', '?', '#'])
            {
                return Err("Trust an exact HTTPS origin without a path or credentials");
            }
            let canonical = url.origin().ascii_serialization();
            if canonical != origin.trim_end_matches('/') {
                return Err("Use the canonical HTTPS origin");
            }
            let authority = canonical.trim_start_matches("https://").to_owned();
            let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
            let local = host == "localhost" || host.parse::<IpAddr>().is_ok_and(loopback);
            parsed.push((canonical, authority, local));
        }
        Ok(Self {
            origins: parsed,
            sharing: AtomicBool::new(sharing),
        })
    }

    pub fn sharing(&self) -> bool {
        self.sharing.load(Ordering::Acquire)
    }
    pub fn set_sharing(&self, sharing: bool) {
        self.sharing.store(sharing, Ordering::Release);
    }

    pub fn local_authority(&self, headers: &HeaderMap) -> bool {
        single(headers, "host").is_some_and(|h| {
            self.origins
                .iter()
                .any(|(_, a, local)| *local && a == &h.to_ascii_lowercase())
        })
    }

    pub fn check(&self, headers: &HeaderMap, method: &Method, peer: IpAddr) -> Result<(), u16> {
        let authority = single(headers, "host").ok_or(421u16)?.to_ascii_lowercase();
        let (origin, _, local) = self
            .origins
            .iter()
            .find(|(_, a, _)| a == &authority)
            .ok_or(421u16)?;
        if !self.sharing() && (!loopback(peer) || !local) {
            return Err(403);
        }
        if headers.contains_key("origin") {
            if single(headers, "origin") != Some(origin.as_str()) {
                return Err(403);
            }
        } else if !matches!(*method, Method::GET | Method::HEAD) {
            return Err(403);
        }
        if headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site")
        {
            return Err(403);
        }
        Ok(())
    }
}

fn single<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    (values.next().is_none() && !value.is_empty()).then_some(value)
}
