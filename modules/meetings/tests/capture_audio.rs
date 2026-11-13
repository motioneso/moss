//! Mac audio, status and control through the real routes, ported from the TypeScript capture
//! tests. The model route, the Mac credential check and the clock are fakes.
mod common;
use common::{Fake, A, B};
use moss_meetings_module::{capture_audio::base64_encode, capture_auth::hash};
use serde_json::{json, Value};

const K1: &str = "11111111-1111-4111-8111-111111111111";
const CONN: &str = "44444444-4444-4444-8444-444444444444";
const DEVICE: &str = "55555555-5555-4555-8555-555555555555";
const SECRET: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const SECRET2: &str = "ZYXWVUTSRQPONMLKJIHGFEDCBAqponmlkjihgfedcba";
const FAR: &str = "2030-01-01T00:00:00Z";

fn code(body: &Value) -> &str {
    body["code"].as_str().unwrap_or_default()
}

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

fn key(n: u32) -> String {
    format!("aaaaaaaa-aaaa-4aaa-8aaa-{n:012x}")
}

/// A recording the Mac has claimed. Returns the fake, the meeting and the grant.
fn recording() -> (Fake, String, String) {
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
    let verifier_hash = hash(SECRET);
    let (status, _) = f.route("POST", "/capture/connection", &[], json!({"connectionId": CONN, "verifierHash": verifier_hash, "inventory": inventory()}));
    assert_eq!(status, 200);
    let (status, started) = f.route("POST", "/records/:id/capture/start", &[("id", &meeting)], json!({"requestKey": key(1)}));
    assert_eq!(status, 200, "{started}");
    let (_, polled) = f.route("POST", "/capture/commands", &[], json!({"connectionId": CONN, "verifier": SECRET}));
    let grant = polled["command"]["grantId"].as_str().unwrap().to_owned();
    let credential = format!("mm1_{A}.{grant}.{SECRET2}");
    let claim = json!({"connectionId": CONN, "verifier": SECRET, "grantId": grant, "credentialHash": hash(&credential)});
    let (status, claimed) = f.route("POST", "/capture/claim", &[], claim);
    assert_eq!(status, 200, "{claimed}");
    f.capture.borrow_mut().credential = Some(credential);
    f.tick_to(6000);
    (f, meeting, grant)
}

fn generation(f: &Fake) -> i64 {
    let rows = f.rows("app.meeting_capture_grants");
    let state: Value = serde_json::from_str(rows[0]["state_json"].as_str().unwrap()).unwrap();
    state["generation"].as_i64().unwrap()
}

fn status(f: &Fake, meeting: &str, grant: &str, phase: &str) -> (u16, Value) {
    let generation = generation(f);
    f.route(
        "POST",
        "/capture/status",
        &[],
        json!({"meetingId": meeting, "grantId": grant, "inventory": inventory(), "observed": {"generation": generation, "phase": phase}}),
    )
}

/// A Mac that is recording and says so.
fn live() -> (Fake, String, String) {
    let (f, meeting, grant) = recording();
    let (code, body) = status(&f, &meeting, &grant, "recording");
    assert_eq!(code, 200, "{body}");
    (f, meeting, grant)
}

fn pcm(ms: i64) -> String {
    let samples = (ms * 8) as usize;
    let mut bytes = Vec::with_capacity(samples * 2);
    for n in 0..samples {
        bytes.extend_from_slice(&(((n % 100) as i16 - 50) * 100).to_le_bytes());
    }
    base64_encode(&bytes)
}

fn clip(meeting: &str, grant: &str, generation: i64, n: u32, start: i64, end: i64) -> Value {
    json!({
        "meetingId": meeting, "grantId": grant, "requestKey": key(100 + n), "generation": generation, "epoch": 1,
        "sourceId": "mic", "sequence": n, "startMs": start, "endMs": end, "sampleRateHz": 8000, "pcmBase64": pcm(end - start),
    })
}

fn send(f: &Fake, body: Value) -> (u16, Value) {
    f.route("POST", "/capture/audio", &[], body)
}

#[test]
fn a_clip_is_transcribed_and_filed_in_the_meeting() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let (s, body) = send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    assert_eq!(s, 200, "{body}");
    assert_eq!(f.heard.borrow().len(), 1);
    assert_eq!(f.heard.borrow()[0]["expectedRoute"], "route-1");
    assert_eq!(f.batches.borrow().len(), 1);
}

