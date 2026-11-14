//! One render: start the browser, open one page, answer each of its requests through the host's
//! safe fetch, and return bounded evidence.
//!
//! The browser has no network, so a request nobody answers fails. Every page request is paused
//! by the debugging protocol's fetch interception and either answered from the safe fetch or
//! refused here. The caps are enforced on the paused requests before any fetch starts.
use super::{
    cdp::{Connection, Writer},
    evidence::{self, Evidence},
    launch::Launcher,
    Reason, MAX_AGGREGATE_BYTES, MAX_CONCURRENT, MAX_REQUESTS, MAX_RESPONSE_BYTES,
};
use crate::public_web::PublicWeb;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use url::Url;

/// Request kinds the browser may make. Images, fonts, media, sockets and the rest are refused.
const ALLOWED_TYPES: &[&str] = &["Document", "Fetch", "XHR", "Script", "Stylesheet"];
/// How long the page must be quiet before it counts as settled.
const QUIET: Duration = Duration::from_millis(400);
/// Time kept back for reading the page after it settles.
const READ_TIME: Duration = Duration::from_secs(2);
const STARTUP: Duration = Duration::from_secs(10);

pub struct Page {
    pub url: Url,
    pub allowed_hosts: Vec<String>,
    pub deadline: Instant,
}

pub struct Rendered {
    pub final_url: String,
    pub evidence: Evidence,
    pub requests: usize,
}

struct Job {
    id: String,
    session: Option<String>,
    url: String,
    kind: String,
    accept: Option<String>,
}

struct Shared {
    web: Arc<PublicWeb>,
    writer: Writer,
    allowed: Vec<String>,
    deadline: Instant,
    started: Instant,
    bytes: AtomicUsize,
    inflight: AtomicUsize,
    last_activity_ms: AtomicU64,
    /// The top-level document: its final address, or `Err` if it could not be fetched.
    document: Mutex<Option<Result<String, ()>>>,
}

impl Shared {
    fn touch(&self) {
        self.last_activity_ms
            .store(self.started.elapsed().as_millis() as u64, Ordering::SeqCst);
    }
    fn refuse(&self, job: &Job, reason: &str) {
        let _ = self.writer.send(
            "Fetch.failRequest",
            json!({"requestId":job.id,"errorReason":reason}),
            job.session.as_deref(),
        );
    }
    fn serve(&self, job: &Job) {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let mut params = json!({
            "url": job.url,
            "allowedHosts": self.allowed,
            "maxBytes": MAX_RESPONSE_BYTES,
            "timeoutMs": remaining.as_millis().min(8000) as u64,
            "encoding": "base64",
            "rejectOversizedResponses": true,
        });
        if let Some(accept) = job.accept.as_ref().filter(|a| a.len() <= 200 && a.is_ascii()) {
            params["accept"] = json!(accept);
        }
        let answer = self.web.fetch_for_browser(&params, remaining);
        let body = answer.get("body").and_then(Value::as_str).unwrap_or("");
        let size = body.len() / 4 * 3;
        let fits = self.bytes.fetch_add(size, Ordering::SeqCst) + size <= MAX_AGGREGATE_BYTES;
        let good = answer["ok"] == true && fits;
        if job.kind == "Document" {
            let mut slot = self.document.lock().expect("document slot");
            if slot.is_none() {
                *slot = Some(if good {
                    Ok(answer["finalUrl"].as_str().unwrap_or(&job.url).to_owned())
                } else {
                    Err(())
                });
            }
        }
        if good {
            let content_type = answer["contentType"].as_str().unwrap_or(if job.kind == "Document" {
                "text/html"
            } else {
                "application/octet-stream"
            });
            let _ = self.writer.send(
                "Fetch.fulfillRequest",
                json!({
                    "requestId": job.id,
                    "responseCode": answer["status"].as_u64().unwrap_or(200),
                    "responseHeaders": [{"name":"Content-Type","value":content_type}],
                    "body": body,
                }),
                job.session.as_deref(),
            );
        } else {
            self.refuse(job, "ConnectionFailed");
        }
    }
}

