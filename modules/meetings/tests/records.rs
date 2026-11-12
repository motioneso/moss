//! Records, titles and notes, ported from the old repository and route suites.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const K1: &str = "11111111-1111-4111-8111-111111111111";
const K2: &str = "22222222-2222-4222-8222-222222222222";
const K3: &str = "33333333-3333-4333-8333-333333333333";
const MISSING: &str = "99999999-9999-4999-8999-999999999999";

fn create(f: &Fake, key: &str, title: &str) -> (u16, Value) {
    f.route("POST", "/records", &[], json!({"requestKey":key,"title":title}))
}
fn id_of(body: &Value) -> String {
    body["meeting"]["id"].as_str().unwrap().to_owned()
}
fn notes(f: &Fake, id: &str, key: &str, rev: i64, text: &str) -> (u16, Value) {
    f.route(
        "PUT",
        "/records/:id/notes",
        &[("id", id)],
        json!({"requestKey":key,"expectedRevision":rev,"personalNotes":text}),
    )
}

#[test]
fn create_replays_the_same_key_and_refuses_changed_input() {
    let f = Fake::new();
    let (status, first) = create(&f, K1, "  Planning  ");
    assert_eq!(status, 201);
    assert_eq!(first["created"], true);
    assert_eq!(first["meeting"]["title"], "Planning");
    assert_eq!(first["meeting"]["notesRevision"], 0);
    assert_eq!(first["meeting"]["personalNotes"], "");
    let (status, again) = create(&f, K1, "Planning");
    assert_eq!((status, &again["created"]), (200, &json!(false)));
    assert_eq!(again["meeting"], first["meeting"]);
    let (status, body) = create(&f, K1, "Something else");
    assert_eq!((status, body), (409, json!({"code":"meeting_request_conflict"})));
    assert_eq!(f.rows("app.meeting_records").len(), 1);
}

#[test]
fn input_limits_are_bytes_and_blank_titles_are_refused() {
    let f = Fake::new();
    assert_eq!(create(&f, K1, &"a".repeat(240)).0, 201);
    // 121 two-byte characters is 242 bytes: under the character limit, over the byte limit.
    let (status, body) = create(&f, K2, &"é".repeat(121));
    assert_eq!((status, body), (400, json!({"code":"meeting_invalid_input"})));
    let (status, body) = create(&f, K2, "   ");
    assert_eq!((status, body), (400, json!({"code":"meeting_invalid_input"})));
    assert_eq!(create(&f, K2, &"a".repeat(241)).0, 400);
    assert_eq!(f.route("POST", "/records", &[], json!({"requestKey":"nope","title":"x"})).0, 400);
    assert_eq!(f.route("POST", "/records", &[], json!({"title":"x"})).0, 400);
    assert_eq!(f.route("POST", "/records", &[], json!({"requestKey":K2,"title":"x","extra":1})).0, 400);
    assert_eq!(f.rows("app.meeting_records").len(), 1);
}

#[test]
fn notes_start_at_revision_zero_and_a_stale_revision_returns_the_current_notes() {
    let f = Fake::new();
    let id = id_of(&create(&f, K1, "Weekly").1);
    let (status, saved) = notes(&f, &id, K1, 0, "first");
    assert_eq!(status, 200);
    assert_eq!(saved["status"], "saved");
    assert_eq!(saved["replayed"], false);
    assert_eq!(saved["meeting"]["notesRevision"], 1);
    let (status, stale) = notes(&f, &id, K2, 0, "second");
    assert_eq!(status, 409);
    assert_eq!(stale["code"], "meeting_notes_conflict");
    assert_eq!(stale["status"], "conflict");
    assert_eq!(stale["meeting"]["personalNotes"], "first");
    assert_eq!(stale["meeting"]["notesRevision"], 1);
    let (status, ok) = notes(&f, &id, K2, 1, "second");
    assert_eq!((status, ok["meeting"]["notesRevision"].clone()), (200, json!(2)));
}

