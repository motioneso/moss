//! Code-built cards and completed-write fields for Goals chat tools.
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

const FIELDS: &[(&str, &str)] = &[
    ("title", "Title"),
    ("desiredOutcome", "Desired outcome"),
    ("status", "Status"),
    ("priority", "Priority"),
    ("reviewCadence", "Review frequency"),
    ("targetAt", "Target date"),
    ("evidenceKind", "Evidence type"),
    ("sourceKind", "Source type"),
    ("sourceRef", "Source reference"),
    ("sourceLabel", "Source label"),
    ("summary", "Summary"),
    ("occurredAt", "Occurred at"),
];
pub fn before<H: Host + ?Sized>(host: &H, p: &Value) -> Result<Value> {
    let Some(id) = p["goalId"].as_str() else {
        return Ok(Value::Null);
    };
    let req = crate::tools::request("GET", "/goals/:id", &json!({"goalId":id}));
    let response = crate::goals::get(host, &req)?;
    if response.status != 200 {
        return Ok(Value::Null);
    }
    Ok(response.body)
}
pub fn prepare<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let tool = input["tool"]
        .as_str()
        .ok_or_else(|| Error::new("Invalid Goals action"))?;
    let p = &input["parameters"];
    if !["goals.create", "goals.update", "goals.addEvidence"].contains(&tool)
        || !crate::tools::valid(tool, p)
    {
        return Err(Error::new("Invalid Goals action"));
    }
    let current = before(host, p)?;
    if tool != "goals.create" && current.is_null() {
        return Err(Error::new("Goal not found"));
    }
    let target = if tool == "goals.create" {
        json!("Your goals")
    } else {
        current["title"].clone()
    };
    let fields: Vec<_> = FIELDS
        .iter()
        .filter_map(|(key, label)| p.get(*key).map(|v| json!({"label":label,"value":shown(v)})))
        .collect();
    Ok(json!({"target":target,"fields":fields}))
}
fn shown(value: &Value) -> String {
    match value {
        Value::Null => "None".into(),
        Value::String(s) => s.clone(),
        _ => value.to_string(),
    }
}
pub fn completed(p: &Value, before: &Value, after: &Value) -> Vec<Value> {
    let receipt = |value: &Value| {
        let text = shown(value);
        if text.len() <= 8192 {
            return text;
        }
        let end = text
            .char_indices()
            .map(|(i, _)| i)
            .take_while(|i| *i <= 8100)
            .last()
            .unwrap_or(0);
        format!("{}… [truncated]", &text[..end])
    };
    let mut fields: Vec<Value> = FIELDS.iter().filter_map(|(key, label)| p.get(*key).map(|value| {
        json!({"label":label,"before":receipt(&before[*key]),"after":receipt(after.get(*key).unwrap_or(value))})
    })).collect();
    if fields.is_empty() {
        fields.push(json!({"label":"Updated at","before":shown(&before["updatedAt"]),"after":shown(&after["updatedAt"])}));
    }
    fields
}
