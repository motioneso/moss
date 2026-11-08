use moss_notes::{blocks, identity};
use serde_json::{json, Value};

fn run(op: &str, v: &Value) -> Result<Value, String> {
    let block = |key: &str| serde_json::from_value::<blocks::Block>(v[key].clone()).unwrap();
    let optional =
        |key: &str| serde_json::from_value::<Option<blocks::Block>>(v[key].clone()).unwrap();
    let note = v["note"].as_str().unwrap_or("");
    let result =
        match op {
            "render" => blocks::render(v["id"].as_str().unwrap(), v["text"].as_str().unwrap())
                .map(|x| json!(x)),
            "inspect" => blocks::inspect(note, &block("block")).map(|x| json!(x)),
            "append" => blocks::append(note, &block("block")).map(|x| json!(x)),
            "change" => {
                blocks::change(note, &block("before"), optional("after").as_ref()).map(|x| json!(x))
            }
            "cleanup" => blocks::cleanup(
                note,
                &serde_json::from_value::<Vec<blocks::Block>>(v["variants"].clone()).unwrap(),
            )
            .map(|x| json!(x)),
            "reconcile" => blocks::reconcile(
                note,
                optional("before").as_ref(),
                optional("after").as_ref(),
            )
            .map(|x| json!(x)),
            "block_id" => identity::block_id(
                v["owner"].as_str().unwrap(),
                &serde_json::from_value(v["source"].clone()).unwrap(),
            )
            .map(|x| json!(x)),
            "fallback" => identity::fallback_reference(
                &serde_json::from_value(v["source"].clone()).unwrap(),
                v["side"].as_str().unwrap(),
            )
            .map(|x| json!(x)),
            "snapshot" => identity::snapshot_key(&serde_json::from_value(v.clone()).unwrap())
                .map(|x| json!(x)),
            _ => panic!("unknown parity operation"),
        };
    result.map_err(|e| e.to_string())
}
#[test]
fn matches_legacy_typescript_results() {
    let vectors: Vec<Value> = include_str!("domain-vectors.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        vectors.len() >= 90,
        "the differential corpus must stay populated"
    );
    for (i, v) in vectors.iter().enumerate() {
        let result = match run(v["op"].as_str().unwrap(), &v["input"]) {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error}),
        };
        assert_eq!(
            result, v["expected"],
            "legacy differential vector {i}, operation {}",
            v["op"]
        );
    }
}
#[test]
fn edits_preserve_unrelated_text_and_refuse_ambiguous_changes() {
    assert_eq!(
        moss_notes::edit("start 😀 old end", "old", "new").unwrap(),
        "start 😀 new end"
    );
    assert_eq!(moss_notes::edit("aaa", "aa", "b").unwrap(), "ba");
    assert!(moss_notes::edit("x", "", "new").is_err());
    assert!(moss_notes::edit("old old", "old", "new").is_err());
    assert!(moss_notes::edit("unrelated", "old", "new").is_err());
}
