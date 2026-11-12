//! Transcript batches, snapshots, evidence and limits, ported from the old repository suites.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const K1: &str = "11111111-1111-4111-8111-111111111111";
const K2: &str = "22222222-2222-4222-8222-222222222222";
const K3: &str = "33333333-3333-4333-8333-333333333333";
const MISSING: &str = "99999999-9999-4999-8999-999999999999";
const MARKER: &str = "zebra-marker-7731";

fn meeting(f: &Fake) -> String {
    let (_, body) = f.route("POST", "/records", &[], json!({"requestKey": K3, "title": "Standup"}));
    body["meeting"]["id"].as_str().unwrap().to_owned()
}
fn source() -> Value {
    json!({"sourceId":"mic","epoch":1,"kind":"microphone","label":"Microphone","startMs":0,"endMs":1000})
}
fn event(id: &str, cursor: i64, segment: &str, revision: i64, text: &str, finality: &str) -> Value {
    json!({"cursor":cursor,"segment":{"meetingId":id,"segmentId":segment,"sourceId":"mic","epoch":1,"startMs":0,
        "endMs":900,"revision":revision,"text":text,"finality":finality,"provenance":"transcription","speakerId":null}})
}
fn batch(key: &str, version: i64, events: Vec<Value>) -> Value {
    json!({"requestKey":key,"expectedVersion":version,"sources":[source()],"events":events,"stopCutoffMs":null})
}
fn post(f: &Fake, id: &str, body: Value) -> (u16, Value) {
    f.route("POST", "/records/:id/transcript", &[("id", id)], body)
}
fn read(f: &Fake, id: &str, query: &[(&str, Value)]) -> (u16, Value) {
    // The limits are required, so a test that omits them gets the largest.
    let mut full = vec![("maxSegments", json!("500")), ("maxCharacters", json!("100000"))];
    full.retain(|(k, _)| query.iter().all(|(q, _)| q != k));
    full.extend(query.iter().cloned());
    f.route_query("GET", "/records/:id/transcript", &[("id", id)], &full, Value::Null)
}

#[test]
fn saves_a_batch_then_replays_it_and_refuses_changed_content() {
    let f = Fake::new();
    let id = meeting(&f);
    let b = batch(K1, 0, vec![event(&id, 1, "s1", 1, "Hello there", "final")]);
    let (status, first) = post(&f, &id, b.clone());
    assert_eq!(status, 201);
    assert_eq!(first, json!({"status":"saved","replayed":false,
        "receipt":{"version":1,"transcriptRevision":1,"cursor":1,"stopCutoffMs":null}}));
    let (status, again) = post(&f, &id, b);
    assert_eq!((status, again["replayed"].clone()), (200, json!(true)));
    assert_eq!(again["receipt"], first["receipt"]);
    let changed = batch(K1, 0, vec![event(&id, 1, "s1", 1, "Different", "final")]);
    assert_eq!(post(&f, &id, changed), (409, json!({"code":"meeting_transcript_request_conflict"})));
    assert_eq!(f.batches.borrow().len(), 1);
}

#[test]
fn a_stale_version_is_refused_with_the_current_receipt() {
    let f = Fake::new();
    let id = meeting(&f);
    post(&f, &id, batch(K1, 0, vec![event(&id, 1, "s1", 1, "One", "final")]));
    let (status, body) = post(&f, &id, batch(K2, 0, vec![event(&id, 2, "s2", 1, "Two", "final")]));
    assert_eq!(status, 409);
    assert_eq!(body["code"], "meeting_transcript_version_conflict");
    assert_eq!(body["status"], "conflict");
    assert_eq!(body["receipt"]["version"], 1);
    assert_eq!(f.batches.borrow().len(), 1);
}

