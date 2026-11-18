//! Runs the Rust approval policy over the shared cases. Usage: route-parity cases.json
use moss_agents::approvals::{family_allows_auto_run, resolve_policy, CallFacts, FamilyFacts, Policy, ToolFacts};
use serde_json::Value;

fn main() {
    let path = std::env::args().nth(1).expect("cases.json");
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let out: Vec<Value> = cases
        .iter()
        .map(|c| {
            let mut t = c["tool"].clone();
            let family: Option<Option<FamilyFacts>> = match &t["family"] {
                Value::Null => None,
                Value::String(_) => Some(None),
                f => Some(Some(serde_json::from_value(f.clone()).unwrap())),
            };
            t["family"] = Value::Null;
            let mut tool: ToolFacts = serde_json::from_value(t).unwrap();
            tool.family = family;
            let call: CallFacts = serde_json::from_value(c["call"].clone()).unwrap();
            let p = match resolve_policy(&tool, &call, call.sorted_safe, call.tainted) {
                Policy::Run => "run",
                Policy::Confirm => "confirm",
            };
            serde_json::json!([p, family_allows_auto_run(&tool, call.per_call_resolved)])
        })
        .collect();
    println!("{}", serde_json::to_string(&out).unwrap());
}
