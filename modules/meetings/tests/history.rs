//! History input rules and the shape of each row, ported from the old repository suites.
mod common;
use common::Fake;
use serde_json::{json, Value};

const ID: &str = "11111111-1111-4111-8111-111111111111";

fn search(f: &Fake, body: Value) -> (u16, Value) {
    f.route("POST", "/history/search", &[], body)
}
fn invalid() -> (u16, Value) {
    (400, json!({"code":"meeting_history_invalid_input"}))
}
fn row() -> Value {
    json!({"id":ID,"title":"Standup","created_at":"2026-11-11T10:00:00.123456+00:00","updated_at":"2026-11-11T10:05:00+00:00",
        "recorded_at":null,"type_id":null,"recording_side":null,"has_notes":true,"notes_revision":2,
        "capture_duration_ms":null,"import_metadata_json":null,"output_overview":"","transcript_revision":3,
        "segment_count":2,"final_count":1,"provisional_count":1,"start_ms":0,"end_ms":1500.5,
        "sources_json":"[{\"kind\":\"microphone\",\"label\":\"Microphone\"}]","omitted_sources":0,
        "output_version":null,"output_origin":null,"output_created_at":null,"output_stale":false,
        "generation_status":null,"generation_expires_at":null,"pending_count":0,"accepted_count":0,"dismissed_count":0,
        "vault_version":null,"vault_write_status":null,"vault_index_status":null,"vault_updated_at":null,"saved_count":0})
}

#[test]
fn every_old_input_rule_still_refuses() {
    let f = Fake::new();
    let long = "a".repeat(257);
    let bytes = "é".repeat(257);
    for body in [
        json!({"extra":1}), json!({"query":5}), json!({"query":null}), json!({"query":long}), json!({"query":bytes}),
        json!({"query":"a\u{0}b"}), json!({"filter":"nope"}), json!({"filter":null}), json!({"limit":0}), json!({"limit":51}),
        json!({"limit":1.5}), json!({"limit":"5"}), json!({"limit":null}), json!({"typeId":"Bad"}), json!({"typeId":"9a"}),
        json!({"typeId":"a".repeat(65)}), json!({"typeId":null}), json!({"before":null}), json!({"before":[]}),
        json!({"before":{"id":ID}}), json!({"before":{"dateAt":"2026-11-11T10:00:00.000Z"}}),
        json!({"before":{"id":"x","dateAt":"2026-11-11T10:00:00.000Z"}}),
        json!({"before":{"id":ID,"dateAt":"2026-11-11T10:00:00Z"}}),
        json!({"before":{"id":ID,"dateAt":"2026-13-11T10:00:00.000Z"}}),
        json!({"before":{"id":ID,"dateAt":"2026-11-11T10:00:00.000Z","more":1}}),
        json!([]), json!(null), json!("x"),
    ] {
        assert_eq!(search(&f, body.clone()), invalid(), "{body}");
    }
    assert!(f.history_asked.borrow().is_none());
    assert_eq!(f.route("GET", "/history/:id", &[("id", "nope")], Value::Null), invalid());
}

#[test]
fn a_valid_search_reaches_the_host_with_trimmed_text_and_defaults() {
    let f = Fake::new();
    assert_eq!(search(&f, json!({"query":"  budget  "})).0, 200);
    assert_eq!(f.history_asked.borrow().clone().unwrap(),
        json!({"id":null,"query":"budget","filter":"all","limit":30,"before":null,"typeId":null}));
    let before = json!({"id":ID,"dateAt":"2026-11-11T10:00:00.000Z"});
    search(&f, json!({"filter":"needs-review","limit":50.0,"typeId":"one-to-one","before":before}));
    let asked = f.history_asked.borrow().clone().unwrap();
    assert_eq!((asked["filter"].clone(), asked["limit"].clone(), asked["typeId"].clone()),
        (json!("needs-review"), json!(50), json!("one-to-one")));
}

