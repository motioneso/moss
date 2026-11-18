mod common;
use common::*;
use moss_backtrack_module::{handle, jobs, lifecycle};
use serde_json::json;

#[test]
fn the_export_section_returns_the_hosts_rows() {
    let out = handle(&Fake::default(), "api", &json!({"name":"collectBacktrackSegmentsExportSection","parameters":{}}).to_string()).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap(), json!({"ok":[{"id":"x"}]}));
}

#[test]
fn owned_tables_are_the_three_legacy_tables() {
    assert_eq!(lifecycle::OWNED_TABLES, ["app.backtrack_segments", "app.backtrack_preferences", "app.backtrack_deletions"]);
}

#[test]
fn the_upkeep_job_runs_under_the_lock_and_reports_counts() {
    let host = Fake::default();
    let out = handle(&host, "job", &json!({"queue":"backtrack.upkeep","parameters":{}}).to_string()).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap(), json!({"segments":2,"markers":1}));
    assert_eq!(host.ops(), ["kv.lock", "kv.expired", "kv.upkeep", "kv.stale"]);
}

#[test]
fn job_payloads_with_content_or_unknown_queues_are_refused() {
    for payload in [
        json!({"queue":"backtrack.upkeep","parameters":{"body":"text"}}),
        json!({"queue":"backtrack.upkeep","body":"text"}),
        json!({"queue":"backtrack.index","parameters":{"segmentIds":["a"]}}),
        json!({"queue":"backtrack.somethingelse","parameters":{}}),
    ] {
        assert!(handle(&Fake::default(), "job", &payload.to_string()).is_err(), "{payload}");
    }
    assert!(jobs::is_metadata_only(&json!({"queue":"backtrack.upkeep","parameters":{}})));
}

#[test]
fn chat_classes_match_the_legacy_manifest() {
    use moss_backtrack_module::approval::CHAT_CLASSES;
    assert_eq!(CHAT_CLASSES, [("GET","/status","read"),("PUT","/preferences","blocked"),("DELETE","/segments","destructive"),("POST","/ingest","blocked")]);
    let card = moss_backtrack_module::approval::prepare("deleteSegments", Some("{}"), Some("{}"), Some("{}")).unwrap();
    assert!(card["title"].as_str().unwrap().contains("Backtrack"));
}
