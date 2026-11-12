//! A title or note must never reach an error, a job payload or a log-shaped value.
mod common;
use common::Fake;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

const MARKER: &str = "PLANTED-MARKER-7f3a91";
const K1: &str = "11111111-1111-4111-8111-111111111111";

/// A host whose every call fails with text that includes the request it was given.
struct Leaky;
impl Host for Leaky {
    fn call(&self, _: &str, _: &str, _: &str, parameters: Value) -> Result<Value> {
        Err(Error::new(&format!("database said no to {parameters}")))
    }
}

fn contains_marker(value: &Value) -> bool {
    value.to_string().contains(MARKER)
}

#[test]
fn a_failing_host_never_puts_request_text_in_the_response() {
    let routes: [(&str, &str, Value); 4] = [
        ("POST", "/records", json!({"requestKey":K1,"title":MARKER})),
        ("PUT", "/records/:id/notes", json!({"requestKey":K1,"expectedRevision":0,"personalNotes":MARKER})),
        ("PUT", "/records/:id/title", json!({"title":MARKER,"expectedTitle":MARKER})),
        ("PUT", "/preferences", json!({"transcriptLanguage":"en","transcriptVocabulary":[MARKER]})),
    ];
    for (method, path, body) in routes {
        let request = moss_module_sdk::RouteRequest {
            method: method.into(),
            path: path.into(),
            params: [("id".to_owned(), K1.to_owned())].into(),
            query: Default::default(),
            body,
        };
        let response = moss_meetings_module::route(&Leaky, request);
        assert_eq!(response.status, 500, "{method} {path}");
        assert!(!contains_marker(&response.body), "{method} {path} leaked: {}", response.body);
    }
}

#[test]
fn failures_through_the_entry_point_carry_fixed_text() {
    let payload = json!({"method":"POST","path":"/records","params":{},"query":{},
        "body":{"requestKey":K1,"title":MARKER}})
    .to_string();
    let out = moss_meetings_module::handle(&Leaky, "route", &payload).unwrap();
    assert!(!out.contains(MARKER));
    let err = moss_meetings_module::handle(&Leaky, "job", &json!({"meetingId":K1,"title":MARKER}).to_string())
        .unwrap_err();
    assert!(!err.to_string().contains(MARKER));
    let err = moss_meetings_module::handle(&Leaky, "job", &format!("not json {MARKER}")).unwrap_err();
    assert!(!err.to_string().contains(MARKER));
    let err = moss_meetings_module::handle(&Leaky, "api", &format!("{{\"name\":\"{MARKER}\"}}")).unwrap_err();
    assert!(!err.to_string().contains(MARKER));
    let err = moss_meetings_module::handle(&Leaky, MARKER, "{}").unwrap_err();
    assert!(!err.to_string().contains(MARKER));
}

#[test]
fn a_job_payload_with_any_content_key_is_refused() {
    use moss_meetings_module::jobs::is_metadata_only;
    assert!(is_metadata_only(&json!({"queue":"meetings.stop-summary","parameters":{"meeting-id":K1}})));
    assert!(!is_metadata_only(&json!({"queue":"meetings.stop-summary","parameters":{"meeting-id":K1,"text":MARKER}})));
    for key in ["title", "personalNotes", "notes", "transcript", "prompt", "secret", "text"] {
        assert!(!is_metadata_only(&json!({"meetingId":K1, key: MARKER})), "{key} was accepted");
    }
    assert!(!is_metadata_only(&json!("a string")));
    assert!(!is_metadata_only(&json!([{"meetingId":K1}])));
}

#[test]
fn only_the_three_queues_are_declared() {
    assert_eq!(
        moss_meetings_module::jobs::QUEUES,
        ["meetings.recording-notice", "meetings.stop-summary", "meetings.recording-import"]
    );
}

#[test]
fn normal_use_makes_no_job_or_logging_call() {
    let f = Fake::new();
    let (_, made) = f.route("POST", "/records", &[], json!({"requestKey":K1,"title":MARKER}));
    let id = made["meeting"]["id"].as_str().unwrap().to_owned();
    f.route(
        "PUT",
        "/records/:id/notes",
        &[("id", &id)],
        json!({"requestKey":K1,"expectedRevision":0,"personalNotes":MARKER}),
    );
    f.route("DELETE", "/records/:id", &[("id", &id)], Value::Null);
    for call in f.calls.borrow().iter() {
        assert!(
            call.starts_with("db.query.app.meeting_") || call.starts_with("context."),
            "unexpected host port use: {call}"
        );
        assert!(!call.contains(MARKER));
    }
}