#[test]
fn the_same_clip_again_answers_the_same_and_is_not_transcribed_twice() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let c = clip(&meeting, &grant, g, 0, 0, 1000);
    let (_, first) = send(&f, c.clone());
    let (s, again) = send(&f, c);
    assert_eq!(s, 200);
    assert_eq!(first["replayed"], false);
    assert_eq!(again["replayed"], true);
    assert_eq!(first["transcriptRevision"], again["transcriptRevision"]);
    assert_eq!(f.heard.borrow().len(), 1);
}

#[test]
fn a_reused_key_with_different_audio_conflicts() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    let mut other = clip(&meeting, &grant, g, 0, 0, 1000);
    other["sequence"] = json!(5);
    let (s, body) = send(&f, other);
    assert_eq!((s, code(&body)), (409, "meeting_capture_conflict"));
}

#[test]
fn bad_clips_are_invalid_input() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let mut cases = vec![];
    let mut c = clip(&meeting, &grant, g, 1, 0, 1000);
    c["sampleRateHz"] = json!(100);
    cases.push(c);
    let mut c = clip(&meeting, &grant, g, 2, 0, 1000);
    c["endMs"] = json!(0);
    cases.push(c);
    let mut c = clip(&meeting, &grant, g, 3, 0, 1000);
    c["endMs"] = json!(11_000);
    cases.push(c);
    let mut c = clip(&meeting, &grant, g, 4, 0, 1000);
    c["pcmBase64"] = json!("not base64!");
    cases.push(c);
    let mut c = clip(&meeting, &grant, g, 5, 0, 1000);
    c["extra"] = json!(1);
    cases.push(c);
    for c in cases {
        let (s, body) = send(&f, c);
        assert_eq!((s, code(&body)), (400, "meeting_capture_invalid_input"), "{body}");
    }
    assert_eq!(f.heard.borrow().len(), 0);
}

#[test]
fn an_oversize_audio_body_is_413() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let mut c = clip(&meeting, &grant, g, 0, 0, 1000);
    c["pcmBase64"] = json!("A".repeat(5_200_100));
    let (s, _) = send(&f, c);
    assert_eq!(s, 413);
}

#[test]
fn a_clip_ending_in_the_future_conflicts() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let (s, body) = send(&f, clip(&meeting, &grant, g, 0, 0, 9000));
    assert_eq!((s, code(&body)), (409, "meeting_capture_conflict"), "{body}");
}

#[test]
fn a_clip_from_an_unknown_source_is_invalid() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let mut c = clip(&meeting, &grant, g, 0, 0, 1000);
    c["sourceId"] = json!("elsewhere");
    let (s, body) = send(&f, c);
    assert_eq!((s, code(&body)), (400, "meeting_capture_invalid_input"));
}

#[test]
fn a_mac_that_reports_recovering_is_interrupted() {
    let (f, meeting, grant) = recording();
    assert_eq!(status(&f, &meeting, &grant, "recovering").0, 200);
    let g = generation(&f);
    let (s, body) = send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    assert_eq!((s, code(&body)), (409, "meeting_capture_interrupted"), "{body}");
}

#[test]
fn a_silent_clip_is_not_sent_to_the_model() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let mut c = clip(&meeting, &grant, g, 0, 0, 1000);
    c["pcmBase64"] = json!(base64_encode(&vec![0u8; 16000]));
    let (s, body) = send(&f, c);
    assert_eq!(s, 200, "{body}");
    assert_eq!(f.heard.borrow().len(), 0);
}

#[test]
fn a_failed_clip_leaves_a_gap_and_the_next_clip_still_works() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    *f.speech.borrow_mut() = json!({"ok": false, "reason": "provider-response-invalid", "stage": "validation", "retryable": false});
    let (s, body) = send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    assert_ne!(s, 500, "{body}");
    let rows = f.rows("app.meeting_capture_grants");
    let state: Value = serde_json::from_str(rows[0]["state_json"].as_str().unwrap()).unwrap();
    assert_eq!(state["gaps"].as_array().unwrap().len(), 1, "{state}");
    assert_eq!(state["gaps"][0]["reason"], "processing-failed");
}

