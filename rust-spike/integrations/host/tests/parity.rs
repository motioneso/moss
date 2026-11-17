//! Replays the old view code's output (fixtures/view-cases.json) and checks the manifest copy.
use moss_integrations::sortmap::parse_sort_map;
use moss_integrations_host::{manifest, store::Row, view};
use serde_json::Value;

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

fn row_from(v: &Value) -> Row {
    Row {
        id: v["id"].as_str().unwrap().into(),
        name: v["name"].as_str().unwrap().into(),
        kind: v["kind"].as_str().unwrap().into(),
        url: v["url"].as_str().unwrap().into(),
        credential_placement: Some(v["credentialPlacement"].clone()).filter(|p| !p.is_null()),
        has_credential: v["hasCredential"].as_bool().unwrap(),
        enabled: v["enabled"].as_bool().unwrap(),
        base_url: v["baseUrl"].as_str().map(str::to_owned),
        spec_pasted: v["specPasted"].as_bool().unwrap(),
        enabled_groups: strings(&v["enabledGroups"]),
        enabled_tools: strings(&v["enabledTools"]),
        muted_tools: strings(&v["mutedTools"]),
        unsuppressed_tools: strings(&v["unsuppressedTools"]),
        classifier_enabled: v["classifierEnabled"].as_bool().unwrap(),
        classifier_sort: parse_sort_map(&v["classifierSort"]),
        classifier_kept_out_tools: strings(&v["classifierKeptOutTools"]),
        discovered_tools: serde_json::from_value(v["discoveredTools"].clone()).unwrap(),
        last_discovery_at: v["lastDiscoveryAt"].as_str().map(str::to_owned),
        last_error: v["lastError"].as_str().map(str::to_owned),
    }
}

#[test]
fn detail_matches_the_old_view() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../fixtures/view-cases.json")).unwrap();
    assert!(cases.len() >= 10);
    let now_ms = chrono::DateTime::parse_from_rfc3339("2026-11-17T12:00:00.000Z").unwrap().timestamp_millis();
    for case in &cases {
        let row = row_from(&case["row"]);
        let options = view::ViewOptions { model_ready: case["modelReady"].as_bool().unwrap(), now_ms };
        let got = view::detail(&row, options);
        assert_eq!(got, case["expected"], "case {}", case["name"]);
        let summary = view::summary(&row);
        for key in ["id", "name", "kind", "url", "enabled", "hasCredential", "toolCount", "enabledToolCount", "lastDiscoveryAt", "lastError"] {
            assert_eq!(summary[key], case["expected"][key], "summary {key} in {}", case["name"]);
        }
        assert_eq!(summary.as_object().unwrap().len(), 10);
    }
}

#[test]
fn manifest_matches_the_old_manifest() {
    let want: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
    assert_eq!(manifest::manifest(), want);
    assert_eq!(want["id"], "integrations");
    assert_eq!(manifest::declared_routes().len(), 10);
    assert_eq!(manifest::deletion_tables(), ["app.integration_connections"]);
    let hash = manifest::manifest_hash();
    assert!(hash.starts_with("sha256:") && hash.len() == 71);
    for spec in manifest::queue_specs() {
        spec.validate().unwrap();
    }
    let queues: Vec<_> = want["jobs"].as_array().unwrap().iter().map(|j| j["queueName"].as_str().unwrap().to_owned()).collect();
    let ours: Vec<_> = manifest::queue_specs().into_iter().map(|s| s.name).collect();
    assert_eq!(queues, ours);
}
