//! Proactive monitors: schedules per account, health rows, metadata-only job payloads.
use moss_connectors::monitors::{cancel, handle, reconcile};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

const SCOPES: [&str; 2] = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar"];
const SECRET: &str = "SENTINEL-mail-text-and-token";

struct Script {
    setup: Value,
    saved: Vec<Value>,
    live_calendar: Value,
    calls: RefCell<Vec<(String, String, Value)>>,
}

impl Host for Script {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        self.calls.borrow_mut().push((format!("{port}.{operation}"), resource.to_string(), p.clone()));
        Ok(match (port, operation, resource) {
            ("context", "read", _) => json!({"now":"2026-03-02T08:00:00.000Z"}),
            ("kv", "get", "connectors.context-setup") => self.setup.clone(),
            ("kv", "get", "connectors.live-calendar") => self.live_calendar.clone(),
            ("kv", "set", "connectors.monitor-status") => json!({"saved":true}),
            ("api", _, "email") => json!(self.saved),
            ("api", _, "calendar") => json!({"events":[]}),
            ("jobs", "schedule", _) => json!({"id":"row-1"}),
            ("jobs", "unschedule", _) => json!({}),
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

fn script(status: &str, saved: Vec<Value>, live_calendar: Value) -> Script {
    Script {
        setup: json!({"accounts":[{"id":"a1","providerId":"google","providerType":"google","providerDisplayName":"Google",
            "status":status,"scopes":SCOPES}],"grants":{},"timezone":"UTC"}),
        saved,
        live_calendar,
        calls: RefCell::default(),
    }
}

fn row(category: &str) -> Value {
    json!({"externalId":"m","cacheMessageId":"c","accountId":"a1","sender":SECRET,"recipients":[],"subject":SECRET,
           "snippet":SECRET,"summary":SECRET,"signals":{"actionability":{"category":category}},
           "receivedAt":"2026-03-02T07:00:00.000Z","threadId":"t"})
}

fn job(queue: &str) -> String {
    json!({"queue":queue,"parameters":{"account-id":"a1"}}).to_string()
}

fn status_row(h: &Script) -> Value {
    let calls = h.calls.borrow();
    calls.iter().find(|c| c.1 == "connectors.monitor-status").unwrap().2["record"].clone()
}

#[test]
fn google_accounts_get_both_monitors_and_mail_accounts_only_the_email_one() {
    let h = script("active", vec![], json!({}));
    reconcile(&h, "a1", true);
    reconcile(&h, "a1", false);
    let calls = h.calls.borrow();
    let rows: Vec<(&str, &str)> = calls.iter().map(|c| (c.1.as_str(), c.2["cron"].as_str().unwrap())).collect();
    assert_eq!(rows, [("email-monitor", "*/15 * * * *"), ("calendar-monitor", "*/30 * * * *"), ("email-monitor", "*/15 * * * *")]);
    assert!(calls.iter().all(|c| c.2["key"] == "a1" && c.2["params"] == json!({"account-id":"a1"})));
}

#[test]
fn cancelling_removes_each_monitor_row() {
    let h = script("active", vec![], json!({}));
    cancel(&h, "a1", true);
    let removed = h.calls.borrow().iter().filter(|c| c.0 == "jobs.unschedule").count();
    assert_eq!(removed, 2);
}

#[test]
fn the_email_check_counts_actionable_mail_and_records_a_health_row() {
    let h = script("active", vec![row("needs_reply"), row("fyi"), row("needs_action")], json!({}));
    let out: Value = serde_json::from_str(&handle(&h, &job("email-monitor")).unwrap()).unwrap();
    assert_eq!(out["planned"], 2);
    let record = status_row(&h);
    assert_eq!(record["status"], "degraded");
    assert_eq!(record["planned"], 2);
    assert_eq!(record["created"], 0);
    assert_eq!(record["lastRunAt"], "2026-03-02T08:00:00.000Z");
}

#[test]
fn a_revoked_account_records_a_gap() {
    let h = script("revoked", vec![row("needs_reply")], json!({}));
    handle(&h, &job("email-monitor")).unwrap();
    assert_eq!(status_row(&h)["status"], "gap");
    assert_eq!(status_row(&h)["planned"], 0);
}

#[test]
fn the_calendar_check_is_ok_after_a_live_read_and_degraded_after_a_fallback() {
    let live = script("active", vec![], json!({"events":[]}));
    handle(&live, &job("calendar-monitor")).unwrap();
    assert_eq!(status_row(&live)["status"], "ok");
    let down = script("active", vec![], json!({"error":{"status":503}}));
    handle(&down, &job("calendar-monitor")).unwrap();
    assert_eq!(status_row(&down)["status"], "degraded");
}

#[test]
fn mail_text_never_reaches_the_health_row_or_a_job_payload() {
    let h = script("active", vec![row("needs_reply")], json!({}));
    let result = handle(&h, &job("email-monitor")).unwrap();
    assert!(!result.contains(SECRET));
    reconcile(&h, "a1", true);
    let calls = h.calls.borrow();
    for call in calls.iter().filter(|c| c.0 == "jobs.schedule" || c.1 == "connectors.monitor-status") {
        assert!(!call.2.to_string().contains(SECRET));
    }
}

#[test]
fn an_unknown_queue_or_bad_payload_is_refused() {
    let h = script("active", vec![], json!({}));
    assert!(handle(&h, &job("other")).is_err());
    assert!(handle(&h, "{}").is_err());
}
