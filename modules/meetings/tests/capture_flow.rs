//! Mac link lifecycle through the real routes, ported from the TypeScript connection and
//! link-security tests. The host's credential answers come from the fake authority.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const K1: &str = "11111111-1111-4111-8111-111111111111";
const K2: &str = "22222222-2222-4222-8222-222222222222";
const K3: &str = "33333333-3333-4333-8333-333333333333";
const CONN: &str = "44444444-4444-4444-8444-444444444444";
const DEVICE: &str = "55555555-5555-4555-8555-555555555555";
const SECRET: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const FAR: &str = "2030-01-01T00:00:00Z";

fn inventory() -> Value {
    json!({
        "defaultMicrophoneId": "mic-uid",
        "microphones": [{"deviceId": "mic-uid", "sourceId": "mic", "label": "Microphone"}],
        "applications": [],
        "computerAudio": {"available": true, "excludedProcessTreeIds": ["moss"]},
        "microphonePermission": "granted",
        "systemAudioPermission": "granted",
    })
}

fn verifier_hash() -> String {
    moss_meetings_module::capture_auth::hash(SECRET)
}

/// A signed-in browser, a linked Mac with recording permission and a model route.
fn ready() -> (Fake, String) {
    let f = Fake::new();
    {
        let mut c = f.capture.borrow_mut();
        c.browser = Some(("66666666-6666-4666-8666-666666666666".into(), FAR.into()));
        c.native = Some((DEVICE.into(), 1, FAR.into()));
        c.recording = Some(FAR.into());
        c.route = Some("route-1".into());
    }
    let (_, made) = f.route("POST", "/records", &[], json!({"requestKey": K1, "title": "Weekly"}));
    let meeting = made["meeting"]["id"].as_str().unwrap().to_owned();
    let (status, _) = register(&f);
    assert_eq!(status, 200);
    (f, meeting)
}

fn register(f: &Fake) -> (u16, Value) {
    f.route("POST", "/capture/connection", &[], json!({"connectionId": CONN, "verifierHash": verifier_hash(), "inventory": inventory()}))
}

fn start(f: &Fake, meeting: &str, key: &str) -> (u16, Value) {
    f.route("POST", "/records/:id/capture/start", &[("id", meeting)], json!({"requestKey": key}))
}

fn code(body: &Value) -> &str {
    body["code"].as_str().unwrap_or_default()
}

#[test]
fn linking_a_mac_lists_it_and_never_starts_capture() {
    let (f, _) = ready();
    let (status, body) = f.route("GET", "/capture/devices", &[], json!(null));
    assert_eq!(status, 200);
    assert_eq!(body["processingReady"], true);
    assert_eq!(body["devices"].as_array().unwrap().len(), 1);
    assert_eq!(body["devices"][0]["busy"], false);
    assert_eq!(f.rows("app.meeting_capture_grants").len(), 0);
}

#[test]
fn a_caller_without_a_credential_is_refused_the_same_way_everywhere() {
    let f = Fake::new();
    for (method, path, body) in [
        ("POST", "/capture/connection", json!({"connectionId": CONN, "verifierHash": verifier_hash(), "inventory": inventory()})),
        ("POST", "/capture/commands", json!({"connectionId": CONN, "verifier": SECRET})),
        ("GET", "/capture/devices", json!(null)),
    ] {
        let (status, answer) = f.route(method, path, &[], body);
        assert_eq!((status, code(&answer)), (401, "meeting_capture_unavailable"), "{path}");
    }
}

#[test]
fn a_malformed_body_is_a_400_with_a_code_only() {
    let (f, _) = ready();
    let (status, body) = f.route("POST", "/capture/connection", &[], json!({"connectionId": "no", "verifierHash": "x", "inventory": {}}));
    assert_eq!((status, code(&body)), (400, "meeting_capture_invalid_input"));
    assert_eq!(body.as_object().unwrap().len(), 1);
    let (status, _) = f.route("POST", "/capture/commands", &[], json!({"connectionId": CONN, "verifier": SECRET, "extra": 1}));
    assert_eq!(status, 400);
}

#[test]
fn a_start_reserves_a_grant_and_queues_one_metadata_only_check() {
    let (f, meeting) = ready();
    let (status, body) = start(&f, &meeting, K2);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["capture"]["desired"], "recording");
    let grants = f.rows("app.meeting_capture_grants");
    assert_eq!(grants.len(), 1);
    assert!(grants[0]["credential_hash"].is_null(), "a start never records by itself");
    let jobs = f.jobs.borrow();
    assert_eq!(jobs.len(), 1);
    let keys: Vec<&String> = jobs[0].1["params"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["grant-id", "sequence"]);
}

