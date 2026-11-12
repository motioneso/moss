//! Reviewing a proposed action: one task per accepted action, replays, conflicts and refusals.
//! The fake host answers the storage operations; the host crate proves them against Postgres.
use moss_meetings_module::output_service::{review, Review};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

const M: &str = "00000000-0000-4000-8000-0000000000aa";
const C: &str = "00000000-0000-4000-8000-0000000000c1";
const K1: &str = "00000000-0000-4000-8000-000000000001";
const K2: &str = "00000000-0000-4000-8000-000000000002";
const K3: &str = "00000000-0000-4000-8000-000000000003";

struct Fake {
    state: RefCell<String>,
    task: RefCell<Value>,
    matches: Value,
    requests: RefCell<Vec<(String, String, Option<String>)>>,
    made: RefCell<Vec<Value>>,
    tasks_down: Cell<bool>,
}

fn cite() -> Value {
    json!({"kind":"transcript","meetingId":M,"segmentId":"s1","segmentRevision":1,"startCharacter":0,"endCharacter":6})
}
fn proposal() -> Value {
    json!({"text":"Send the budget","evidence":[cite()],"ownerPhrase":null,"duePhrase":null})
}

impl Host for Fake {
    fn call(&self, port: &str, op: &str, resource: &str, p: Value) -> Result<Value> {
        match (port, resource, op) {
            ("kv", "meetings.transcripts", _) => Ok(json!({"found": false})),
            ("kv", "meetings.outputs", "lock") => Ok(json!({"found":true,"personalNotes":"","notesRevision":0,"longSource":false})),
            ("kv", "meetings.outputs", "request") => {
                let key = p["requestKey"].as_str().unwrap();
                Ok(match self.requests.borrow().iter().find(|r| r.0 == key) {
                    None => json!({"found": false}),
                    Some((_, input, result)) => json!({"found":true,"inputJson":input,"resultJson":result,"expired":false}),
                })
            }
            ("kv", "meetings.outputs", "reserve") => {
                self.requests.borrow_mut().push((p["requestKey"].as_str().unwrap().into(), p["inputJson"].as_str().unwrap().into(), None));
                Ok(json!({}))
            }
            ("kv", "meetings.outputs", "finish") => {
                self.requests.borrow_mut().last_mut().unwrap().2 = p["resultJson"].as_str().map(str::to_owned);
                Ok(json!({}))
            }
            ("kv", "meetings.outputs", "candidate") => Ok(if p["candidateId"] == C {
                json!({"found":true,"id":C,"artifactVersion":1,"proposalJson":proposal().to_string(),
                    "possibleMatchIds":self.matches,"reviewState":*self.state.borrow(),"acceptedTaskId":*self.task.borrow()})
            } else {
                json!({"found": false})
            }),
            ("kv", "meetings.outputs", "artifact") => Ok(json!({"artifactJson": json!({"inputs":{"meetingId":M,"notesRevision":0,"personalNotes":"",
                "transcript":{"segments":[{"meetingId":M,"segmentId":"s1","revision":1,"text":"budget review"}]}}}).to_string()})),
            ("kv", "meetings.outputs", "review-set") => {
                *self.state.borrow_mut() = p["reviewState"].as_str().unwrap().into();
                *self.task.borrow_mut() = p["acceptedTaskId"].clone();
                Ok(json!({}))
            }
            ("api", "tasks", "call") => {
                if self.tasks_down.get() {
                    return Err(moss_module_sdk::Error::new("down"));
                }
                self.made.borrow_mut().push(p.clone());
                Ok(json!({"task":{"id":"00000000-0000-4000-8000-0000000000d1"}}))
            }
            // These meetings have no recording row, so a summary read finds none.
            ("db", "app.meeting_recording_metadata" | "app.meeting_records", "query") => Ok(json!([])),
            other => panic!("unexpected call {other:?}"),
        }
    }
}

fn fake(matches: Value) -> Fake {
    Fake {
        state: RefCell::new("pending".into()),
        task: RefCell::new(Value::Null),
        matches,
        requests: RefCell::new(vec![]),
        made: RefCell::new(vec![]),
        tasks_down: Cell::new(false),
    }
}