#[test]
fn a_repeated_note_key_replays_the_original_even_after_later_edits() {
    let f = Fake::new();
    let id = id_of(&create(&f, K1, "Weekly").1);
    let (_, first) = notes(&f, &id, K1, 0, "alpha");
    assert_eq!(notes(&f, &id, K2, 1, "beta").0, 200);
    let (status, replay) = notes(&f, &id, K1, 0, "alpha");
    assert_eq!(status, 200);
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["meeting"]["personalNotes"], "alpha");
    assert_eq!(replay["meeting"]["notesRevision"], 1);
    assert_eq!(replay["meeting"]["updatedAt"], first["meeting"]["updatedAt"]);
    // The later edit was not overwritten.
    let (_, now) = f.route("GET", "/records/:id", &[("id", &id)], Value::Null);
    assert_eq!(now["meeting"]["personalNotes"], "beta");
    // The same key with different input conflicts.
    let (status, body) = notes(&f, &id, K1, 0, "changed");
    assert_eq!((status, body), (409, json!({"code":"meeting_request_conflict"})));
    let (status, body) = notes(&f, &id, K1, 1, "alpha");
    assert_eq!((status, body), (409, json!({"code":"meeting_request_conflict"})));
}

#[test]
fn notes_are_bounded_in_bytes_and_revisions_in_range() {
    let f = Fake::new();
    let id = id_of(&create(&f, K1, "Weekly").1);
    assert_eq!(notes(&f, &id, K1, 0, &"a".repeat(64_000)).0, 200);
    // 32,001 two-byte characters is 64,002 bytes.
    let (status, body) = notes(&f, &id, K2, 1, &"é".repeat(32_001));
    assert_eq!((status, body), (400, json!({"code":"meeting_invalid_input"})));
    assert_eq!(notes(&f, &id, K2, 1, &"a".repeat(64_001)).0, 400);
    assert_eq!(notes(&f, &id, K2, -1, "x").0, 400);
    assert_eq!(notes(&f, &id, K2, 2_147_483_647, "x").0, 400);
    assert_eq!(notes(&f, &id, K2, 1, "").0, 200);
    assert_eq!(notes(&f, MISSING, K3, 0, "x").0, 404);
    assert_eq!(notes(&f, "not-a-uuid", K3, 0, "x").0, 400);
}

#[test]
fn titles_rename_with_a_stale_check_and_repeat_safely() {
    let f = Fake::new();
    let id = id_of(&create(&f, K1, "Old name").1);
    let put = |title: &str, expected: &str| {
        f.route("PUT", "/records/:id/title", &[("id", &id)], json!({"title":title,"expectedTitle":expected}))
    };
    let (status, saved) = put("  New name ", "Old name");
    assert_eq!((status, saved["status"].clone()), (200, json!("saved")));
    assert_eq!(saved["meeting"]["title"], "New name");
    // The same rename again is accepted without a second change.
    assert_eq!(put("New name", "Old name").0, 200);
    let (status, stale) = put("Third", "Old name");
    assert_eq!(status, 409);
    assert_eq!(stale["code"], "meeting_title_conflict");
    assert_eq!(stale["meeting"]["title"], "New name");
    assert_eq!(put("", "New name").0, 400);
    assert_eq!(put(&"é".repeat(121), "New name").0, 400);
    let missing = f.route(
        "PUT",
        "/records/:id/title",
        &[("id", MISSING)],
        json!({"title":"x","expectedTitle":"y"}),
    );
    assert_eq!(missing, (404, json!({"code":"meeting_not_found"})));
    // A rename marks the title as the person's own so automatic titling stops.
    let metadata = f.rows("app.meeting_recording_metadata");
    assert_eq!(metadata[0]["title_source"], "user");
}