#[test]
fn rows_become_the_old_meeting_shape() {
    let f = Fake::new();
    f.history_rows.replace(vec![row()]);
    let (status, body) = search(&f, json!({}));
    assert_eq!(status, 200);
    assert_eq!(body["nextCursor"], Value::Null);
    let m = &body["meetings"][0];
    assert_eq!(m["date"], json!({"at":"2026-11-11T10:00:00.123Z","source":"added"}));
    assert_eq!(m["updatedAt"], "2026-11-11T10:05:00.000Z");
    assert!(m.get("recording").is_none());
    assert_eq!(m["summary"], json!({"overview":null,"status":"none","version":null,"origin":null,"createdAt":null,"generation":null}));
    assert_eq!(m["transcript"]["status"], "retained");
    assert_eq!(m["transcript"]["span"], json!({"startMs":0,"endMs":1500.5}));
    assert_eq!(m["transcript"]["sources"][0]["label"], "Microphone");
    assert_eq!(m["capture"], json!({"status":"unavailable","durationMs":null}));
    assert_eq!(m["vault"], json!({"latest":null,"savedVersionCount":0}));
}

#[test]
fn recorded_meetings_report_recording_details_and_a_valid_import_length() {
    let f = Fake::new();
    let mut r = row();
    r["recorded_at"] = json!("2026-11-10T09:00:00+00:00");
    r["type_id"] = json!("one-to-one");
    r["recording_side"] = json!("work");
    r["import_metadata_json"] = json!("{\"durationMs\":60000}");
    r["output_version"] = json!(2);
    r["output_origin"] = json!("generated");
    r["output_stale"] = json!(true);
    r["output_overview"] = json!("Short summary");
    r["generation_status"] = json!("pending");
    r["generation_expires_at"] = json!("2026-11-11T11:00:00+00:00");
    r["vault_version"] = json!(2);
    r["vault_write_status"] = json!("saved");
    r["vault_index_status"] = json!("queued");
    r["vault_updated_at"] = json!("2026-11-11T10:30:00.000Z");
    f.history_rows.replace(vec![r.clone()]);
    let m = search(&f, json!({})).1["meetings"][0].clone();
    assert_eq!(m["date"], json!({"at":"2026-11-10T09:00:00.000Z","source":"recorded"}));
    assert_eq!(m["recording"], json!({"typeId":"one-to-one","side":"work"}));
    assert_eq!(m["capture"]["durationMs"], 60000);
    assert_eq!(m["summary"]["status"], "stale");
    assert_eq!(m["summary"]["generation"], json!({"status":"pending","expiresAt":"2026-11-11T11:00:00.000Z"}));
    assert_eq!(m["vault"]["latest"]["indexStatus"], "queued");
    for bad in ["{\"durationMs\":7200001}", "{\"durationMs\":1.5}", "{\"durationMs\":-1}", "not json", "{\"durationMs\":\"5\"}"] {
        r["import_metadata_json"] = json!(bad);
        f.history_rows.replace(vec![r.clone()]);
        assert_eq!(search(&f, json!({})).1["meetings"][0]["capture"]["durationMs"], Value::Null, "{bad}");
    }
}

#[test]
fn an_extra_row_becomes_the_next_page_cursor() {
    let f = Fake::new();
    let rows = (0..3).map(|n| {
        let mut r = row();
        r["id"] = json!(format!("00000000-0000-4000-8000-00000000000{n}"));
        r
    });
    f.history_rows.replace(rows.collect());
    let (_, body) = search(&f, json!({"limit":2}));
    assert_eq!(body["meetings"].as_array().unwrap().len(), 2);
    assert_eq!(body["nextCursor"], json!({"id":"00000000-0000-4000-8000-000000000001","dateAt":"2026-11-11T10:00:00.123Z"}));
}

#[test]
fn a_failed_read_is_unavailable_and_carries_no_detail() {
    let f = Fake::new();
    f.history_fails.set(true);
    assert_eq!(search(&f, json!({})), (503, json!({"code":"meeting_history_unavailable"})));
    assert_eq!(f.route("GET", "/history/:id", &[("id", ID)], Value::Null), (503, json!({"code":"meeting_history_unavailable"})));
}

#[test]
fn one_meeting_by_id_or_not_found() {
    let f = Fake::new();
    assert_eq!(f.route("GET", "/history/:id", &[("id", ID)], Value::Null), (404, json!({"code":"meeting_not_found"})));
    f.history_rows.replace(vec![row()]);
    let (status, body) = f.route("GET", "/history/:id", &[("id", ID)], Value::Null);
    assert_eq!((status, body["meeting"]["id"].clone()), (200, json!(ID)));
    assert_eq!(f.history_asked.borrow().clone().unwrap()["id"], ID);
}
