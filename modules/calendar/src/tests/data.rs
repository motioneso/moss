use moss_calendar::{events::serialize, model, settings};
use serde_json::json;

#[test]
fn metadata_compatibility_excludes_private_provider_fields() {
    let mut event = json!({"external_id":"jfb0123456789abcdefghijklmnopqrstuv","external_metadata":{"jarvisCreated":false,"providerSecret":"never return"}});
    assert_eq!(serialize(&event)["isMossBlock"], false);
    event["external_metadata"] =
        json!({"jarvisCreated":true,"source":"outlook-browser-calendar","mirrorUnconfirmed":true});
    let out = serialize(&event);
    assert_eq!(out["isMossBlock"], false);
    assert_eq!(out["readOnly"], true);
    assert_eq!(out["unconfirmed"], true);
    assert!(out.get("external_metadata").is_none());
}
#[test]
fn intent_patches_keep_omission_clear_null_and_clear_empty_lists() {
    let base = json!({"priorityTaskIds":["one"],"capacity":"full","notes":"note","corrections":[],"commitments":[]});
    assert_eq!(model::merge_intent(&base, None).unwrap(), base);
    assert_eq!(
        model::merge_intent(&base, Some(&json!(null))).unwrap(),
        model::empty_intent()
    );
    let changed =
        model::merge_intent(&base, Some(&json!({"notes":null,"priorityTaskIds":[]}))).unwrap();
    assert_eq!(changed["capacity"], "full");
    assert_eq!(changed["notes"], json!(null));
    assert_eq!(changed["priorityTaskIds"], json!([]));
}
#[test]
fn invalid_dates_and_recorded_placement_are_rejected() {
    assert!(model::day_zone("2026-02-30", "UTC").is_err());
    assert!(model::day_zone("2026-02-28", "not/a-zone").is_err());
    assert!(model::block(&json!({"kind":"focus","actualPlacement":null}), 0).is_err());
    assert!(model::block(&json!({"kind":"focus","pendingChange":{"kind":"add","startsAt":"2026-11-08T10:00:00Z","durationMinutes":4}}),0).is_err());
}
#[test]
fn legacy_settings_fallbacks_preserve_existing_values() {
    let v = settings::derive(
        &json!({"calendar.signal_create_tasks":true,"calendar.signal_suggest_time_blocks":false,"calendar.briefing_lookahead_days":0}),
    );
    assert_eq!(v["prepTaskMode"], "auto");
    assert_eq!(v["timeBlockMode"], "off");
    assert_eq!(v["lookaheadDays"], 0);
}