#[test]
fn list_pages_through_equal_timestamps_without_gaps_or_repeats() {
    let f = Fake::new();
    let mut ids = vec![];
    for n in 0..5 {
        ids.push(id_of(&create(&f, &format!("aaaaaaaa-0000-4000-8000-00000000000{n}"), &format!("m{n}")).1));
    }
    for row in f.tables.borrow_mut().get_mut("app.meeting_records").unwrap() {
        row["created_at"] = json!("2026-11-11T10:00:00.000+00:00");
    }
    let mut seen = vec![];
    let mut query: Vec<(&str, Value)> = vec![("limit", json!(2))];
    loop {
        let (status, body) = f.route_query("GET", "/records", &[], &query, Value::Null);
        assert_eq!(status, 200);
        let page = body["meetings"].as_array().unwrap().clone();
        seen.extend(page.iter().map(|m| m["id"].as_str().unwrap().to_owned()));
        if page.len() < 2 {
            break;
        }
        let last = page.last().unwrap();
        query = vec![
            ("limit", json!(2)),
            ("beforeId", last["id"].clone()),
            ("beforeCreatedAt", last["createdAt"].clone()),
        ];
    }
    let mut expected = ids.clone();
    expected.sort();
    expected.reverse();
    assert_eq!(seen, expected);
}

#[test]
fn list_checks_its_query() {
    let f = Fake::new();
    let get = |q: Vec<(&str, Value)>| f.route_query("GET", "/records", &[], &q, Value::Null).0;
    assert_eq!(get(vec![("limit", json!(0))]), 400);
    assert_eq!(get(vec![("limit", json!(101))]), 400);
    assert_eq!(get(vec![("limit", json!(100))]), 200);
    assert_eq!(get(vec![("beforeId", json!(MISSING))]), 400);
    assert_eq!(get(vec![("beforeCreatedAt", json!("2026-11-11T10:00:00.000Z"))]), 400);
    assert_eq!(get(vec![("beforeId", json!(MISSING)), ("beforeCreatedAt", json!("nope"))]), 400);
    assert_eq!(get(vec![("beforeId", json!(MISSING)), ("beforeCreatedAt", json!("2026-11-11T10:00:00.000Z"))]), 200);
}

#[test]
fn delete_is_permanent_and_answers_the_same_for_missing_and_foreign_records() {
    let f = Fake::new();
    let id = id_of(&create(&f, K1, "Mine").1);
    assert_eq!(notes(&f, &id, K1, 0, "kept").0, 200);
    f.as_actor(B);
    let theirs = f.route("DELETE", "/records/:id", &[("id", &id)], Value::Null);
    let nothing = f.route("DELETE", "/records/:id", &[("id", MISSING)], Value::Null);
    assert_eq!(theirs, nothing);
    assert_eq!(theirs.0, 204);
    f.as_actor(A);
    assert_eq!(f.rows("app.meeting_records").len(), 1, "another person's delete removed a record");
    assert_eq!(f.route("DELETE", "/records/:id", &[("id", &id)], Value::Null).0, 204);
    assert_eq!(f.route("DELETE", "/records/:id", &[("id", &id)], Value::Null).0, 204);
    assert!(f.rows("app.meeting_records").is_empty());
    assert!(f.rows("app.meeting_note_writes").is_empty(), "receipts outlived the record");
    assert_eq!(f.route("GET", "/records/:id", &[("id", &id)], Value::Null).0, 404);
}

#[test]
fn a_second_person_sees_and_changes_nothing_of_the_first() {
    let f = Fake::new();
    let id = id_of(&create(&f, K1, "Private plans").1);
    f.as_actor(B);
    assert_eq!(f.route("GET", "/records/:id", &[("id", &id)], Value::Null), (404, json!({"code":"meeting_not_found"})));
    let (_, list) = f.route("GET", "/records", &[], Value::Null);
    assert_eq!(list["meetings"], json!([]));
    assert_eq!(notes(&f, &id, K2, 0, "intrusion").0, 404);
    assert_eq!(
        f.route("PUT", "/records/:id/title", &[("id", &id)], json!({"title":"x","expectedTitle":"Private plans"})).0,
        404
    );
    // Their own request key does not collide with the first person's.
    assert_eq!(create(&f, K1, "Their own").0, 201);
    f.as_actor(A);
    let (_, mine) = f.route("GET", "/records/:id", &[("id", &id)], Value::Null);
    assert_eq!(mine["meeting"]["title"], "Private plans");
    assert_eq!(mine["meeting"]["personalNotes"], "");
}

#[test]
fn unknown_routes_answer_not_found() {
    let f = Fake::new();
    assert_eq!(f.route("GET", "/nothing", &[], Value::Null).0, 404);
}