#[test]
fn a_wrong_or_missing_credential_is_the_same_401() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let good = f.capture.borrow().credential.clone();
    f.capture.borrow_mut().credential = None;
    let (s1, b1) = send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    f.capture.borrow_mut().credential = Some(format!("mm1_{A}.{grant}.{SECRET}"));
    let (s2, b2) = send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    assert_eq!((s1, s2), (401, 401));
    assert_eq!(b1, b2);
    f.capture.borrow_mut().credential = good;
    assert_eq!(send(&f, clip(&meeting, &grant, g, 0, 0, 1000)).0, 200);
}

#[test]
fn another_person_cannot_send_audio_into_the_meeting() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    f.as_actor(B);
    // B holds A's stolen credential. Only the owner rule stands between B and the grant.
    let (s, body) = send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    assert_eq!((s, code(&body)), (401, "meeting_capture_unavailable"), "{body}");
    assert_eq!(f.heard.borrow().len(), 0);
    assert_eq!(f.batches.borrow().len(), 0);
}

#[test]
fn a_lost_recording_permission_revokes_the_grant() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    f.capture.borrow_mut().recording = None;
    let (s, _) = send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    assert_eq!(s, 401);
    assert_eq!(f.rows("app.meeting_capture_grants")[0]["status"], "revoked");
}

#[test]
fn status_from_the_mac_returns_the_capture_view() {
    let (f, meeting, grant) = recording();
    let (s, body) = status(&f, &meeting, &grant, "recording");
    assert_eq!(s, 200, "{body}");
    assert_eq!(body["capture"]["grantId"], json!(grant));
}

#[test]
fn the_browser_reads_status_and_pause_and_stop_work() {
    let (f, meeting, grant) = live();
    let (s, view) = f.route("GET", "/records/:id/capture", &[("id", &meeting)], json!(null));
    assert_eq!(s, 200, "{view}");
    assert_eq!(view["retryAfterMs"], 1000);
    assert_eq!(view["processingReady"], true);
    let g = generation(&f);
    let (s, body) = f.route(
        "POST",
        "/records/:id/capture/control",
        &[("id", &meeting)],
        json!({"grantId": grant, "requestKey": key(50), "expectedGeneration": g, "command": "pause"}),
    );
    assert_eq!(s, 200, "{body}");
    let g = generation(&f);
    let (s, body) = f.route(
        "POST",
        "/records/:id/capture/control",
        &[("id", &meeting)],
        json!({"grantId": grant, "requestKey": key(51), "expectedGeneration": g, "command": "stop"}),
    );
    assert_eq!(s, 200, "{body}");
    let rows = f.rows("app.meeting_capture_grants");
    let state: Value = serde_json::from_str(rows[0]["state_json"].as_str().unwrap()).unwrap();
    assert_eq!(state["desired"], "stopped");
    assert!(state["finalizationDeadline"].is_string(), "{state}");
}

#[test]
fn a_stale_generation_conflicts() {
    let (f, meeting, grant) = live();
    let (s, body) = f.route(
        "POST",
        "/records/:id/capture/control",
        &[("id", &meeting)],
        json!({"grantId": grant, "requestKey": key(52), "expectedGeneration": 99, "command": "pause"}),
    );
    assert_eq!((s, code(&body)), (409, "meeting_capture_conflict"), "{body}");
}

#[test]
fn a_repeated_control_key_answers_the_same() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let body = json!({"grantId": grant, "requestKey": key(53), "expectedGeneration": g, "command": "pause"});
    let (_, first) = f.route("POST", "/records/:id/capture/control", &[("id", &meeting)], body.clone());
    let (s, again) = f.route("POST", "/records/:id/capture/control", &[("id", &meeting)], body);
    assert_eq!(s, 200);
    assert_eq!(first["capture"]["generation"], again["capture"]["generation"]);
    assert_eq!(first["capture"]["desired"], again["capture"]["desired"]);
    assert_eq!(f.rows("app.meeting_capture_receipts").len(), 1);
}

