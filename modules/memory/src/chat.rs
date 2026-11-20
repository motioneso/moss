//! Chat adapters keep proposed values in labelled fields and reuse the saved forget target.
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub fn prepare(host: &impl Host, input: &Value) -> Result<Value, String> {
    match input["tool"].as_str() {
        Some("memory.forget") => {
            crate::lifecycle::prepare_json(host, "memory.forget", &input["parameters"].to_string())
        }
        Some("memory.remember") => {
            let p = &input["parameters"];
            crate::graph::validate_remember(p).map_err(|e| e.message)?;
            Ok(json!({"target":"Your memory","fields": fields(p)}))
        }
        _ => Err("Unknown Memory action".into()),
    }
}

pub fn fields(p: &Value) -> Vec<Value> {
    let mut fields = Vec::new();
    for (key, label) in [
        ("subjectEntityId", "Subject reference"),
        ("predicate", "Relationship"),
        ("objectText", "Fact"),
        ("objectEntityId", "Object reference"),
        ("confidence", "Confidence"),
        ("importance", "Importance"),
        ("provenance", "How learned"),
        ("pinned", "Always relevant"),
    ] {
        if let Some(value) = p.get(key) {
            fields.push(json!({"label":label,"value":shown(value)}));
        }
    }
    for (key, label) in [
        ("sourceKind", "Source type"),
        ("sourceRef", "Source reference"),
        ("sourceLabel", "Source label"),
        ("excerpt", "Source excerpt"),
    ] {
        if let Some(value) = p["source"].get(key) {
            fields.push(json!({"label":label,"value":shown(value)}));
        }
    }
    fields
}
fn shown(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_forget_keeps_the_saved_memory_version() {
        let mut host = crate::testing::Fake::new();
        host.target = json!({"target":{"label":"You prefer tea","version":"saved-version"}});
        let p = json!({"factId":"11111111-1111-4111-8111-111111111111"});
        let card = prepare(&host, &json!({"tool":"memory.forget","parameters":p})).unwrap();
        assert_eq!(
            card,
            crate::lifecycle::prepare_json(&host, "memory.forget", &p.to_string()).unwrap()
        );
        assert_eq!(card["version"], "saved-version");
    }
    #[test]
    fn remember_card_includes_the_source_and_fact() {
        let p = json!({"predicate":"prefers","objectText":"tea","source":{"sourceKind":"chat","sourceRef":"example","excerpt":"I prefer tea"}});
        let card = prepare(
            &crate::testing::Fake::new(),
            &json!({"tool":"memory.remember","parameters":p}),
        )
        .unwrap();
        assert_eq!(card["target"], "Your memory");
        assert!(card["fields"]
            .as_array()
            .unwrap()
            .contains(&json!({"label":"Fact","value":"tea"})));
        assert!(card["fields"]
            .as_array()
            .unwrap()
            .contains(&json!({"label":"Source excerpt","value":"I prefer tea"})));
    }
}
