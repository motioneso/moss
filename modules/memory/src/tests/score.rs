//! Replays cases made by the old recall service (modules/memory/tools/score-oracle.ts).
use moss_memory::score::{core, recall, Options};
use serde_json::{json, Value};

#[test]
fn every_case_matches_the_old_service() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../tools/score-cases.json")).unwrap();
    assert!(cases.len() >= 8);
    for case in cases {
        let options = Options {
            limit: case["options"]["limit"].as_u64().map(|n| n as usize),
            include_inactive: case["options"]["includeInactive"] == true,
            include_low_confidence: case["options"]["includeLowConfidence"] == true,
        };
        let host = &case["host"];
        let got = recall(case["query"].as_str().unwrap(), host, &options);
        assert_eq!(
            Value::Array(got),
            case["expected"]["recall"]["items"],
            "recall: {}",
            case["name"]
        );
        let facts: Vec<Value> = host["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["fact"].clone())
            .collect();
        let got = core(&json!({"facts": facts, "names": host["names"]}));
        assert_eq!(Value::Array(got), case["expected"]["core"]["items"], "core: {}", case["name"]);
    }
}
