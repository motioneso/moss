//! Recording types, per-meeting recording identity and pasted transcripts.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const K1: &str = "11111111-1111-4111-8111-111111111111";
const K2: &str = "22222222-2222-4222-8222-222222222222";
const MISSING: &str = "99999999-9999-4999-8999-999999999999";

fn meeting(f: &Fake, key: &str, title: &str) -> String {
    let (_, body) = f.route("POST", "/records", &[], json!({"requestKey":key,"title":title}));
    body["meeting"]["id"].as_str().unwrap().to_owned()
}
fn types(f: &Fake, revision: i64, list: Value) -> (u16, Value) {
    f.route("PUT", "/recording-types", &[], json!({"expectedRevision":revision,"types":list}))
}
fn one(id: &str, name: &str) -> Value {
    json!({"id":id,"name":name,"description":"About it","templateId":"general","retired":false})
}

#[test]
fn types_default_then_save_and_reject_removal() {
    let f = Fake::new();
    let (status, body) = f.route("GET", "/recording-types", &[], Value::Null);
    assert_eq!((status, body["revision"].clone(), body["types"].as_array().unwrap().len()), (200, json!(0), 6));
    let defaults = f.route("GET", "/recording-types", &[], Value::Null).1["types"].clone();
    let mut list = defaults.as_array().unwrap().clone();
    list.push(one("call", " Call "));
    let (status, saved) = types(&f, 0, json!(list));
    assert_eq!(status, 200);
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["types"][6]["name"], "Call");
    // A save must keep every existing id, and a new type cannot start retired.
    assert_eq!(types(&f, 1, json!([one("other", "Other")])), (400, json!({"code":"recording_type_configuration_invalid"})));
    assert_eq!(types(&f, 0, json!(list)).1, json!({"code":"recording_type_configuration_conflict"}));
    // Identical types return the current configuration without a new revision.
    list[6]["name"] = json!("Call");
    let (status, same) = types(&f, 1, json!(list));
    assert_eq!((status, same["revision"].clone()), (200, json!(1)));
}

#[test]
fn types_checks_use_the_old_codes() {
    let f = Fake::new();
    let bad = |v: Value| f.route("PUT", "/recording-types", &[], v);
    assert_eq!(bad(json!([])).1, json!({"code":"recording_type_configuration_invalid"}));
    assert_eq!(bad(json!({"expectedRevision":0,"types":[]})).1["code"], "recording_type_configuration_invalid");
    let many: Vec<Value> = (0..33).map(|i| one(&format!("t{i}"), &format!("N{i}"))).collect();
    assert_eq!(bad(json!({"expectedRevision":0,"types":many})).1["code"], "recording_type_limit");
    let mut long = one("a", "A");
    long["description"] = json!("x".repeat(70_000));
    assert_eq!(bad(json!({"expectedRevision":0,"types":[long]})).1["code"], "recording_type_configuration_too_large");
    let mut retired = one("a", "A");
    retired["retired"] = json!(true);
    assert_eq!(bad(json!({"expectedRevision":0,"types":[retired]})).1["code"], "recording_type_configuration_invalid");
    assert_eq!(bad(json!({"expectedRevision":0,"types":[one("a","A"),one("b","a")]})).1["code"], "recording_type_configuration_invalid");
}

#[test]
fn recording_type_of_a_meeting_needs_the_current_revision() {
    let f = Fake::new();
    let id = meeting(&f, K1, "Planning");
    let (status, body) = f.route("GET", "/records/:id/recording", &[("id", &id)], Value::Null);
    assert_eq!((status, body["metadata"].clone()), (200, Value::Null));
    let put = |rev: i64, ty: &str| {
        f.route("PUT", "/records/:id/recording/type", &[("id", &id)], json!({"expectedRevision":rev,"typeId":ty}))
    };
    assert_eq!(put(0, "nope"), (400, json!({"code":"recording_type_unavailable"})));
    let (status, body) = put(0, "idea");
    assert_eq!((status, body["metadata"]["typeId"].clone(), body["metadata"]["revision"].clone()), (200, json!("idea"), json!(1)));
    assert_eq!(body["metadata"]["titleSource"], "user");
    assert_eq!(put(0, "idea"), (409, json!({"code":"recording_revision_conflict"})));
    let (status, body) = f.route("PUT", "/records/:id/recording/type", &[("id", MISSING)], json!({"expectedRevision":0,"typeId":"idea"}));
    assert_eq!((status, body), (404, json!({"code":"meeting_not_found"})));
}

#[test]
fn pasted_transcript_creates_once_and_replays() {
    let f = Fake::new();
    let body = json!({"requestKey":K1,"transcript":"Hello there","typeId":"idea","recordedAt":"2026-01-02T03:04:05Z"});
    let (status, first) = f.route("POST", "/manual-transcripts", &[], body.clone());
    assert_eq!((status, first["replayed"].clone()), (201, json!(false)));
    let id = first["meetingId"].as_str().unwrap().to_owned();
    let (status, again) = f.route("POST", "/manual-transcripts", &[], body.clone());
    assert_eq!((status, again), (200, json!({"meetingId":id,"replayed":true})));
    let mut changed = body.clone();
    changed["transcript"] = json!("Different");
    assert_eq!(f.route("POST", "/manual-transcripts", &[], changed), (409, json!({"code":"recording_request_conflict"})));
    let (status, read) = f.route_query(
        "GET",
        "/records/:id/transcript",
        &[("id", &id)],
        &[("maxSegments", json!("10")), ("maxCharacters", json!("1000"))],
        Value::Null,
    );
    assert_eq!(status, 200);
    assert_eq!(read["snapshot"]["segments"][0]["text"], "Hello there");
    let (_, rec) = f.route("GET", "/records/:id/recording", &[("id", &id)], Value::Null);
    assert_eq!(rec["metadata"]["source"], "manual-transcript");
    assert_eq!(rec["metadata"]["recordedAt"], "2026-01-02T03:04:05.000Z");
    assert_eq!(rec["metadata"]["titleSource"], "automatic");
}

#[test]
fn pasted_transcript_refusals() {
    let f = Fake::new();
    let post = |b: Value| f.route("POST", "/manual-transcripts", &[], b);
    assert_eq!(post(json!({"requestKey":K1,"transcript":"  "})), (400, json!({"code":"recording_invalid_input"})));
    assert_eq!(post(json!({"requestKey":K1,"transcript":"x","extra":1})).1["code"], "recording_invalid_input");
    assert_eq!(post(json!({"requestKey":K1,"transcript":"x","typeId":"nope"})), (400, json!({"code":"recording_type_unavailable"})));
    assert_eq!(post(json!({"requestKey":K2,"transcript":"x","recordedAt":"2026-01-02"})).1["error"], "body/recordedAt must match format \"date-time\"");
}

#[test]
fn another_person_sees_nothing() {
    let f = Fake::new();
    let id = meeting(&f, K1, "Private");
    f.route("PUT", "/records/:id/recording/type", &[("id", &id)], json!({"expectedRevision":0,"typeId":"idea"}));
    f.as_actor(B);
    assert_eq!(f.route("GET", "/records/:id/recording", &[("id", &id)], Value::Null).0, 404);
    assert_eq!(f.route("GET", "/recording-types", &[], Value::Null).1["revision"], 0);
    f.as_actor(A);
    assert_eq!(f.route("GET", "/records/:id/recording", &[("id", &id)], Value::Null).1["metadata"]["typeId"], "idea");
}
