//! The Outlook calendar routes and the reader job, on a scripted host. Page text never appears
//! here because the host hands the guest only normalized events and a bare error code.
use moss_connectors::{handle, outlook};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

const NOW: &str = "2026-10-21T18:00:00.000Z";

struct Stub {
    binding: RefCell<Value>,
    accounts: RefCell<Vec<Value>>,
    health: RefCell<Value>,
    steps: RefCell<Vec<Value>>,
    import: RefCell<Option<Value>>,
    log: RefCell<Vec<Value>>,
}

impl Stub {
    fn new(binding: Value) -> Self {
        Self {
            binding: RefCell::new(binding),
            accounts: RefCell::default(),
            health: RefCell::new(Value::Null),
            steps: RefCell::default(),
            import: RefCell::new(Some(json!({"unconfirmed":0}))),
            log: RefCell::default(),
        }
    }
    fn mine() -> Self {
        Self::new(json!({"available":true,"mine":true,"fingerprint":"fp-1"}))
    }
    fn with_account(self, status: &str, health: Value) -> Self {
        self.accounts.borrow_mut().push(json!({"id":"o1","providerId":"outlook-browser-calendar","status":status}));
        *self.health.borrow_mut() = health;
        self
    }
    fn calls(&self, resource: &str) -> Vec<Value> {
        self.log.borrow().iter().filter(|c| c["resource"] == resource).cloned().collect()
    }
    fn health(&self) -> Value {
        self.health.borrow().clone()
    }
}

