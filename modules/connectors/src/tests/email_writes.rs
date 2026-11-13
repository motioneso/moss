//! Reply tools: derived recipient and thread, approval version, plain failures.
use moss_connectors::email_writes::{prepare, run};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

struct Script {
    original: Value,
    accounts: Value,
    grants: Value,
    wrote: Value,
    calls: RefCell<Vec<(String, Value)>>,
}

impl Host for Script {
    fn call(&self, port: &str, _: &str, resource: &str, p: Value) -> Result<Value> {
        self.calls.borrow_mut().push((resource.to_string(), p));
        Ok(match (port, resource) {
            ("api", "email") => self.original.clone(),
            ("kv", "connectors.context-setup") => json!({"accounts":self.accounts,"grants":self.grants}),
            ("kv", _) => self.wrote.clone(),
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

const MODIFY: &str = "https://www.googleapis.com/auth/gmail.modify";

fn google(original: Value) -> Script {
    Script {
        original,
        accounts: json!([{"id":"g1","providerId":"google","providerType":"google","status":"active","scopes":[MODIFY]}]),
        grants: json!({}),
        wrote: json!({"result":"ok"}),
        calls: RefCell::default(),
    }
}

fn imap(original: Value) -> Script {
    let mut h = google(original);
    h.accounts = json!([{"id":"g1","providerId":"imap-fastmail","providerType":"imap","status":"active","scopes":["email.read"]}]);
    h
}

fn message() -> Value {
    json!({"accountId":"g1","sender":"Ann Lee <ann@example.com>","subject":"Lunch?","threadId":"t-9",
           "messageId":"m3@x","references":["m1@x","m2@x"]})
}

fn input(body: &str) -> Value {
    json!({"cacheMessageId":"c1","body":body})
}

fn version(h: &Script) -> String {
    version_of(h, "Yes please")
}

fn written(h: &Script) -> (String, Value) {
    h.calls.borrow().iter().rev().find(|c| c.0.starts_with("connectors.write-")).cloned().expect("a write")
}

fn version_of(h: &Script, body: &str) -> String {
    prepare(h, &input(body)).unwrap()["version"].as_str().unwrap().to_string()
}

#[test]
fn a_google_reply_goes_to_the_original_sender_on_the_same_thread() {
    let h = google(message());
    let v = version(&h);
    let out = run(&h, true, &input("Yes please"), Some(&v)).unwrap();
    assert_eq!(out["data"], json!({"ok":true,"mode":"sent"}));
    let (resource, p) = written(&h);
    assert_eq!(resource, "connectors.write-gmail-send");
    assert_eq!(p["threadId"], "t-9");
    let mime = p["mime"].as_str().unwrap();
    assert!(mime.contains("To: Ann Lee <ann@example.com>\r\n"));
    assert!(mime.contains("Subject: Re: Lunch?\r\n"));
    assert!(mime.contains("In-Reply-To: <m3@x>\r\n"));
    assert!(mime.contains("References: <m1@x> <m2@x> <m3@x>\r\n"));
    assert!(mime.ends_with("\r\n\r\nYes please"));
}

#[test]
fn an_imap_reply_threads_on_the_first_reference_and_names_the_bare_address() {
    let h = imap(message());
    let v = version_of(&h, "Ok");
    run(&h, true, &input("Ok"), Some(&v)).unwrap();
    let (resource, p) = written(&h);
    assert_eq!(resource, "connectors.write-imap-send");
    assert_eq!(p["to"], "ann@example.com");
    assert!(p.get("threadId").is_none());
}

#[test]
fn an_imap_message_with_no_references_threads_on_its_own_id() {
    let mut m = message();
    m["references"] = json!([]);
    m["threadId"] = Value::Null;
    let h = imap(m);
    let v = version_of(&h, "Ok");
    let out = run(&h, true, &input("Ok"), Some(&v)).unwrap();
    assert_eq!(out["data"]["ok"], true, "{out}");
}

#[test]
fn a_subject_already_starting_with_re_is_kept() {
    let mut m = message();
    m["subject"] = json!("RE: Lunch?");
    let h = google(m);
    run(&h, false, &input("Ok"), None).unwrap();
    assert!(written(&h).1["mime"].as_str().unwrap().contains("Subject: RE: Lunch?\r\n"));
}

#[test]
fn line_breaks_in_original_headers_never_reach_the_message() {
    let mut m = message();
    m["subject"] = json!("Hi\r\nBcc: spy@example.com");
    m["sender"] = json!("ann@example.com\r\nBcc: spy@example.com");
    let h = google(m);
    run(&h, false, &input("Ok"), None).unwrap();
    let mime = written(&h).1["mime"].as_str().unwrap().to_string();
    assert!(!mime.contains("\r\nBcc:"));
}

#[test]
fn a_draft_needs_no_approval_and_uses_the_draft_call() {
    let h = google(message());
    let out = run(&h, false, &input("Maybe"), None).unwrap();
    assert_eq!(out["data"], json!({"ok":true,"mode":"drafted"}));
    assert_eq!(written(&h).0, "connectors.write-gmail-draft");
    let h = imap(message());
    run(&h, false, &input("Maybe"), None).unwrap();
    assert_eq!(written(&h).0, "connectors.write-imap-draft");
}

#[test]
fn a_send_without_the_approved_version_writes_nothing() {
    let h = google(message());
    for approved in [None, Some("stale")] {
        let out = run(&h, true, &input("Yes"), approved).unwrap();
        assert_eq!(out["data"]["ok"], false);
    }
    assert!(h.calls.borrow().iter().all(|c| !c.0.starts_with("connectors.write-")));
}

#[test]
fn editing_the_body_after_approval_changes_the_version() {
    let h = google(message());
    let v = version(&h);
    let out = run(&h, true, &input("Yes please, and bring snacks"), Some(&v)).unwrap();
    assert_eq!(out["data"]["ok"], false);
    assert!(h.calls.borrow().iter().all(|c| !c.0.starts_with("connectors.write-")));
}

#[test]
fn the_model_cannot_choose_the_recipient() {
    let h = google(message());
    let v = version(&h);
    let mut p = input("Yes please");
    p["to"] = json!("attacker@example.com");
    p["threadId"] = json!("other");
    run(&h, true, &p, Some(&v)).unwrap();
    let (_, w) = written(&h);
    assert!(!w["mime"].as_str().unwrap().contains("attacker"));
    assert_eq!(w["threadId"], "t-9");
}

#[test]
fn failures_are_plain_and_never_retried() {
    let cases = [
        (json!({"result":"auth_failed"}), "Couldn't refresh your Google access — reconnect in Settings."),
        (json!({"result":"inactive"}), "Connect Google in Settings first."),
        (json!({"result":"failed","error":{"status":500}}), "Couldn't send your reply right now — try again."),
    ];
    for (wrote, message) in cases {
        let mut h = google(message_value());
        h.wrote = wrote;
        let v = version(&h);
        let out = run(&h, true, &input("Yes please"), Some(&v)).unwrap();
        assert_eq!(out["data"], json!({"ok":false,"mode":"sent","message":message}));
        assert_eq!(h.calls.borrow().iter().filter(|c| c.0.starts_with("connectors.write-")).count(), 1);
    }
}

fn message_value() -> Value {
    message()
}

#[test]
fn refusals_say_why() {
    let mut gone = google(Value::Null);
    gone.original = Value::Null;
    let out = run(&gone, false, &input("x"), None).unwrap();
    assert_eq!(out["data"]["message"], "That message isn't in your inbox anymore — it may have been removed.");

    let mut h = google(message());
    h.accounts = json!([{"id":"g1","providerType":"google","status":"active","scopes":["email.read"]}]);
    assert_eq!(
        run(&h, false, &input("x"), None).unwrap()["data"]["message"],
        "Your Google connection doesn't have send permission yet — reconnect in Settings to grant it."
    );

    let mut h = google(message());
    h.grants = json!({"g1":{"email":false}});
    assert_eq!(
        run(&h, false, &input("x"), None).unwrap()["data"]["message"],
        "Email access is disabled for this account in Settings."
    );

    let mut h = google(message());
    h.accounts = json!([{"id":"g1","providerType":"outlook","status":"active","scopes":[]}]);
    assert_eq!(
        run(&h, false, &input("x"), None).unwrap()["data"]["message"],
        "Replies aren't supported for this account yet."
    );

    let mut m = message();
    m["threadId"] = Value::Null;
    let h = google(m);
    assert_eq!(
        run(&h, false, &input("x"), None).unwrap()["data"]["message"],
        "Couldn't find the original conversation to reply to."
    );
}

#[test]
fn an_empty_body_is_a_bad_request() {
    let h = google(message());
    assert_eq!(run(&h, false, &input("   "), None).unwrap_err().status, 400);
}

#[test]
fn the_card_shows_what_will_be_sent_and_grants_nothing() {
    let h = google(message());
    let card = prepare(&h, &input("Yes please")).unwrap();
    assert_eq!(card["content"], "user_authored");
    assert_eq!(card["target"], "ann@example.com");
    assert_eq!(card["fields"][1], json!({"label":"Subject","value":"Re: Lunch?"}));
    assert!(h.calls.borrow().iter().all(|c| !c.0.starts_with("connectors.write-")));
}

#[test]
fn non_ascii_subjects_are_encoded() {
    let mut m = message();
    m["subject"] = json!("Café");
    let h = google(m);
    run(&h, false, &input("Ok"), None).unwrap();
    let mime = written(&h).1["mime"].as_str().unwrap().to_string();
    assert!(mime.contains("Subject: =?UTF-8?B?UmU6IENhZsOp?=\r\n"), "{mime}");
}