#[test]
fn snapshot_returns_the_latest_text_of_each_segment_in_cursor_order() {
    let f = Fake::new();
    let id = meeting(&f);
    post(&f, &id, batch(K1, 0, vec![
        event(&id, 1, "s1", 1, "draft one", "provisional"),
        event(&id, 2, "s2", 1, "second", "final"),
    ]));
    post(&f, &id, batch(K2, 1, vec![event(&id, 3, "s1", 2, "first, corrected", "final")]));
    let (status, body) = read(&f, &id, &[]);
    assert_eq!(status, 200);
    let snap = &body["snapshot"];
    assert_eq!((snap["transcriptRevision"].clone(), snap["cursor"].clone()), (json!(3), json!(3)));
    assert_eq!(snap["maxSegments"], 500);
    assert_eq!(snap["maxCharacters"], 100000);
    assert_eq!(snap["containsProvisional"], false);
    assert_eq!(snap["omittedSegments"], 0);
    let texts: Vec<&str> = snap["segments"].as_array().unwrap().iter().map(|s| s["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["first, corrected", "second"]);
    assert_eq!(body["sources"][0]["label"], "Microphone");
}

#[test]
fn a_snapshot_at_an_older_revision_hides_later_edits() {
    let f = Fake::new();
    let id = meeting(&f);
    post(&f, &id, batch(K1, 0, vec![event(&id, 1, "s1", 1, "draft", "provisional")]));
    post(&f, &id, batch(K2, 1, vec![event(&id, 2, "s1", 2, "final text", "final")]));
    let (_, old) = read(&f, &id, &[("transcriptRevision", json!("1"))]);
    assert_eq!(old["snapshot"]["segments"][0]["text"], "draft");
    assert_eq!(old["snapshot"]["containsProvisional"], true);
}

#[test]
fn reads_stay_inside_the_segment_and_character_limits() {
    let f = Fake::new();
    let id = meeting(&f);
    let events = (1..=3).map(|n| event(&id, n, &format!("s{n}"), 1, "abcdefghij", "final")).collect();
    post(&f, &id, batch(K1, 0, events));
    let (_, one) = read(&f, &id, &[("maxSegments", json!("1"))]);
    assert_eq!(one["snapshot"]["segments"].as_array().unwrap().len(), 1);
    assert_eq!(one["snapshot"]["omittedSegments"], 2);
    let (_, chars) = read(&f, &id, &[("maxCharacters", json!("15"))]);
    assert_eq!(chars["snapshot"]["segments"].as_array().unwrap().len(), 1);
    assert_eq!(read(&f, &id, &[("maxSegments", json!("501"))]).0, 400);
    assert_eq!(read(&f, &id, &[("maxCharacters", json!("100001"))]).0, 400);
}

#[test]
fn evidence_returns_the_character_range_of_one_revision() {
    let f = Fake::new();
    let id = meeting(&f);
    post(&f, &id, batch(K1, 0, vec![event(&id, 1, "s1", 1, "a😀bc", "final")]));
    let ask = |start: i64, end: i64| {
        f.route_query("GET", "/records/:id/transcript/evidence", &[("id", &id)],
            &[("segmentId", json!("s1")), ("segmentRevision", json!("1")),
              ("startCharacter", json!(start.to_string())), ("endCharacter", json!(end.to_string()))], Value::Null)
    };
    let (status, body) = ask(1, 3);
    assert_eq!((status, body["evidence"]["excerpt"].clone()), (200, json!("😀")));
    assert_eq!(ask(0, 5).1["evidence"]["excerpt"], "a😀bc");
    for (start, end) in [(2, 3), (1, 2), (0, 6), (3, 3), (4, 3)] {
        assert_eq!(ask(start, end), (404, json!({"code":"meeting_transcript_unavailable"})), "{start}-{end}");
    }
}

#[test]
fn evidence_for_a_revision_that_does_not_exist_is_unavailable() {
    let f = Fake::new();
    let id = meeting(&f);
    post(&f, &id, batch(K1, 0, vec![event(&id, 1, "s1", 1, "text", "final")]));
    let (status, body) = f.route_query("GET", "/records/:id/transcript/evidence", &[("id", &id)],
        &[("segmentId", json!("s1")), ("segmentRevision", json!("2")), ("startCharacter", json!("0")), ("endCharacter", json!("1"))], Value::Null);
    assert_eq!((status, body), (404, json!({"code":"meeting_transcript_unavailable"})));
}

#[test]
fn invalid_batches_return_the_old_codes() {
    let f = Fake::new();
    let id = meeting(&f);
    // A cursor that does not move forward, a wrong meeting id and a repeated cursor are rejected.
    let back = batch(K1, 0, vec![event(&id, 2, "s1", 1, "a", "final"), event(&id, 2, "s2", 1, "b", "final")]);
    assert_eq!(post(&f, &id, back), (400, json!({"code":"meeting_transcript_invalid_input"})));
    let other = batch(K1, 0, vec![event(MISSING, 1, "s1", 1, "a", "final")]);
    assert_eq!(post(&f, &id, other), (400, json!({"code":"meeting_transcript_invalid_input"})));
    let big = "x".repeat(100_001);
    assert_eq!(post(&f, &id, batch(K1, 0, vec![event(&id, 1, "s1", 1, &big, "final")])),
        (413, json!({"code":"meeting_transcript_limit"})));
    let many = (1..=101).map(|n| event(&id, n, &format!("s{n}"), 1, "a", "final")).collect();
    assert_eq!(post(&f, &id, batch(K1, 0, many)).0, 413);
    assert_eq!(post(&f, &id, batch(K1, 4096, vec![])).0, 413);
    assert_eq!(f.batches.borrow().len(), 0);
}

#[test]
fn schema_errors_name_the_field_like_the_old_validator() {
    let f = Fake::new();
    let id = meeting(&f);
    let mut b = batch("not-a-uuid", 0, vec![event(&id, 1, "s1", 1, "a", "final")]);
    assert_eq!(post(&f, &id, b.clone()), (400, json!({"error":"body/requestKey must match format \"uuid\""})));
    b["requestKey"] = json!(K1);
    b["sources"][0]["kind"] = json!("telephone");
    assert_eq!(post(&f, &id, b).1, json!({"error":"body/sources/0/kind must be equal to one of the allowed values"}));
    assert_eq!(read(&f, &id, &[("extra", json!("1"))]),
        (400, json!({"error":"querystring must NOT have additional properties"})));
}

#[test]
fn a_missing_meeting_posts_404_and_reads_as_unavailable() {
    let f = Fake::new();
    assert_eq!(post(&f, MISSING, batch(K1, 0, vec![event(MISSING, 1, "s1", 1, "a", "final")])),
        (404, json!({"code":"meeting_not_found"})));
    assert_eq!(read(&f, MISSING, &[]), (404, json!({"code":"meeting_transcript_unavailable"})));
}

#[test]
fn another_person_sees_nothing_and_changes_nothing() {
    let f = Fake::new();
    let id = meeting(&f);
    post(&f, &id, batch(K1, 0, vec![event(&id, 1, "s1", 1, MARKER, "final")]));
    f.as_actor(B);
    assert_eq!(read(&f, &id, &[]), (404, json!({"code":"meeting_transcript_unavailable"})));
    assert_eq!(post(&f, &id, batch(K2, 1, vec![event(&id, 2, "s2", 1, "x", "final")])),
        (404, json!({"code":"meeting_not_found"})));
    assert_eq!(f.batches.borrow().len(), 1);
    f.as_actor(A);
    assert_eq!(read(&f, &id, &[]).0, 200);
}

#[test]
fn the_search_rows_carry_text_only_in_their_own_field() {
    let f = Fake::new();
    let id = meeting(&f);
    post(&f, &id, batch(K1, 0, vec![event(&id, 1, "s1", 1, MARKER, "final")]));
    let segments = f.segments.borrow();
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0]["text"], MARKER);
    assert_eq!(segments[0]["key"], "\"s1\"");
    // Nothing else a post leaves behind carries the transcript text except the stored input.
    let calls = f.calls.borrow().join("\n");
    assert!(!calls.contains(MARKER));
    assert!(f.rows("app.meeting_records").iter().all(|r| !r.to_string().contains(MARKER)));
}
