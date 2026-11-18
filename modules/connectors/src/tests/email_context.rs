//! Email context: live first with a small triage budget, saved triage reused, cache only for
//! transient failures, gaps for the rest.
use moss_connectors::email_context::{list, list_saved, TRIAGE_CAP};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

const SCOPES: [&str; 1] = ["https://www.googleapis.com/auth/gmail.modify"];

struct Script {
    setup: Value,
    live: Value,
    saved: Vec<Value>,
    /// Milliseconds the clock moves on every read.
    tick: i64,
    clock: Cell<i64>,
    calls: RefCell<Vec<String>>,
    fail_triage: bool,
}

impl Host for Script {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        let name = p["name"].as_str().unwrap_or("").to_string();
        self.calls.borrow_mut().push(format!("{port}.{resource}.{name}"));
        Ok(match (port, operation, resource) {
            ("context", "read", _) => {
                let at = self.clock.get();
                self.clock.set(at + self.tick);
                json!({"now": format!("2026-03-02T08:00:{:02}.{:03}Z", at / 1000, at % 1000)})
            }
            ("kv", "get", "connectors.context-setup") => self.setup.clone(),
            ("kv", "get", "connectors.live-gmail-list") => self.live[p["accountId"].as_str().unwrap()].clone(),
            ("api", _, "email") => match name.as_str() {
                "listSavedMessages" => json!(self.saved),
                "emailTriageContext" => json!({"today":"2026-03-02","ownAddresses":["me@example.test"]}),
                "triageMessage" if self.fail_triage => return Err(Error::new("model timed out")),
                "triageMessage" => json!({"summary":"Asks for a reply","signals":{
                    "importance":"high","confidence":0.9,
                    "actionability":{"category":"needs_reply","reason":"Asked a question"}}}),
                _ => return Err(Error::new("unexpected api")),
            },
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

fn account(id: &str, kind: &str, status: &str) -> Value {
    json!({"id":id,"providerId":kind,"providerType":kind,"providerDisplayName":kind,"status":status,"scopes":SCOPES})
}

fn msg(id: &str) -> Value {
    json!({"id":id,"threadId":format!("t-{id}"),"from":"Ann <ann@example.test>","to":["me@example.test"],
           "subject":format!("Subject {id}"),"snippet":"Can you reply?","receivedAt":"2026-03-02T07:00:00.000Z"})
}

fn row(id: &str, account: &str, signals: Value) -> Value {
    json!({"externalId":id,"cacheMessageId":format!("c-{id}"),"accountId":account,"sender":"Bob <bob@example.test>",
           "recipients":["me@example.test"],"subject":"Cached","snippet":"s","summary":"Saved summary",
           "signals":signals,"receivedAt":"2026-03-01T07:00:00.000Z","threadId":"t"})
}

fn script(accounts: Vec<Value>, live: Value, saved: Vec<Value>) -> Script {
    Script {
        setup: json!({"accounts":accounts,"grants":{}}),
        live,
        saved,
        tick: 0,
        clock: Cell::new(0),
        calls: RefCell::default(),
        fail_triage: false,
    }
}

fn count(h: &Script, what: &str) -> usize {
    h.calls.borrow().iter().filter(|c| c.contains(what)).count()
}

#[test]
fn a_message_already_triaged_in_the_cache_reuses_that_result() {
    let signals = json!({"importance":"high","confidence":0.8,"actionability":{"category":"needs_action","reason":"Due"}});
    let h = script(
        vec![account("g1", "google", "active")],
        json!({"g1":{"messages":[msg("m1")]}}),
        vec![row("m1", "g1", signals)],
    );
    let out = list(&h, &json!({})).unwrap();
    let item = &out["items"][0];
    assert_eq!(item["source"], "live");
    assert_eq!(item["actionability"], "needs_action");
    assert_eq!(item["cacheMessageId"], "c-m1");
    assert_eq!(count(&h, "triageMessage"), 0);
}

#[test]
fn new_live_mail_is_triaged_up_to_the_cap_and_the_rest_stays_untriaged() {
    let ids: Vec<Value> = (0..TRIAGE_CAP + 2).map(|i| msg(&format!("n{i}"))).collect();
    let h = script(vec![account("g1", "google", "active")], json!({"g1":{"messages":ids}}), vec![]);
    let out = list(&h, &json!({})).unwrap();
    assert_eq!(count(&h, "triageMessage"), TRIAGE_CAP);
    let triaged = out["items"].as_array().unwrap().iter().filter(|i| i["actionability"] == "needs_reply").count();
    assert_eq!(triaged, TRIAGE_CAP);
    assert!(out["items"].as_array().unwrap().iter().any(|i| i["actionability"] == "unknown" && i["summary"].is_null()));
}

#[test]
fn no_triage_starts_once_the_time_budget_is_spent() {
    let mut h = script(vec![account("g1", "google", "active")], json!({"g1":{"messages":[msg("a"),msg("b")]}}), vec![]);
    h.tick = 2000;
    let out = list(&h, &json!({})).unwrap();
    assert_eq!(count(&h, "triageMessage"), 0);
    assert_eq!(out["items"].as_array().unwrap().len(), 2);
}

#[test]
fn a_transient_failure_falls_back_to_that_accounts_cache_only() {
    let h = script(
        vec![account("g1", "google", "active")],
        json!({"g1":{"error":{"status":429}}}),
        vec![row("m1", "g1", json!({}))],
    );
    let out = list(&h, &json!({})).unwrap();
    assert_eq!(out["items"][0]["source"], "cache");
    assert_eq!(out["items"][0]["degradedReason"], "rate_limited");
    assert_eq!(out["accounts"][0]["degradedReason"], "rate_limited");
    assert_eq!(count(&h, "triageMessage"), 0);
}

#[test]
fn a_sign_in_failure_is_a_gap_and_never_stale_mail() {
    let h = script(
        vec![account("g1", "google", "active")],
        json!({"g1":{"result":"auth_failed"}}),
        vec![row("m1", "g1", json!({}))],
    );
    let out = list(&h, &json!({})).unwrap();
    assert!(out["items"].as_array().unwrap().is_empty());
    assert_eq!(out["gaps"][0]["reason"], "auth_error");
}

#[test]
fn revoked_off_and_unusable_accounts_are_gaps_without_a_read() {
    let mut h = script(
        vec![
            account("r", "google", "revoked"),
            account("o", "google", "active"),
            account("e", "google", "auth_failed"),
            account("x", "other", "active"),
        ],
        json!({}),
        vec![],
    );
    h.setup["grants"] = json!({"o":{"email":false}});
    let out = list(&h, &json!({})).unwrap();
    let reasons: Vec<&str> = out["gaps"].as_array().unwrap().iter().map(|g| g["reason"].as_str().unwrap()).collect();
    assert_eq!(reasons, ["connector_revoked", "feature_grant_disabled", "auth_error", "unsupported_provider"]);
    assert_eq!(count(&h, "live-gmail-list"), 0);
}

#[test]
fn imap_mail_comes_from_the_cache_without_a_live_read() {
    let h = script(vec![account("i1", "imap", "active")], json!({}), vec![row("m1", "i1", json!({}))]);
    let out = list(&h, &json!({})).unwrap();
    assert_eq!(out["items"][0]["source"], "cache");
    assert!(out["items"][0]["degradedReason"].is_null());
    assert_eq!(count(&h, "live-gmail-list"), 0);
}

#[test]
fn a_sign_in_code_message_reads_as_untriaged() {
    let h = script(
        vec![account("i1", "imap", "active")],
        json!({}),
        vec![row("m1", "i1", json!({"skipped":"otp","actionability":{"category":"needs_action"}}))],
    );
    let item = &list(&h, &json!({})).unwrap()["items"][0];
    assert_eq!(item["actionability"], "unknown");
    assert!(item["summary"].is_null());
}

#[test]
fn the_saved_context_never_reads_live_or_calls_the_model() {
    let signals = json!({"actionability":{"category":"fyi"}});
    let h = script(vec![account("g1", "google", "active")], json!({}), vec![row("m1", "g1", signals)]);
    let out = list_saved(&h, "g1").unwrap();
    assert_eq!(out["items"][0]["actionability"], "fyi");
    assert_eq!(count(&h, "live-gmail-list") + count(&h, "triageMessage"), 0);
}

#[test]
fn the_saved_context_reports_a_gap_for_a_revoked_account() {
    let h = script(vec![account("g1", "google", "revoked")], json!({}), vec![row("m1", "g1", json!({}))]);
    let out = list_saved(&h, "g1").unwrap();
    assert!(out["items"].as_array().unwrap().is_empty());
    assert_eq!(out["gaps"][0]["reason"], "connector_revoked");
}

#[test]
fn a_live_list_that_lost_every_message_read_falls_back_to_saved_mail() {
    let h = script(
        vec![account("g1", "google", "active")],
        json!({"g1":{"messages":[],"skipped":3}}),
        vec![row("m9", "g1", json!({}))],
    );
    let out = list(&h, &json!({})).unwrap();
    assert_eq!(out["items"][0]["source"], "cache");
    assert_eq!(out["items"][0]["degradedReason"], "live_read_incomplete");
    assert_eq!(out["accounts"][0]["source"], "cache");
}

#[test]
fn a_partial_or_paged_live_list_says_it_is_truncated() {
    for live in [json!({"messages":[msg("a")],"skipped":1}), json!({"messages":[msg("a")],"skipped":0,"more":true})] {
        let h = script(vec![account("g1", "google", "active")], json!({"g1":live}), vec![]);
        let out = list(&h, &json!({})).unwrap();
        assert_eq!(out["truncated"], true, "{out}");
        assert_eq!(out["items"][0]["source"], "live");
    }
}

#[test]
fn a_failing_triage_call_leaves_the_mail_untriaged_instead_of_failing_the_read() {
    let mut h = script(vec![account("g1", "google", "active")], json!({"g1":{"messages":[msg("n1")]}}), vec![]);
    h.fail_triage = true;
    let out = list(&h, &json!({})).unwrap();
    assert_eq!(out["items"].as_array().unwrap().len(), 1);
    assert_eq!(out["items"][0]["actionability"], "unknown");
}
