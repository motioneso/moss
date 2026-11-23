//! Chat-only cards. The host validates arguments and binds approval to the exact parameters.
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

fn bad() -> Error {
    Error::public("invalid_finance_chat_action", "Invalid Finance chat action. Check the tool arguments and read the current revision before trying again.")
}

/// Chat schemas use a bounded list where the original Finance UI accepts category-keyed maps.
pub fn adapt_parameters(tool: &str, mut parameters: Value) -> Result<Value> {
    if !matches!(tool, "finance.flex.preview" | "finance.flex.configure") {
        return Ok(parameters);
    }
    if let Some(rows) = parameters["distribution"].as_array() {
        let mut amounts = serde_json::Map::new();
        if rows.len() > 100 {
            return Err(bad());
        }
        for row in rows {
            let object = row.as_object().ok_or_else(bad)?;
            let category = row["categoryId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(bad)?;
            let amount = row["amountCents"]
                .as_i64()
                .filter(|n| (0..=crate::input::MAX_SAFE).contains(n))
                .ok_or_else(bad)?;
            if object.len() != 2 || amounts.insert(category.into(), json!(amount)).is_some() {
                return Err(bad());
            }
        }
        parameters["distribution"] = Value::Object(amounts);
    }
    Ok(parameters)
}

fn shown(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn value_as_rows<'a>(value: &'a Value, schema: &Value) -> Option<&'a Vec<Value>> {
    (schema["items"]["type"] == "object")
        .then(|| value.as_array())
        .flatten()
        .filter(|rows| !rows.is_empty())
}
fn add_field(fields: &mut Vec<Value>, label: &str, value: String) -> Result<()> {
    if label.len() > 120 {
        return Err(bad());
    }
    fields.push(json!({"label":label,"value":value}));
    Ok(())
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
            let rows = matches!(
                name,
                "finance.transactions.bulk-categorize"
                    | "finance.transactions.bulk-confirm"
                    | "finance.import.apply"
            )
            .then(|| value_as_rows(parameters.get(key).unwrap(), property))
            .flatten();
            if let Some(rows) = rows {
                for (index, row) in rows.iter().enumerate() {
                    for (child, child_schema) in property["items"]["properties"]
                        .as_object()
                        .ok_or_else(bad)?
                    {
                        if let Some(child_value) = row.get(child) {
                            let child_label =
                                child_schema["description"].as_str().ok_or_else(bad)?;
                            add_field(
                                &mut fields,
                                &format!("Row {}: {}", index + 1, child_label),
                                shown(child_value),
                            )?;
                        }
                    }
                }
            } else {
                add_field(&mut fields, label, value)?;
            }
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
    let batch = matches!(
        name,
        "finance.transactions.bulk-categorize"
            | "finance.transactions.bulk-confirm"
            | "finance.transactions.review-apply"
            | "finance.import.apply"
    );
    Ok(json!({"fields":fields,"batch":batch}))
}