/// Opens the page and returns what it shows. Never returns page content other than evidence.
pub fn render(
    launcher: &Launcher,
    web: &Arc<PublicWeb>,
    page: &Page,
) -> std::result::Result<Rendered, Reason> {
    let mut process = launcher.start().map_err(|_| Reason::Unsupported)?;
    let (Some(to), Some(from)) = (process.to_browser.take(), process.from_browser.take()) else {
        return Err(Reason::Unsupported);
    };
    let mut conn = Connection::new(to, from);
    let started = Instant::now();
    // A browser that cannot get its namespace or sandbox exits without answering.
    let startup = (started + STARTUP).min(page.deadline);
    if conn
        .call("Browser.getVersion", json!({}), None, startup)
        .is_err()
    {
        return Err(if process.exited() {
            Reason::Unsupported
        } else {
            Reason::Timeout
        });
    }
    let writer = conn.writer.clone();
    let shared = Arc::new(Shared {
        web: web.clone(),
        writer: writer.clone(),
        allowed: page.allowed_hosts.clone(),
        deadline: page.deadline,
        started,
        bytes: AtomicUsize::new(0),
        inflight: AtomicUsize::new(0),
        last_activity_ms: AtomicU64::new(0),
        document: Mutex::new(None),
    });
    let (jobs, queue) = mpsc::channel::<Job>();
    let queue = Arc::new(Mutex::new(queue));
    for _ in 0..MAX_CONCURRENT {
        let (shared, queue) = (shared.clone(), queue.clone());
        std::thread::spawn(move || loop {
            let job = match queue.lock().map(|q| q.recv()) {
                Ok(Ok(job)) => job,
                _ => break,
            };
            shared.serve(&job);
            shared.inflight.fetch_sub(1, Ordering::SeqCst);
            shared.touch();
        });
    }
    let result = drive(&mut conn, &shared, &jobs, page);
    // Closing the queue ends the workers. Dropping the process kills the browser.
    drop(jobs);
    let _ = writer.send("Browser.close", json!({}), None);
    result
}

