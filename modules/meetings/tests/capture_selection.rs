//! Selection and record-command rules ported from the TypeScript capture domain tests.
use moss_meetings_module::capture_errors::{CaptureCode, Failure};
use moss_meetings_module::capture_selection::{record, validate};
use serde_json::{json, Value};

fn inventory() -> Value {
    json!({
        "microphones": [{"deviceId": "mic-uid", "sourceId": "mic", "label": "Microphone"}],
        "applications": [{"applicationId": "com.example.meeting", "appProcessTreeId": "123", "label": "Meeting app"}],
        "computerAudio": {"available": true, "excludedProcessTreeIds": ["moss"]},
        "microphonePermission": "unknown",
        "systemAudioPermission": "granted",
    })
}

fn mic_only() -> Value {
    json!({"mode": "microphone-only", "microphone": {"deviceId": "mic-uid", "sourceId": "mic"}})
}

fn state() -> Value {
    json!({"generation": 1, "desired": "idle", "gapLimitReached": false, "epochs": [], "inventory": inventory()})
}

fn bad() -> Failure {
    Failure::new(CaptureCode::InvalidInput)
}

#[test]
fn microphone_only_needs_the_exact_reported_microphone() {
    assert_eq!(validate(&mic_only(), &inventory()), Ok(()));
    let wrong = json!({"mode": "microphone-only", "microphone": {"deviceId": "mic-uid", "sourceId": "other"}});
    assert_eq!(validate(&wrong, &inventory()), Err(bad()));
    let mut denied = inventory();
    denied["microphonePermission"] = json!("denied");
    assert_eq!(validate(&mic_only(), &denied), Err(bad()));
}

#[test]
fn selected_app_must_match_exactly_one_reported_application() {
    let ok = json!({"mode": "selected-app", "microphone": {"deviceId": "mic-uid", "sourceId": "mic"}, "outputSourceId": "app-out", "appProcessTreeId": "123", "applicationId": "com.example.meeting"});
    assert_eq!(validate(&ok, &inventory()), Ok(()));
    let mut other = ok.clone();
    other["appProcessTreeId"] = json!("999");
    assert_eq!(validate(&other, &inventory()), Err(bad()));
    let mut wrong_id = ok.clone();
    wrong_id["applicationId"] = json!("com.other");
    assert_eq!(validate(&wrong_id, &inventory()), Err(bad()));
}

#[test]
fn output_source_may_not_reuse_a_microphone_source() {
    let reuse = json!({"mode": "selected-app", "microphone": {"deviceId": "mic-uid", "sourceId": "mic"}, "outputSourceId": "mic", "appProcessTreeId": "123"});
    assert_eq!(validate(&reuse, &inventory()), Err(bad()));
    let nul = json!({"mode": "selected-app", "microphone": {"deviceId": "mic-uid", "sourceId": "mic"}, "outputSourceId": "a\u{0}b", "appProcessTreeId": "123"});
    assert_eq!(validate(&nul, &inventory()), Err(bad()));
}

#[test]
fn computer_audio_must_exclude_exactly_the_reported_processes() {
    let ok = json!({"mode": "computer-audio", "microphone": null, "outputSourceId": "all",
        "scope": {"kind": "process-exclusion", "excludedProcessTreeIds": ["moss"]}});
    assert_eq!(validate(&ok, &inventory()), Ok(()));
    let mut extra = ok.clone();
    extra["scope"]["excludedProcessTreeIds"] = json!(["moss", "x"]);
    assert_eq!(validate(&extra, &inventory()), Err(bad()));
    let mut gone = inventory();
    gone["computerAudio"]["available"] = json!(false);
    assert_eq!(validate(&ok, &gone), Err(bad()));
}

#[test]
fn record_opens_an_epoch_and_bumps_the_generation() {
    let mut s = state();
    record(&mut s, &mic_only(), 1, 5000, Some(1000), "route").unwrap();
    assert_eq!(s["desired"], "recording");
    assert_eq!(s["generation"], 2);
    assert_eq!(s["epochs"][0]["epoch"], 1);
    assert_eq!(s["epochs"][0]["generation"], 2);
    assert_eq!(s["epochs"][0]["microphoneLabel"], "Microphone");
    assert_eq!(s["epochs"][0]["endMs"], Value::Null);
}

#[test]
fn record_refuses_stale_generation_revoked_stale_lease_and_epoch_limit() {
    let mut s = state();
    assert_eq!(record(&mut s, &mic_only(), 7, 0, Some(0), ""), Err(Failure::new(CaptureCode::Conflict)));
    assert_eq!(record(&mut s, &mic_only(), 1, 0, Some(30_001), ""), Err(Failure::new(CaptureCode::Interrupted)));
    assert_eq!(record(&mut s, &mic_only(), 1, 0, None, ""), Err(Failure::new(CaptureCode::Interrupted)));
    s["desired"] = json!("revoked");
    assert_eq!(record(&mut s, &mic_only(), 1, 0, Some(0), ""), Err(Failure::new(CaptureCode::Unavailable)));
    let mut full = state();
    full["epochs"] = json!(vec![json!({}); 64]);
    assert_eq!(record(&mut full, &mic_only(), 1, 0, Some(0), ""), Err(Failure::new(CaptureCode::Limit)));
    let mut gaps = state();
    gaps["gapLimitReached"] = json!(true);
    assert_eq!(record(&mut gaps, &mic_only(), 1, 0, Some(0), ""), Err(Failure::new(CaptureCode::Limit)));
}

#[test]
fn source_resolution_never_widens_a_remembered_source() {
    use moss_meetings_module::capture_selection::{resolve_source, saved_selection};
    let unavailable = Failure::new(CaptureCode::SourceUnavailable);
    let prefs = json!({"rememberedSource": null, "defaultCaptureMode": "computer-audio"});
    let source = resolve_source(&prefs, "dev", &inventory()).unwrap();
    assert_eq!(source, json!({"deviceId": "dev", "microphoneId": "mic-uid", "mode": "computer-audio"}));
    let elsewhere = json!({"rememberedSource": {"deviceId": "other", "microphoneId": "mic-uid", "mode": "computer-audio"}, "defaultCaptureMode": "computer-audio"});
    assert_eq!(resolve_source(&elsewhere, "dev", &inventory()), Err(unavailable));
    let app_default = json!({"rememberedSource": null, "defaultCaptureMode": "selected-app"});
    assert_eq!(resolve_source(&app_default, "dev", &inventory()), Err(unavailable));
    let mut two = inventory();
    two["microphones"].as_array_mut().unwrap().push(json!({"deviceId": "m2", "sourceId": "s2", "label": "Two"}));
    assert_eq!(resolve_source(&prefs, "dev", &two), Err(unavailable));
    two["defaultMicrophoneId"] = json!("m2");
    assert_eq!(resolve_source(&prefs, "dev", &two).unwrap()["microphoneId"], "m2");
    let selection = saved_selection(&source, &inventory()).unwrap();
    assert_eq!(selection["scope"]["excludedProcessTreeIds"], json!(["moss"]));
    let gone = json!({"deviceId": "dev", "microphoneId": "missing", "mode": "computer-audio"});
    assert_eq!(saved_selection(&gone, &inventory()), Err(unavailable));
}