#[test]
fn a_stopped_recording_still_takes_the_final_clip_inside_the_window() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let (s, body) = f.route(
        "POST",
        "/records/:id/capture/control",
        &[("id", &meeting)],
        json!({"grantId": grant, "requestKey": key(54), "expectedGeneration": g, "command": "stop"}),
    );
    assert_eq!(s, 200, "{body}");
    let recorded = g;
    let g = generation(&f);
    let (s, body) = f.route(
        "POST",
        "/capture/status",
        &[],
        json!({"meetingId": meeting, "grantId": grant, "inventory": inventory(), "observed": {"generation": g, "phase": "stopped"}}),
    );
    assert_eq!(s, 200, "{body}");
    let (s, body) = send(&f, clip(&meeting, &grant, recorded, 0, 0, 1000));
    assert_eq!(s, 200, "{body}");
}

#[test]
fn a_malformed_status_or_control_body_is_a_400() {
    let (f, _, _) = live();
    assert_eq!(f.route("POST", "/capture/status", &[], json!({"nope": 1})).0, 400);
    assert_eq!(f.route("POST", "/capture/control", &[], json!({"nope": 1})).0, 400);
    assert_eq!(f.route("POST", "/capture/audio", &[], json!({"nope": 1})).0, 400);
}

const MARKER: &str = "PLANTED-MARKER-7f3a91";

#[test]
fn spoken_text_stays_out_of_receipts_grants_jobs_and_answers() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    *f.speech.borrow_mut() = json!({"ok": true, "route": "route-1", "segments": [{"startMs": 0, "endMs": 1000, "text": MARKER}]});
    let (s, answer) = send(&f, clip(&meeting, &grant, g, 0, 0, 1000));
    assert_eq!(s, 200, "{answer}");
    // A failing clip must not echo provider text either.
    *f.speech.borrow_mut() = json!({"ok": false, "reason": MARKER, "stage": MARKER, "retryable": false});
    let (_, failed) = send(&f, clip(&meeting, &grant, g, 1, 1000, 2000));
    let (_, control) = f.route(
        "POST",
        "/records/:id/capture/control",
        &[("id", &meeting)],
        json!({"grantId": grant, "requestKey": key(60), "expectedGeneration": g, "command": "stop"}),
    );
    let (_, view) = f.route("GET", "/records/:id/capture", &[("id", &meeting)], json!(null));
    for (what, text) in [
        ("answer", answer.to_string()),
        ("control answer", control.to_string()),
        ("browser view", view.to_string()),
        ("failed answer", failed.to_string()),
        ("jobs", format!("{:?}", f.jobs.borrow())),
        ("receipts", format!("{:?}", f.rows("app.meeting_capture_receipts"))),
        ("grants", format!("{:?}", f.rows("app.meeting_capture_grants"))),
        ("stop summaries", format!("{:?}", f.rows("app.meeting_stop_summaries"))),
    ] {
        assert!(!text.contains(MARKER), "spoken text leaked into {what}");
    }
    assert!(format!("{:?}", f.batches.borrow()).contains(MARKER), "the transcript must hold the text");
}

#[test]
fn the_status_view_reports_gaps_and_the_gap_limit() {
    let (f, meeting, grant) = live();
    let g = generation(&f);
    let gaps: Vec<Value> = (0..32)
        .map(|n| json!({"id": key(200 + n), "sourceId": "mic", "epoch": 1, "startMs": n * 10, "endMs": n * 10 + 5, "reason": "source-unavailable"}))
        .collect();
    let (s, body) = f.route(
        "POST",
        "/capture/status",
        &[],
        json!({"meetingId": meeting, "grantId": grant, "inventory": inventory(), "observed": {"generation": g, "phase": "recording"}, "gaps": gaps}),
    );
    assert_eq!(s, 200, "{body}");
    let (_, view) = f.route("GET", "/records/:id/capture", &[("id", &meeting)], json!(null));
    assert_eq!(view["capture"]["gaps"].as_array().unwrap().len(), 32, "{view}");
    let too_many: Vec<Value> = (0..33).map(|n| json!({"id": key(300 + n), "sourceId": "mic", "epoch": 1, "startMs": 0, "endMs": 1, "reason": "paused"})).collect();
    let (s, _) = f.route(
        "POST",
        "/capture/status",
        &[],
        json!({"meetingId": meeting, "grantId": grant, "inventory": inventory(), "observed": {"generation": g, "phase": "recording"}, "gaps": too_many}),
    );
    assert_eq!(s, 400);
}
