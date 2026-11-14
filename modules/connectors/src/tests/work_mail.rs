//! Work mail capture: cursor, private notes, judgement rules and the pipeline
//! reaching Notes only through its public API.
use moss_connectors::work_mail::{capture, is_private_note, parse_cursor, validate_judgement};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

const SENTINEL: &str = "SENTINEL-WORKMAIL-BODY-7f31";

struct Fake {
    cursor: RefCell<Value>,
    judgement: String,
    appends: RefCell<Vec<Value>>,
    prompts: RefCell<Vec<String>>,
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        Ok(match (port, operation, resource) {
            ("context", "uuid", "new") => json!({"id": "00000000-0000-4000-8000-000000000001"}),
            ("kv", "get", "connectors.work-mail-cursor") => self.cursor.borrow().clone(),
            ("kv", "set", "connectors.work-mail-cursor") => {
                *self.cursor.borrow_mut() = p;
                json!({"saved": true})
            }
            ("ai", "generate", "structured") => {
                self.prompts.borrow_mut().push(p["prompt"].as_str().unwrap_or("").to_string());
                json!({"text": self.judgement})
            }
            ("api", "call", "notes") => match p["name"].as_str().unwrap_or("") {
                "listWorkMailCandidates" => json!({"candidates": []}),
                "appendWorkMailNote" => {
                    self.appends.borrow_mut().push(p["parameters"].clone());
                    json!({"result": "written"})
                }
                _ => return Err(Error::new("unexpected notes call")),
            },
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

fn fake(judgement: &str) -> Fake {
    Fake {
        cursor: RefCell::new(Value::Null),
        judgement: judgement.to_string(),
        appends: RefCell::default(),
        prompts: RefCell::default(),
    }
}

fn mail(subject: &str, at: &str) -> Value {
    json!({"sender": "Boss <boss@example.test>", "subject": subject, "receivedAt": at,
           "threadHint": null, "body": SENTINEL, "bodyTruncated": false})
}

fn input(messages: Vec<Value>) -> Value {
    json!({"ownerUserId": "owner-1", "today": "2026-03-02", "messages": messages})
}

#[test]
fn note_worthy_mail_is_appended_through_notes_and_the_cursor_advances() {
    let host = fake(r#"{"decision":"note","target":{"kind":"default"},"entry":"Review the budget by Friday","reason":"Asks for action"}"#);
    let out = capture(&host, &input(vec![mail("Budget", "2026-03-01T07:00:00.000Z")])).unwrap();
    assert_eq!(out, json!({"processed": 1, "stoppedAt": null}));
    let appends = host.appends.borrow();
    assert_eq!(appends.len(), 1);
    assert_eq!(appends[0]["path"], "default");
    assert!(appends[0]["entry"].as_str().unwrap().contains("Review the budget by Friday"));
    assert!(appends[0]["entry"].as_str().unwrap().contains("<!-- work-mail:"));
    // The stored cursor holds hashed markers only, never mail text.
    let cursor = host.cursor.borrow().to_string();
    assert!(!cursor.contains(SENTINEL) && !cursor.contains("Budget"), "{cursor}");
    // A second run over the same mail does nothing.
    let out = capture(&host, &input(vec![mail("Budget", "2026-03-01T07:00:00.000Z")])).unwrap();
    assert_eq!(out["processed"], 0);
    assert_eq!(host.appends.borrow().len(), 1);
}

#[test]
fn plain_mail_is_skipped_and_a_failed_judgement_stops_without_advancing() {
    let host = fake(r#"{"decision":"nothing","reason":"Plain mail"}"#);
    let out = capture(&host, &input(vec![mail("Hi", "2026-03-01T07:00:00.000Z")])).unwrap();
    assert_eq!(out["processed"], 1);
    assert!(host.appends.borrow().is_empty());

    let host = fake("not json");
    let out = capture(&host, &input(vec![mail("Hi", "2026-03-01T07:00:00.000Z")])).unwrap();
    assert_eq!(out, json!({"processed": 0, "stoppedAt": 0}));
    assert_eq!(*host.cursor.borrow(), Value::Null);
}

#[test]
fn private_notes_are_detected_and_unreadable_front_matter_counts_as_private() {
    assert!(is_private_note("---\nprivate: true\n---\nbody"));
    assert!(is_private_note("---\nprivate: \"yes\"\n---\nbody"));
    assert!(!is_private_note("---\nprivate: false\n---\nbody"));
    assert!(!is_private_note("---\ntitle: Hello\n---\nbody"));
    assert!(!is_private_note("no front matter"));
    assert!(is_private_note("---\nprivate: true\nno closing fence"));
}

#[test]
fn a_judgement_that_copies_the_body_or_names_a_path_is_refused() {
    let body = "x".repeat(300);
    let copied = json!({"decision":"note","target":{"kind":"default"},"entry":body,"reason":"r"});
    assert!(validate_judgement(&copied, &body, &[]).is_err());
    let path = json!({"decision":"note","target":{"kind":"candidate","index":3},"entry":"Short note","reason":"r"});
    assert!(validate_judgement(&path, "body", &[]).is_err());
    let ok = json!({"decision":"note","target":{"kind":"default"},"entry":"Short note","reason":"r"});
    assert!(validate_judgement(&ok, "body", &[]).unwrap().is_some());
}

#[test]
fn a_stale_cursor_shape_starts_fresh() {
    let cursor = parse_cursor(&json!({"salt": "short", "seen": []}), "a".repeat(43).as_str());
    assert!(cursor.marker.is_none());
    assert_eq!(cursor.salt.len(), 43);
}
