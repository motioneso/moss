//! Thread and monitor providers over a scripted host.
use moss_email::providers::{sanitize, sender_address};
use moss_email::handle;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

struct Script {
    reply: Value,
    calls: RefCell<Vec<(String, Value)>>,
}

impl Host for Script {
    fn call(&self, port: &str, _: &str, resource: &str, p: Value) -> Result<Value> {
        self.calls.borrow_mut().push((resource.to_string(), p));
        match port {
            "context" => Ok(json!({"now":"2026-03-02T08:00:00.000Z"})),
            "kv" => Ok(self.reply.clone()),
            _ => Err(Error::new("unexpected call")),
        }
    }
}

fn api(host: &Script, name: &str, parameters: Value) -> std::result::Result<Value, String> {
    let request = json!({"name":name,"parameters":parameters});
    handle(host, "api", &request.to_string()).map(|r| serde_json::from_str(&r).unwrap())
}

fn host(reply: Value) -> Script {
    Script { reply, calls: RefCell::default() }
}

#[test]
fn a_sender_header_reduces_to_a_lower_case_address() {
    assert_eq!(sender_address("Sarah Kim <Sarah@Kim.Example>"), "sarah@kim.example");
    assert_eq!(sender_address(" Bare@X.test "), "bare@x.test");
}

#[test]
fn thread_messages_mark_the_users_own_mail_and_cap_the_excerpt() {
    let row = json!({"externalId":"e1","cacheMessageId":"c1","sender":"Me <ME@x.test>","subject":"Hi",
        "receivedAt":"t","bodyExcerpt":"y".repeat(9000)});
    let h = host(json!([row]));
    let out = api(&h, "listThreadMessages", json!({"threadRef":"t1","userAddresses":["me@x.test"]})).unwrap();
    let m = &out["messages"][0];
    assert_eq!(m["fromIsUser"], true);
    assert_eq!(m["fromAddress"], "me@x.test");
    assert_eq!(m["bodyExcerpt"].as_str().unwrap().len(), 4000);
    assert!(api(&h, "listThreadMessages", json!({})).is_err());
}

#[test]
fn newer_threads_keep_the_thread_reference() {
    let row = json!({"threadRef":"t1","newest":{"externalId":"e2","sender":"a@x.test","subject":"S","receivedAt":"t"}});
    let out = api(&host(json!([row])), "listThreadsWithNewerMessages", json!({"threads":[]})).unwrap();
    assert_eq!(out["threads"][0]["threadRef"], "t1");
    assert_eq!(out["threads"][0]["newest"]["fromIsUser"], false);
}

fn recent(subject: &str, snippet: Option<&str>, hash: &str) -> Value {
    json!({"hash":hash,"subject":subject,"snippet":snippet,"summary":null,"receivedAt":"2026-03-01T10:00:00.000Z"})
}

#[test]
fn monitor_signals_pick_reply_and_urgent_mail_and_name_a_window() {
    let rows = json!([
        recent("Lunch menu", Some("Nothing here"), "h0"),
        recent("Can you review this", None, "h1"),
        recent("Contract", Some("URGENT: sign by Friday 5"), "h2"),
    ]);
    let h = host(rows);
    let out = api(&h, "collectMonitorSignals", json!({"accountIds":["a1"],"maxSignals":10})).unwrap();
    let signals = out["signals"].as_array().unwrap();
    assert_eq!(signals.len(), 2);
    assert_eq!(signals[0]["signalType"], "needs_reply_soon");
    assert_eq!(signals[0]["summary"], "Message likely needs a reply");
    assert_eq!(signals[0]["stableKey"], "email:h1");
    assert_eq!(signals[1]["signalType"], "time_sensitive_follow_up");
    assert_eq!(signals[1]["expiresAt"], "2026-03-08T10:00:00.000Z");
    let calls = h.calls.borrow();
    let read = calls.iter().find(|c| c.0 == "email.recent").unwrap();
    assert_eq!(read.1["since"], "2026-02-28T08:00:00.000Z");
}

#[test]
fn monitor_signals_stop_at_the_cap_and_need_accounts() {
    let rows = json!([recent("please reply", None, "a"), recent("please reply", None, "b")]);
    let out = api(&host(rows), "collectMonitorSignals", json!({"accountIds":["a1"],"maxSignals":1})).unwrap();
    assert_eq!(out["signals"].as_array().unwrap().len(), 1);
    let none = host(json!([]));
    assert_eq!(api(&none, "collectMonitorSignals", json!({"accountIds":[]})).unwrap()["signals"], json!([]));
    assert!(none.calls.borrow().is_empty());
}

#[test]
fn snippets_lose_credential_links_bearer_values_and_secret_lines() {
    let text = "see https://x.test/a?token=abc and https://ok.test/page\nBearer abcdef123\npassword: hunter2\nplain line";
    let clean = sanitize(text);
    assert!(clean.contains("[link removed]") && clean.contains("https://ok.test/page"));
    assert!(!clean.contains("abcdef123") && !clean.contains("hunter2") && !clean.contains("token=abc"));
    assert!(clean.contains("plain line"));
}