#[test]
fn the_same_start_again_answers_with_the_same_grant() {
    let (f, meeting) = ready();
    let (_, first) = start(&f, &meeting, K2);
    let (status, second) = start(&f, &meeting, K2);
    assert_eq!(status, 200);
    assert_eq!(first["capture"]["grantId"], second["capture"]["grantId"]);
    assert_eq!(f.rows("app.meeting_capture_grants").len(), 1);
}

#[test]
fn a_key_used_for_another_meeting_conflicts() {
    let (f, meeting) = ready();
    start(&f, &meeting, K2);
    let (_, other) = f.route("POST", "/records", &[], json!({"requestKey": K3, "title": "Other"}));
    let (status, body) = start(&f, other["meeting"]["id"].as_str().unwrap(), K2);
    assert_eq!((status, code(&body)), (409, "meeting_capture_conflict"));
}

#[test]
fn a_busy_mac_refuses_a_second_start() {
    let (f, meeting) = ready();
    start(&f, &meeting, K2);
    let (_, other) = f.route("POST", "/records", &[], json!({"requestKey": K3, "title": "Other"}));
    let (status, body) = start(&f, other["meeting"]["id"].as_str().unwrap(), "77777777-7777-4777-8777-777777777777");
    assert_eq!((status, code(&body)), (409, "meeting_capture_busy"));
}

#[test]
fn a_start_needs_a_model_route_a_browser_and_a_real_meeting() {
    let (f, meeting) = ready();
    f.capture.borrow_mut().route = None;
    let (status, body) = start(&f, &meeting, K2);
    assert_eq!((status, code(&body)), (503, "meeting_capture_processing_unavailable"));
    f.capture.borrow_mut().route = Some("route-1".into());
    f.capture.borrow_mut().browser = None;
    assert_eq!(start(&f, &meeting, K2).0, 401);
    f.capture.borrow_mut().browser = Some(("66666666-6666-4666-8666-666666666666".into(), FAR.into()));
    assert_eq!(start(&f, "88888888-8888-4888-8888-888888888888", K2).0, 404);
    assert_eq!(f.rows("app.meeting_capture_grants").len(), 0);
}

#[test]
fn the_eleventh_start_in_a_minute_is_rate_limited() {
    let (f, meeting) = ready();
    for i in 0..10 {
        let key = format!("99999999-9999-4999-8999-{i:012}");
        assert_ne!(start(&f, &meeting, &key).0, 429);
    }
    let (status, body) = start(&f, &meeting, "99999999-9999-4999-8999-000000000099");
    assert_eq!((status, code(&body)), (429, "meeting_capture_rate_limited"));
    assert!(body["retryAfterSeconds"].as_u64().unwrap() > 0);
}

#[test]
fn cancelling_before_the_start_blocks_a_late_start_with_that_key() {
    let (f, meeting) = ready();
    let (status, body) = f.route("POST", "/records/:id/capture/cancel-start", &[("id", &meeting)], json!({"requestKey": K2}));
    assert_eq!((status, &body["cancelled"], &body["capture"]), (200, &json!(true), &Value::Null));
    let (status, body) = start(&f, &meeting, K2);
    assert_eq!((status, code(&body)), (409, "meeting_capture_conflict"));
    assert_eq!(f.rows("app.meeting_capture_grants").len(), 0);
}

#[test]
fn cancelling_a_started_grant_stops_it() {
    let (f, meeting) = ready();
    start(&f, &meeting, K2);
    let (status, body) = f.route("POST", "/records/:id/capture/cancel-start", &[("id", &meeting)], json!({"requestKey": K2}));
    assert_eq!(status, 200);
    assert_eq!(body["cancelled"], true);
    assert_eq!(body["capture"]["desired"], "stopped");
}

fn poll(f: &Fake) -> (u16, Value) {
    f.route("POST", "/capture/commands", &[], json!({"connectionId": CONN, "verifier": SECRET}))
}