fn accept(key: &str) -> Review {
    Review { request_key: key.into(), decision: "accept".into(), title: Some("  Send the deck  ".into()), due_at: None, create_despite_possible_matches: None }
}
fn dismiss(key: &str) -> Review {
    Review { request_key: key.into(), decision: "dismiss".into(), title: None, due_at: None, create_despite_possible_matches: None }
}

#[test]
fn accepting_makes_one_keyed_task_and_a_replay_makes_none() {
    let host = fake(json!([]));
    let (status, body) = review(&host, M, C, &accept(K1)).unwrap();
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["reviewState"], "accepted");
    assert_eq!(body["acceptedTaskId"], "00000000-0000-4000-8000-0000000000d1");
    let made = host.made.borrow();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0]["name"], "createMeetingTask");
    assert_eq!(made[0]["parameters"]["title"], "Send the deck");
    assert_eq!(made[0]["parameters"]["externalKey"], format!("meeting:{M}:candidate:{C}"));
    drop(made);
    // Same key again replays the stored answer without a second Tasks call.
    let again = review(&host, M, C, &accept(K1)).unwrap();
    assert_eq!(again.1["reviewState"], "accepted");
    // A new key after acceptance is also answered from the stored state, never a second task.
    let later = review(&host, M, C, &accept(K2)).unwrap();
    assert_eq!(later.0, 200);
    assert_eq!(host.made.borrow().len(), 1);
}

#[test]
fn a_changed_replay_a_conflicting_decision_and_a_missing_action_are_refused() {
    let host = fake(json!([]));
    review(&host, M, C, &accept(K1)).unwrap();
    let mut other = accept(K1);
    other.title = Some("Different".into());
    assert_eq!(review(&host, M, C, &other).unwrap().1["code"], "meeting_output_request_conflict");
    let conflict = review(&host, M, C, &dismiss(K2)).unwrap();
    assert_eq!((conflict.0, conflict.1["code"].clone()), (409, json!("meeting_action_review_conflict")));
    let none = review(&host, M, "00000000-0000-4000-8000-0000000000c2", &accept(K3)).unwrap();
    assert_eq!((none.0, none.1["code"].clone()), (404, json!("meeting_action_unavailable")));
}

#[test]
fn possible_matches_need_an_explicit_confirm_and_a_bad_title_or_due_time_is_refused() {
    let host = fake(json!(["00000000-0000-4000-8000-0000000000e1"]));
    assert_eq!(review(&host, M, C, &accept(K1)).unwrap().1["code"], "meeting_action_match_review_required");
    let mut sure = accept(K1);
    sure.create_despite_possible_matches = Some(true);
    sure.due_at = Some("2026-11-12T10:00:00.000Z".into());
    assert_eq!(review(&host, M, C, &sure).unwrap().0, 200);
    assert_eq!(host.made.borrow()[0]["parameters"]["dueAt"], "2026-11-12T10:00:00.000Z");

    let host = fake(json!([]));
    for title in ["   ", "a\0b"] {
        let mut bad = accept(K1);
        bad.title = Some(title.into());
        assert_eq!(review(&host, M, C, &bad).unwrap().1["code"], "meeting_output_invalid_input");
    }
    let mut loose = accept(K1);
    loose.due_at = Some("2026-11-12T10:00:00Z".into());
    assert_eq!(review(&host, M, C, &loose).unwrap().1["code"], "meeting_output_invalid_input");
    assert!(host.made.borrow().is_empty());
}

#[test]
fn a_down_tasks_module_leaves_the_action_pending() {
    let host = fake(json!([]));
    host.tasks_down.set(true);
    let (status, body) = review(&host, M, C, &accept(K1)).unwrap();
    assert_eq!((status, body["code"].clone()), (503, json!("meeting_tasks_unavailable")));
    assert_eq!(*host.state.borrow(), "pending");
    host.tasks_down.set(false);
    assert_eq!(review(&host, M, C, &accept(K2)).unwrap().0, 200);
}

#[test]
fn dismissing_makes_no_task() {
    let host = fake(json!([]));
    let (status, body) = review(&host, M, C, &dismiss(K1)).unwrap();
    assert_eq!((status, body["reviewState"].clone()), (200, json!("dismissed")));
    assert!(host.made.borrow().is_empty());
}