fn drive(
    conn: &mut Connection,
    shared: &Arc<Shared>,
    jobs: &mpsc::Sender<Job>,
    page: &Page,
) -> std::result::Result<Rendered, Reason> {
    let failed = |_| Reason::RenderFailed;
    let timed = |_| Reason::Timeout;
    let deadline = page.deadline;
    conn.call(
        "Browser.setDownloadBehavior",
        json!({"behavior":"deny"}),
        None,
        deadline,
    )
    .map_err(failed)?;
    let target = conn
        .call("Target.createTarget", json!({"url":"about:blank"}), None, deadline)
        .map_err(failed)?;
    let target_id = target["targetId"].as_str().ok_or(Reason::RenderFailed)?.to_owned();
    let attached = conn
        .call(
            "Target.attachToTarget",
            json!({"targetId":target_id,"flatten":true}),
            None,
            deadline,
        )
        .map_err(failed)?;
    let session = attached["sessionId"]
        .as_str()
        .ok_or(Reason::RenderFailed)?
        .to_owned();
    let s = Some(session.as_str());
    for (method, params) in [
        ("Page.enable", json!({})),
        // Child frames and workers join this connection paused, so they are intercepted too.
        (
            "Target.setAutoAttach",
            json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
        ),
        ("Network.enable", json!({})),
        ("Network.setBypassServiceWorker", json!({"bypass":true})),
        ("Fetch.enable", json!({"patterns":[{"urlPattern":"*"}]})),
    ] {
        conn.call(method, params, s, deadline).map_err(failed)?;
    }
    // Sent without waiting: the answer comes only after the document request is served.
    conn.writer
        .send("Page.navigate", json!({"url":page.url.as_str()}), s)
        .map_err(failed)?;

    let settle_by = deadline - READ_TIME.min(deadline.saturating_duration_since(Instant::now()));
    let mut loaded = false;
    let mut count = 0usize;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(Reason::Timeout);
        }
        if matches!(*shared.document.lock().expect("document slot"), Some(Err(()))) {
            return Err(Reason::RenderFailed);
        }
        let quiet_for = now
            .duration_since(shared.started)
            .saturating_sub(Duration::from_millis(shared.last_activity_ms.load(Ordering::SeqCst)));
        if loaded
            && ((shared.inflight.load(Ordering::SeqCst) == 0 && quiet_for >= QUIET)
                || now >= settle_by)
        {
            break;
        }
        let Some(event) = conn.next_event(Duration::from_millis(50)).map_err(failed)? else {
            continue;
        };
        let event_session = event["sessionId"].as_str().map(str::to_owned);
        let params = &event["params"];
        match event["method"].as_str().unwrap_or("") {
            "Page.loadEventFired" if event_session.as_deref() == s => loaded = true,
            "Inspector.targetCrashed" => return Err(Reason::RenderFailed),
            "Fetch.requestPaused" => {
                shared.touch();
                count += 1;
                let job = Job {
                    id: params["requestId"].as_str().unwrap_or("").to_owned(),
                    session: event_session,
                    url: params["request"]["url"].as_str().unwrap_or("").to_owned(),
                    kind: params["resourceType"].as_str().unwrap_or("").to_owned(),
                    accept: params["request"]["headers"]["Accept"]
                        .as_str()
                        .map(str::to_owned),
                };
                let method = params["request"]["method"].as_str().unwrap_or("");
                if count > MAX_REQUESTS
                    || !ALLOWED_TYPES.contains(&job.kind.as_str())
                    || method != "GET"
                    || !approved(&job.url, &page.allowed_hosts)
                {
                    shared.refuse(&job, "BlockedByClient");
                } else {
                    shared.inflight.fetch_add(1, Ordering::SeqCst);
                    if jobs.send(job).is_err() {
                        return Err(Reason::RenderFailed);
                    }
                }
            }
            "Target.attachedToTarget" => {
                let child = params["sessionId"].as_str().unwrap_or("");
                match params["targetInfo"]["type"].as_str().unwrap_or("") {
                    // A second page, such as a popup, is closed at once.
                    "page" => {
                        let _ = conn.writer.send(
                            "Target.closeTarget",
                            json!({"targetId":params["targetInfo"]["targetId"]}),
                            None,
                        );
                    }
                    _ => {
                        let _ = conn.writer.send(
                            "Fetch.enable",
                            json!({"patterns":[{"urlPattern":"*"}]}),
                            Some(child),
                        );
                        let _ = conn.writer.send("Runtime.runIfWaitingForDebugger", json!({}), Some(child));
                    }
                }
            }
            _ => {}
        }
    }

    let tree = conn
        .call("Page.getFrameTree", json!({}), s, deadline)
        .map_err(timed)?;
    let frame = tree["frameTree"]["frame"]["id"].as_str().ok_or(Reason::RenderFailed)?;
    let world = conn
        .call(
            "Page.createIsolatedWorld",
            json!({"frameId":frame,"worldName":"moss-evidence"}),
            s,
            deadline,
        )
        .map_err(timed)?;
    let read = conn
        .call(
            "Runtime.evaluate",
            json!({
                "expression": evidence::SCRIPT,
                "contextId": world["executionContextId"],
                "returnByValue": true,
                "timeout": 1500,
            }),
            s,
            deadline,
        )
        .map_err(timed)?;
    let raw = read["result"]["value"].as_str().ok_or(Reason::RenderFailed)?;
    let evidence = evidence::parse(raw, &page.allowed_hosts).ok_or(Reason::RenderFailed)?;
    let final_url = match shared.document.lock().expect("document slot").clone() {
        Some(Ok(url)) if approved(&url, &page.allowed_hosts) => url,
        _ => return Err(Reason::RenderFailed),
    };
    Ok(Rendered {
        final_url,
        evidence,
        requests: count,
    })
}

/// HTTPS, the standard port, no password, and a host the caller named.
pub(super) fn approved(url: &str, allowed: &[String]) -> bool {
    let Ok(url) = Url::parse(url) else { return false };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url
            .host_str()
            .is_some_and(|h| allowed.iter().any(|a| a.eq_ignore_ascii_case(h)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_on_the_standard_port_to_named_hosts_is_approved() {
        let allowed = vec!["ok.test".to_string()];
        assert!(approved("https://ok.test/a?b=1", &allowed));
        for bad in [
            "http://ok.test/",
            "https://ok.test:8443/",
            "https://u:p@ok.test/",
            "https://other.test/",
            "https://ok.test.evil.test/",
            "data:text/html,hi",
            "ws://ok.test/",
            "not a url",
        ] {
            assert!(!approved(bad, &allowed), "{bad}");
        }
    }
}
