//! What Chat reads about a meeting and the call that removes its threads, replayed in the shapes
//! the old Chat module used.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const K1: &str = "11111111-1111-4111-8111-111111111111";
const K2: &str = "22222222-2222-4222-8222-222222222222";
const MISSING: &str = "99999999-9999-4999-8999-999999999999";

fn call(f: &Fake, name: &str, parameters: Value) -> Value {
    let payload = json!({"name": name, "parameters": parameters}).to_string();
    let out = moss_meetings_module::handle(f, "api", &payload).unwrap();
    serde_json::from_str(&out).unwrap()
}
fn meeting(f: &Fake) -> String {
    let (_, body) = f.route("POST", "/records", &[], json!({"requestKey": K1, "title": "Standup"}));
    body["meeting"]["id"].as_str().unwrap().to_owned()
}
fn say(f: &Fake, id: &str, count: i64, text: &str) {
    let events: Vec<Value> = (1..=count)
        .map(|n| json!({"cursor":n,"segment":{"meetingId":id,"segmentId":format!("s{n}"),"sourceId":"mic","epoch":1,
            "startMs":0,"endMs":900,"revision":1,"text":text,"finality":"final","provenance":"transcription","speakerId":null}}))
        .collect();
    let body = json!({"requestKey":K2,"expectedVersion":0,"stopCutoffMs":null,
        "sources":[{"sourceId":"mic","epoch":1,"kind":"microphone","label":"Microphone","startMs":0,"endMs":1000}],"events":events});
    assert_eq!(f.route("POST", "/records/:id/transcript", &[("id", id)], body).0, 201);
}

#[test]
fn availability_follows_the_record_and_its_owner() {
    let f = Fake::new();
    let id = meeting(&f);
    assert_eq!(call(&f, "meetingChatAvailable", json!({"meetingId": id})), json!({"available": true}));
    assert_eq!(call(&f, "meetingChatAvailable", json!({"meetingId": MISSING})), json!({"available": false}));
    assert_eq!(call(&f, "meetingChatAvailable", json!({"meetingId": "not an id"})), json!({"available": false}));
    f.as_actor(B);
    assert_eq!(call(&f, "meetingChatAvailable", json!({"meetingId": id})), json!({"available": false}));
}

#[test]
fn a_meeting_without_a_transcript_gives_an_empty_snapshot_with_notes() {
    let f = Fake::new();
    let id = meeting(&f);
    let body = json!({"requestKey": K2, "expectedRevision": 0, "personalNotes": "kept"});
    f.route("PUT", "/records/:id/notes", &[("id", &id)], body);
    let s = call(&f, "meetingChatSnapshot", json!({"meetingId": id, "query": "anything"}));
    let s = &s["snapshot"];
    assert_eq!(s["segments"], json!([]));
    assert_eq!(s["maxSegments"], 8);
    assert_eq!(s["maxCharacters"], 12000);
    assert_eq!(s["personalNotes"], "kept");
    assert_eq!(s["notesRevision"], 1);
}

#[test]
fn a_snapshot_holds_at_most_eight_segments() {
    let f = Fake::new();
    let id = meeting(&f);
    say(&f, &id, 12, "Hello there");
    let s = call(&f, "meetingChatSnapshot", json!({"meetingId": id, "query": "hello"}));
    let s = &s["snapshot"];
    assert_eq!(s["segments"].as_array().unwrap().len(), 8);
    assert_eq!(s["omittedSegments"], 4);
    assert_eq!(s["transcriptRevision"], 12);
}

#[test]
fn another_account_and_a_missing_meeting_get_no_snapshot() {
    let f = Fake::new();
    let id = meeting(&f);
    say(&f, &id, 1, "Hello there");
    f.as_actor(B);
    assert_eq!(call(&f, "meetingChatSnapshot", json!({"meetingId": id})), json!({"snapshot": null}));
    f.as_actor(A);
    assert_eq!(call(&f, "meetingChatSnapshot", json!({"meetingId": MISSING})), json!({"snapshot": null}));
}

#[test]
fn evidence_returns_the_cited_text_or_null() {
    let f = Fake::new();
    let id = meeting(&f);
    say(&f, &id, 1, "Hello there");
    let ask = |end: i64, revision: i64| {
        call(&f, "meetingChatEvidence", json!({"meetingId": id, "segmentId": "s1",
            "segmentRevision": revision, "startCharacter": 0, "endCharacter": end}))
    };
    assert_eq!(ask(5, 1)["evidence"]["excerpt"], "Hello");
    assert_eq!(ask(5, 2), json!({"evidence": null}));
    assert_eq!(ask(500, 1), json!({"evidence": null}));
}

#[test]
fn deleting_a_meeting_asks_chat_to_remove_its_threads_first() {
    let f = Fake::new();
    let id = meeting(&f);
    assert_eq!(f.route("DELETE", "/records/:id", &[("id", &id)], Value::Null).0, 204);
    assert_eq!(*f.chat_deleted.borrow(), vec![id]);
    assert!(f.rows("app.meeting_records").is_empty());
}

#[test]
fn a_chat_refusal_keeps_the_meeting_so_a_retry_can_finish() {
    let f = Fake::new();
    let id = meeting(&f);
    *f.chat_refuses.borrow_mut() = Some("Chat is busy".into());
    assert_eq!(f.route("DELETE", "/records/:id", &[("id", &id)], Value::Null).0, 500);
    assert_eq!(f.rows("app.meeting_records").len(), 1);
    *f.chat_refuses.borrow_mut() = None;
    assert_eq!(f.route("DELETE", "/records/:id", &[("id", &id)], Value::Null).0, 204);
    assert!(f.rows("app.meeting_records").is_empty());
}

#[test]
fn a_missing_chat_module_does_not_block_the_delete() {
    let f = Fake::new();
    let id = meeting(&f);
    *f.chat_refuses.borrow_mut() = Some("Module chat is not installed".into());
    assert_eq!(f.route("DELETE", "/records/:id", &[("id", &id)], Value::Null).0, 204);
}
