//! Runs the Outlook week walk for the host. The browser is a helper program on this machine that
//! answers a small JSON protocol over loopback HTTP. A run keeps its session between calls, one
//! week view per call, so each call stays inside the host's time budget. Replies hold only
//! normalized events or a bare error code, never page text.
use anyhow::Result;
use moss_connectors::outlook_scan::{fingerprint, Browser, Display, RawItem, Scan, Session, Step};
use moss_connectors::outlook_source::{Result as Read, SourceError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

const RUN_LIFETIME: Duration = Duration::from_secs(600);
const CALL_TIMEOUT: Duration = Duration::from_millis(1500);

/// The one person and Outlook account this machine's helper browser belongs to.
#[derive(Clone, Debug)]
pub struct OutlookBinding {
    pub endpoint: String,
    pub owner: Uuid,
    pub account: String,
}

impl OutlookBinding {
    /// Builds a binding only when the endpoint is a plain loopback address.
    pub fn new(endpoint: &str, owner: Uuid, account: &str) -> Option<Self> {
        let url = url::Url::parse(endpoint).ok()?;
        let loopback = matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]"));
        let plain = url.scheme() == "http"
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none();
        (loopback && plain && !account.trim().is_empty()).then(|| Self {
            endpoint: url.as_str().trim_end_matches('/').to_string(),
            owner,
            account: account.trim().to_string(),
        })
    }

    pub fn fingerprint(&self) -> String {
        fingerprint(&self.owner.to_string(), &self.account, &self.endpoint)
    }
}

struct Http {
    endpoint: String,
    client: reqwest::blocking::Client,
}

impl Http {
    fn call(&self, op: &str, args: Value) -> Read<Value> {
        let sent = self.client.post(&self.endpoint).json(&json!({"op":op,"args":args})).send();
        let body: Value = sent.ok().and_then(|r| r.json().ok()).ok_or(SourceError::new("partial"))?;
        match body["error"].as_str() {
            Some("sign-in-needed") => Err(SourceError::new("sign-in-needed")),
            Some("settings-not-found") => Err(SourceError::new("settings-not-found")),
            Some(_) => Err(SourceError::new("partial")),
            None => Ok(body["value"].clone()),
        }
    }

    fn text(&self, op: &str) -> Read<String> {
        self.call(op, json!({}))?.as_str().map(str::to_string).ok_or(SourceError::new("source-changed"))
    }
}

impl Browser for Http {
    fn account_address(&mut self) -> Read<String> {
        self.text("account-address")
    }
    fn display(&mut self) -> Read<Display> {
        let value = self.call("display", json!({}))?;
        match (value["timeZone"].as_str(), value["language"].as_str()) {
            (Some(time_zone), Some(language)) => {
                Ok(Display { time_zone: time_zone.into(), language: language.into() })
            }
            _ => Err(SourceError::new("source-changed")),
        }
    }
    fn primary_calendar_selected(&mut self) -> Read<bool> {
        Ok(self.call("primary-calendar", json!({}))? == true)
    }
    fn week_header(&mut self) -> Read<String> {
        self.text("week-header")
    }
    fn read_week(&mut self) -> Read<Vec<RawItem>> {
        let rows = self.call("read-week", json!({}))?;
        rows.as_array()
            .ok_or(SourceError::new("source-changed"))?
            .iter()
            .map(|r| match (r["id"].as_str(), r["label"].as_str()) {
                (Some(id), Some(label)) => Ok(RawItem { id: id.into(), label: label.into() }),
                _ => Err(SourceError::new("source-changed")),
            })
            .collect()
    }
    fn step_week(&mut self, forward: bool) -> Read<()> {
        self.call("step-week", json!({"forward":forward})).map(|_| ())
    }
    fn interrupted(&mut self) -> bool {
        self.call("interrupted", json!({})).map_or(true, |v| v != false)
    }
}

impl Drop for Http {
    fn drop(&mut self) {
        let _ = self.call("close", json!({}));
    }
}

struct Run {
    session: Session,
    browser: Http,
    started: Instant,
}

#[derive(Default)]
pub struct OutlookRuns(Mutex<HashMap<Uuid, Run>>);

/// What the package learns about the helper: whether one is set up, and whether it is this
/// person's. The fingerprint carries no account address or endpoint.
pub fn binding(binding: &Option<OutlookBinding>, actor: Uuid) -> Value {
    match binding {
        Some(b) => json!({"available":true,"mine":b.owner == actor,"fingerprint":b.fingerprint()}),
        None => json!({"available":false,"mine":false,"fingerprint":null}),
    }
}

/// Reads one view for a run, starting the run on its first call. The blocking client is built,
/// used and dropped where blocking is allowed, never on an async worker.
pub async fn step(
    binding: &Option<OutlookBinding>,
    runs: &OutlookRuns,
    actor: Uuid,
    run_id: Uuid,
) -> Result<Value> {
    tokio::task::block_in_place(|| step_blocking(binding, runs, actor, run_id))
}

fn step_blocking(
    binding: &Option<OutlookBinding>,
    runs: &OutlookRuns,
    actor: Uuid,
    run_id: Uuid,
) -> Result<Value> {
    let Some(b) = binding.clone().filter(|b| b.owner == actor) else {
        return Ok(json!({"error":"source-changed","stage":"binding"}));
    };
    let mut run = {
        let mut held = runs.0.lock().expect("runs");
        held.retain(|_, r| r.started.elapsed() < RUN_LIFETIME);
        held.remove(&run_id)
    }
    .unwrap_or_else(|| Run {
        session: Session::new(&b.account, chrono::Utc::now()),
        browser: Http {
            endpoint: b.endpoint.clone(),
            client: reqwest::blocking::Client::builder().timeout(CALL_TIMEOUT).build().expect("client"),
        },
        started: Instant::now(),
    });
    Ok(match run.session.step(&mut run.browser) {
        Ok(Step::More) => {
            runs.0.lock().expect("runs").insert(run_id, run);
            json!({"done":false})
        }
        Ok(Step::Done(scan)) => json!({"done":true,"scan":scan_json(&scan)}),
        Err(e) => json!({"error":e.code,"stage":e.stage}),
    })
}

fn scan_json(scan: &Scan) -> Value {
    serde_json::to_value(scan).expect("scan")
}
