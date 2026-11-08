use moss_people::{matching, notes_format};
use serde_json::{json, Value};

#[test]
fn existing_typescript_core_vectors() {
    let mut vectors: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/core-parity.json")).unwrap();
    vectors.extend(
        serde_json::from_str::<Vec<Value>>(include_str!("fixtures/note-lines-parity.json"))
            .unwrap(),
    );
    for (index, case) in vectors.iter().enumerate() {
        let text = |name: &str| case[name].as_str().unwrap();
        let actual = match text("op") {
            "normalize" => json!(matching::normalize_identity(text("kind"), text("raw"))),
            "signature" => json!(matching::candidate_signature(
                text("kind"),
                &serde_json::from_value::<Vec<String>>(case["ids"].clone()).unwrap()
            )),
            "parse" => json!(notes_format::parse_people_note(text("content"))),
            "format" => json!(notes_format::format_people_note(
                &serde_json::from_value(case["note"].clone()).unwrap()
            )),
            "replace" => json!(notes_format::replace_moss_managed_section(
                text("body"),
                text("managed")
            )),
            "match" => json!(matching::match_result(case["signals"].as_array().unwrap()).unwrap()),
            _ => panic!("Unknown fixture operation"),
        };
        assert!(
            equal_json(&actual, &case["expected"]),
            "TypeScript parity vector {index}: {case}\nactual: {actual}"
        );
    }
}

// JSON has one number kind. serde_json distinguishes integer 1 from float 1.0 internally.
fn equal_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| equal_json(a, b)))
        }
        _ => a == b,
    }
}