impl Host for Stub {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        self.log.borrow_mut().push(json!({"port":port,"operation":operation,"resource":resource,"parameters":p}));
        Ok(match (port, operation, resource) {
            ("context", "read", _) => json!({"now":NOW}),
            ("context", _, _) => json!({"id":"run-1"}),
            ("jobs", _, _) => json!({"id":"job-1"}),
            ("api", _, "calendar") => match self.import.borrow().clone() {
                Some(done) => done,
                None => return Err(Error::new("import refused")),
            },
            ("kv", "get", "connectors.outlook-binding") => self.binding.borrow().clone(),
            ("kv", "get", "connectors.accounts") => json!(self.accounts.borrow().clone()),
            ("kv", "get", "connectors.context-setup") => {
                json!({"grants":{"o1":{"calendar":true}},"outlook":{"o1":self.health.borrow().clone()}})
            }
            ("kv", "set", "connectors.account-write") => {
                let mut rows = self.accounts.borrow_mut();
                if p["action"] == "create" {
                    rows.push(json!({"id":"o1","providerId":p["providerId"],"status":"active"}));
                } else if let Some(row) = rows.first_mut() {
                    row["status"] = if p["action"] == "revoke" { json!("revoked") } else { p["status"].clone() };
                }
                rows.first().cloned().unwrap_or(Value::Null)
            }
            ("kv", "set", "connectors.feature-grants") => json!({"saved":true}),
            ("kv", "set", "connectors.outlook-health") => {
                if let Some(run) = p["fenceRun"].as_str() {
                    if self.health.borrow()["currentRun"].as_str() != Some(run) {
                        return Ok(json!({"saved":false}));
                    }
                }
                *self.health.borrow_mut() = p["value"].clone();
                json!({"saved":true})
            }
            ("kv", "set", "connectors.outlook-scan") => {
                let mut steps = self.steps.borrow_mut();
                let step = if steps.is_empty() { json!({"done":false}) } else { steps.remove(0) };
                // Lets a test start a newer run while this step is in flight.
                if let Some(run) = step["replaceRun"].as_str() {
                    self.health.borrow_mut()["currentRun"] = json!(run);
                }
                step
            }
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

fn route(host: &Stub, method: &str, path: &str) -> (u64, Value) {
    let request = json!({"method":method,"path":path,"params":{},"body":Value::Null});
    let reply: Value = serde_json::from_str(&handle(host, "route", &request.to_string()).unwrap()).unwrap();
    (reply["status"].as_u64().unwrap(), reply["body"].clone())
}

fn job(host: &Stub, run: Option<&str>) -> Value {
    let mut parameters = json!({"account-id":"o1"});
    if let Some(run) = run {
        parameters["run-id"] = json!(run);
        parameters["begun"] = json!(true);
    }
    let payload = json!({"queue":outlook::QUEUE,"parameters":parameters});
    serde_json::from_str(&handle(host, "job", &payload.to_string()).unwrap()).unwrap()
}

fn current() -> Value {
    json!({"state":"current","lastCompleteAt":"2026-10-21T17:55:00.000Z","windowStart":"2026-10-20","windowEnd":"2026-11-22",
           "timeZone":"America/Los_Angeles","unconfirmed":0,"bindingFingerprint":"fp-1"})
}

#[test]
fn nobody_without_the_configured_helper_may_connect_refresh_or_disconnect() {
    for binding in [json!({"available":false}), json!({"available":true,"mine":false,"fingerprint":"fp-1"})] {
        let host = Stub::new(binding).with_account("active", current());
        for path in ["/outlook-calendar/connect", "/outlook-calendar/refresh", "/outlook-calendar/disconnect"] {
            let (status, body) = route(&host, "POST", path);
            assert_eq!(
                (status, body["error"].as_str()),
                (403, Some("No dedicated Outlook browser is configured for this account.")),
                "{path}"
            );
        }
        assert!(host.calls("connectors.account-write").is_empty());
        assert!(host.calls("outlook-calendar").is_empty());
    }
}

#[test]
fn a_changed_binding_stops_connect_and_refresh_with_a_conflict() {
    let host = Stub::new(json!({"available":true,"mine":true,"fingerprint":"fp-2"})).with_account("active", current());
    for path in ["/outlook-calendar/connect", "/outlook-calendar/refresh"] {
        let (status, body) = route(&host, "POST", path);
        assert_eq!(status, 409, "{path}");
        assert_eq!(body["error"], "Dedicated browser binding changed. Restore the configured source before reconnecting.");
    }
    assert!(host.calls("outlook-calendar").is_empty());
}

#[test]
fn refresh_before_connect_asks_to_connect_first() {
    let (status, body) = route(&Stub::mine(), "POST", "/outlook-calendar/refresh");
    assert_eq!((status, body["error"].as_str()), (409, Some("Connect Outlook calendar first.")));
}

#[test]
fn connect_makes_a_calendar_only_account_and_queues_a_run_with_ids_only() {
    let host = Stub::mine();
    let (status, body) = route(&host, "POST", "/outlook-calendar/connect");
    assert_eq!(status, 200);
    assert_eq!((body["connected"].clone(), body["state"].clone()), (json!(true), json!("collecting")));
    let grants = host.calls("connectors.feature-grants");
    assert_eq!(grants[0]["parameters"]["value"], json!({"calendar":true,"email":false}));
    let queued = host.calls("outlook-calendar");
    assert!(queued.iter().any(|c| c["operation"] == "enqueue-options"));
    for call in &queued {
        let text = call["parameters"].to_string();
        assert!(!text.contains("fp-1"), "{text}");
    }
    assert_eq!(host.health()["bindingFingerprint"], "fp-1");
}

#[test]
fn status_marks_old_or_stalled_copies_stale_and_other_people_get_no_availability() {
    let old = json!({"state":"current","lastCompleteAt":"2026-10-21T17:40:00.000Z"});
    assert_eq!(route(&Stub::mine().with_account("active", old), "GET", "/outlook-calendar").1["state"], "stale");
    let stalled = json!({"state":"collecting","attemptedAt":"2026-10-21T17:57:00.000Z"});
    assert_eq!(route(&Stub::mine().with_account("active", stalled), "GET", "/outlook-calendar").1["state"], "stale");
    let (_, body) = route(&Stub::new(json!({"available":true,"mine":false})), "GET", "/outlook-calendar");
    assert_eq!((body["available"].clone(), body["connected"].clone()), (json!(false), json!(false)));
    assert_eq!(route(&Stub::mine().with_account("active", current()), "GET", "/outlook-calendar").1["state"], "current");
}

#[test]
fn disconnect_revokes_and_marks_the_copy_disconnected() {
    let host = Stub::mine().with_account("active", current());
    let (status, body) = route(&host, "POST", "/outlook-calendar/disconnect");
    assert_eq!((status, body["connected"].clone()), (200, json!(false)));
    assert_eq!(host.health()["state"], "disconnected");
}

#[test]
fn a_run_walks_one_view_per_step_then_imports_and_marks_current() {
    let host = Stub::mine().with_account("active", json!({"state":"current","lastCompleteAt":"2026-10-21T00:00:00.000Z","bindingFingerprint":"fp-1"}));
    host.steps.borrow_mut().extend([
        json!({"done":false}),
        json!({"done":true,"scan":{"windowStart":"2026-10-20","windowEnd":"2026-11-22","timeZone":"America/Los_Angeles","events":[]}}),
    ]);
    assert_eq!(job(&host, None)["outcome"], "continued");
    let next = host.calls("outlook-calendar").into_iter().filter(|c| c["operation"] == "enqueue-options").last().unwrap();
    assert_eq!(next["parameters"]["params"], json!({"account-id":"o1","run-id":"run-1","begun":true}));
    assert_eq!(job(&host, Some("run-1"))["outcome"], "imported");
    let health = host.health();
    assert_eq!((health["state"].clone(), health["failures"].clone()), (json!("current"), json!(0)));
    assert_eq!(health["lastCompleteAt"], NOW);
    assert_eq!(host.calls("calendar").len(), 1);
}

#[test]
fn reader_errors_set_the_matching_state_and_three_failures_stop_the_job() {
    for (code, state) in [("sign-in-needed", "sign-in-needed"), ("source-changed", "source-changed"), ("partial", "partial"), ("unreachable", "partial")] {
        let host = Stub::mine().with_account("active", json!({"state":"collecting","currentRun":"run-1","bindingFingerprint":"fp-1"}));
        host.steps.borrow_mut().push(json!({"error":code,"stage":"read"}));
        assert_eq!(job(&host, Some("run-1"))["outcome"], "failed", "{code}");
        assert_eq!(host.health()["state"], state, "{code}");
        assert_eq!(host.health()["failures"], 1);
        assert!(host.calls("calendar").is_empty());
    }
    let host = Stub::mine().with_account("active", json!({"state":"partial","failures":3,"bindingFingerprint":"fp-1"}));
    assert_eq!(job(&host, None)["outcome"], "skipped");
    assert!(host.calls("connectors.outlook-scan").is_empty());
}

#[test]
fn a_failed_import_keeps_the_copy_partial() {
    let host = Stub::mine().with_account("active", json!({"state":"collecting","currentRun":"run-1","bindingFingerprint":"fp-1"}));
    *host.import.borrow_mut() = None;
    host.steps.borrow_mut().push(json!({"done":true,"scan":{"events":[]}}));
    assert_eq!(job(&host, Some("run-1"))["outcome"], "failed");
    assert_eq!(host.health()["state"], "partial");
}

#[test]
fn the_job_skips_when_the_binding_moved_or_the_account_is_off() {
    let host = Stub::new(json!({"available":true,"mine":true,"fingerprint":"fp-2"})).with_account("active", current());
    assert_eq!(job(&host, None)["outcome"], "skipped");
    assert_eq!(host.health()["state"], "source-changed");
    assert!(host.calls("connectors.outlook-scan").is_empty());
    let off = Stub::mine().with_account("revoked", current());
    assert_eq!(job(&off, None)["outcome"], "inactive");
}

#[test]
fn a_busy_run_is_left_alone() {
    let host = Stub::mine().with_account("active", json!({"state":"collecting","attemptedAt":"2026-10-21T17:59:00.000Z","bindingFingerprint":"fp-1"}));
    assert_eq!(job(&host, None)["outcome"], "busy");
    assert!(host.calls("connectors.outlook-scan").is_empty());
}

#[test]
fn nothing_the_guest_sends_to_the_queue_or_health_carries_page_text() {
    let host = Stub::mine().with_account("active", json!({"state":"collecting","bindingFingerprint":"fp-1"}));
    host.steps.borrow_mut().push(json!({"error":"partial","stage":"read","detail":"SENTINEL-PAGE-TEXT"}));
    job(&host, Some("run-1"));
    let seen = serde_json::to_string(&*host.log.borrow()).unwrap();
    for call in host.log.borrow().iter().filter(|c| c["operation"] != "get") {
        assert!(!call["parameters"].to_string().contains("SENTINEL"), "{call}");
    }
    assert!(seen.contains("run-1"));
}

#[test]
fn a_finished_scan_is_as_fresh_as_when_it_was_observed() {
    let host = Stub::mine().with_account("active", json!({"state":"collecting","currentRun":"run-1","bindingFingerprint":"fp-1"}));
    host.steps.borrow_mut().push(json!({"done":true,"scan":{"observedAt":"2026-10-21T17:40:00.000Z","windowStart":"2026-10-20","windowEnd":"2026-11-22","timeZone":"America/Los_Angeles","events":[]}}));
    assert_eq!(job(&host, Some("run-1"))["outcome"], "imported");
    assert_eq!(host.health()["lastCompleteAt"], "2026-10-21T17:40:00.000Z");
}

#[test]
fn a_run_that_a_newer_run_replaced_writes_nothing() {
    let host = Stub::mine().with_account("active", json!({"state":"collecting","currentRun":"run-2","bindingFingerprint":"fp-1"}));
    host.steps.borrow_mut().push(json!({"done":true,"scan":{"windowStart":"2026-10-20","windowEnd":"2026-11-22","timeZone":"America/Los_Angeles","events":[]}}));
    assert_eq!(job(&host, Some("run-1"))["outcome"], "superseded");
    assert!(host.calls("calendar").is_empty());
    assert_eq!(host.health()["state"], "collecting");
}

#[test]
fn a_run_replaced_while_its_last_step_ran_cannot_save_its_result() {
    let host = Stub::mine().with_account("active", json!({"state":"collecting","currentRun":"run-1","bindingFingerprint":"fp-1"}));
    host.steps.borrow_mut().push(json!({"done":true,"replaceRun":"run-2","scan":{"windowStart":"2026-10-20","windowEnd":"2026-11-22","timeZone":"America/Los_Angeles","events":[]}}));
    assert_eq!(job(&host, Some("run-1"))["outcome"], "superseded");
    assert_eq!(host.health()["currentRun"], "run-2");
    assert_eq!(host.health()["state"], "collecting");
}
