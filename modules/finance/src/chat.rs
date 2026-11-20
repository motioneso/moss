//! Chat-only cards. The host validates arguments and binds approval to the exact parameters.
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

fn bad() -> Error {
    Error::new("Invalid Finance chat action")
}

pub fn prepare<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let manifest: Value = serde_json::from_str(include_str!("../moss.module.json"))?;
    let name = input["tool"].as_str().ok_or_else(bad)?;
    let tool = manifest["tools"].get(name).ok_or_else(bad)?;
    if tool["risk"] == "read" {
        return Err(bad());
    }
    let parameters = input["parameters"].as_object().ok_or_else(bad)?;
    let schema = &tool["inputSchema"];
    let properties = schema["properties"].as_object().ok_or_else(bad)?;
    if parameters.keys().any(|key| !properties.contains_key(key))
        || schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|key| !parameters.contains_key(key.as_str().unwrap_or("")))
    {
        return Err(bad());
    }
    let mut fields = Vec::new();
    // Only code-owned schema descriptions become labels. Values remain labelled data.
    for (key, property) in properties {
        if let Some(value) = parameters.get(key) {
            let label = property["description"].as_str().ok_or_else(bad)?;
            let value = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            if label.len() > 120 || value.len() > 4096 {
                return Err(bad());
            }
            fields.push(json!({"label":label,"value":value}));
        }
    }
    if name == "finance.target.remove" {
        let month = parameters["month"].as_str().ok_or_else(bad)?;
        let category = parameters["categoryId"].as_str().ok_or_else(bad)?;
        let book = crate::budget::load(host)?;
        let target = crate::targets::for_month(&book, month)
            .into_iter()
            .find(|t| t.category == category);
        let current = target.map(|t| {
            json!({"categoryId":t.category,"effectiveMonth":t.month,"kind":t.kind,
            "amountCents":t.amount,"dueDate":t.due,"weekday":t.weekday})
        });
        fields.insert(0, json!({"label":"Current target","value":current.map_or("None".into(), |v| v.to_string())}));
        fields.push(json!({"label":"Effect","value":"Remove this target from the selected month onward. Earlier history and assigned money remain."}));
    }
    Ok(json!({"fields":fields}))
}