#[test]
fn the_mac_polls_for_the_command_and_claims_it_once() {
    let (f, meeting) = ready();
    assert_eq!(poll(&f).1["command"], Value::Null);
    start(&f, &meeting, K2);
    let (status, answer) = poll(&f);
    assert_eq!(status, 200);
    let grant = answer["command"]["grantId"].as_str().unwrap().to_owned();
    assert_eq!(answer["command"]["ownerUserId"], A);
    let claim = json!({"connectionId": CONN, "verifier": SECRET, "grantId": grant, "credentialHash": "a".repeat(64)});
    let (status, claimed) = f.route("POST", "/capture/claim", &[], claim.clone());
    assert_eq!(status, 200, "{claimed}");
    assert_eq!(f.rows("app.meeting_capture_grants")[0]["status"], "active");
    assert_eq!(f.route("POST", "/capture/claim", &[], claim).0, 200, "the same claim answers again");
    let other = json!({"connectionId": CONN, "verifier": SECRET, "grantId": grant, "credentialHash": "b".repeat(64)});
    let (status, body) = f.route("POST", "/capture/claim", &[], other);
    assert_eq!((status, code(&body)), (409, "meeting_capture_conflict"));
}

#[test]
fn a_wrong_secret_or_connection_is_refused() {
    let (f, meeting) = ready();
    start(&f, &meeting, K2);
    let wrong = "Z".repeat(43);
    assert_eq!(f.route("POST", "/capture/commands", &[], json!({"connectionId": CONN, "verifier": wrong})).0, 401);
    let elsewhere = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert_eq!(f.route("POST", "/capture/commands", &[], json!({"connectionId": elsewhere, "verifier": SECRET})).0, 401);
}

#[test]
fn a_mac_that_lost_permission_cannot_claim() {
    let (f, meeting) = ready();
    start(&f, &meeting, K2);
    let grant = f.rows("app.meeting_capture_grants")[0]["id"].clone();
    f.capture.borrow_mut().recording = None;
    let claim = json!({"connectionId": CONN, "verifier": SECRET, "grantId": grant, "credentialHash": "a".repeat(64)});
    assert_eq!(f.route("POST", "/capture/claim", &[], claim).0, 401);
}

#[test]
fn the_old_relink_routes_always_answer_410() {
    let (f, _) = ready();
    let attempt = json!({"requestKey": K1, "proofHash": "a".repeat(64), "policyVersion": 1});
    let (status, body) = f.route("POST", "/recording-capability/attempt", &[], attempt.clone());
    assert_eq!((status, code(&body)), (410, "recording_relink_required"));
    let decide = json!({"attemptId": K1, "decision": "approve", "policyVersion": 1});
    let (status, body) = f.route("POST", "/recording-capability/decide", &[], decide.clone());
    assert_eq!((status, code(&body)), (410, "recording_relink_required"));
    assert_eq!(f.route("POST", "/recording-capability/attempt", &[], json!({"requestKey": K1})).0, 400);
    f.capture.borrow_mut().native = None;
    let (status, body) = f.route("POST", "/recording-capability/attempt", &[], attempt);
    assert_eq!((status, code(&body)), (401, "recording_connection_unavailable"));
    f.capture.borrow_mut().browser = None;
    assert_eq!(f.route("POST", "/recording-capability/decide", &[], decide).0, 401);
}

#[test]
fn another_person_sees_no_macs_and_no_grants() {
    let (f, meeting) = ready();
    start(&f, &meeting, K2);
    f.as_actor(B);
    let (_, body) = f.route("GET", "/capture/devices", &[], json!(null));
    assert_eq!(body["devices"].as_array().unwrap().len(), 0);
    assert_ne!(start(&f, &meeting, K3).0, 200);
    assert!(f.rows("app.meeting_capture_grants").iter().all(|g| g["owner_user_id"] == A));
}

#[test]
fn meeting_text_never_reaches_a_failure_or_a_job() {
    let (f, _) = ready();
    let marker = "PLANTED-MARKER-7f3a91";
    let (_, made) = f.route("POST", "/records", &[], json!({"requestKey": K3, "title": marker}));
    let id = made["meeting"]["id"].as_str().unwrap().to_owned();
    f.route("PUT", "/records/:id/notes", &[("id", &id)], json!({"requestKey": K1, "expectedRevision": 0, "personalNotes": marker}));
    let mut seen = vec![start(&f, &id, K2).1];
    seen.push(start(&f, &id, "not-a-key").1);
    f.capture.borrow_mut().route = None;
    seen.push(start(&f, &id, "12121212-1212-4212-8212-121212121212").1);
    seen.push(f.route("POST", "/records/:id/capture/cancel-start", &[("id", &id)], json!({"requestKey": K2})).1);
    for answer in &seen {
        assert!(!answer.to_string().contains(marker), "{answer}");
    }
    assert!(!f.jobs.borrow().iter().any(|(_, p)| p.to_string().contains(marker)));
}
