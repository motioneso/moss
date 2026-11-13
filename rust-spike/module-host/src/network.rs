//! DNS pinning and redirect checking shared by the fetch and credential brokers.
use anyhow::{ensure, Context, Result};
use reqwest::{blocking::Client, header::HeaderMap, Method};
use std::{
    collections::BTreeSet,
    io::Read,
    net::{SocketAddr, ToSocketAddrs},
    sync::{mpsc, OnceLock},
    time::{Duration, Instant},
};
use url::Url;
const LIMIT: usize = 1024 * 1024;
type Lookup = (String, u16, mpsc::Sender<std::io::Result<Vec<SocketAddr>>>);
pub(crate) fn resolve(host: &str, port: u16, remaining: Duration) -> Result<Vec<SocketAddr>> {
    static WORKER: OnceLock<mpsc::SyncSender<Lookup>> = OnceLock::new();
    let worker = WORKER.get_or_init(|| {
        let (send, receive) = mpsc::sync_channel::<Lookup>(8);
        std::thread::spawn(move || {
            while let Ok((host, port, reply)) = receive.recv() {
                let result = (host.as_str(), port)
                    .to_socket_addrs()
                    .map(|ips| ips.collect());
                let _ = reply.send(result);
            }
        });
        send
    });
    let (reply, receive) = mpsc::channel();
    worker
        .try_send((host.to_owned(), port, reply))
        .map_err(|_| anyhow::anyhow!("The DNS service is busy"))?;
    Ok(receive
        .recv_timeout(remaining.min(Duration::from_secs(5)))
        .context("DNS deadline exceeded")??)
}
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}
pub fn request(
    url: &Url,
    hosts: &BTreeSet<String>,
    allow_private: bool,
    method: Method,
    headers: HeaderMap,
    body: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<Response> {
    ensure!(
        matches!(
            method,
            Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        ),
        "Unknown HTTP operation"
    );
    let started = Instant::now();
    let mut current = url.clone();
    for _ in 0..=5 {
        ensure!(
            current.scheme() == "https"
                && current.username().is_empty()
                && current.password().is_none()
                && current.port_or_known_default() == Some(443),
            "Only approved HTTPS destinations are allowed"
        );
        let host = current.host_str().context("A host is required")?;
        ensure!(
            hosts.contains(host),
            "The redirect destination was not approved"
        );
        let remaining = timeout.saturating_sub(started.elapsed());
        ensure!(!remaining.is_zero(), "HTTP deadline exceeded");
        let addresses = resolve(host, 443, remaining)?;
        ensure!(
            !addresses.is_empty()
                && (allow_private || addresses.iter().all(|a| crate::registry::public_ip(a.ip()))),
            "This destination resolves to a private or reserved network"
        );
        let remaining = timeout.saturating_sub(started.elapsed());
        ensure!(!remaining.is_zero(), "HTTP deadline exceeded");
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(remaining)
            .resolve_to_addrs(host, &addresses)
            .build()?;
        let form = headers
            .get(reqwest::header::CONTENT_TYPE)
            .is_some_and(|h| h == "application/x-www-form-urlencoded");
        let mut req = client
            .request(method.clone(), current.clone())
            .headers(headers.clone());
        if let Some(body) = &body {
            ensure!(
                serde_json::to_vec(body)?.len() <= LIMIT,
                "HTTP body too large"
            );
            if form {
                let fields = body
                    .as_object()
                    .context("Form fields must be an object")?
                    .iter()
                    .map(|(k, v)| Ok((k.as_str(), v.as_str().context("Form fields must be text")?)))
                    .collect::<Result<std::collections::BTreeMap<_, _>>>()?;
                req = req.form(&fields);
            } else {
                req = req.json(body);
            }
        }
        let response = req
            .send()
            .map_err(|_| anyhow::anyhow!("The remote service request failed"))?;
        if response.status().is_redirection() {
            // Never replay a credential-bearing write across redirect method changes.
            ensure!(
                method == Method::GET,
                "Redirected writes require a new approved request"
            );
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .context("Redirect has no destination")?
                .to_str()?;
            current = current.join(next)?;
            continue;
        }
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= LIMIT, "HTTP response too large");
        return Ok(Response {
            status,
            body: bytes,
        });
    }
    anyhow::bail!("Too many redirects")
}

/// Trusted upstream seam. Production uses Network; tests can stand in for the remote service
/// while retaining the real guest, authorization, credential broker and encrypted store.
pub struct Outbound<'a> {
    pub url: &'a Url,
    pub hosts: &'a BTreeSet<String>,
    pub allow_private: bool,
    pub method: Method,
    pub headers: HeaderMap,
    pub body: Option<serde_json::Value>,
    pub timeout: Duration,
}
pub trait Transport: Send + Sync {
    fn send(&self, request: Outbound<'_>) -> Result<Response>;
}
pub struct Network;
impl Transport for Network {
    fn send(&self, r: Outbound<'_>) -> Result<Response> {
        request(
            r.url,
            r.hosts,
            r.allow_private,
            r.method,
            r.headers,
            r.body,
            r.timeout,
        )
    }
}
